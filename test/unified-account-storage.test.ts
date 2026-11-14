import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { describe, expect, it } from 'vitest';
import {
  accountEntitlements,
  D1R2PersistenceService,
  syncStoredAccountLimits
} from '@openzcad/cloudflare-adapters';
import {
  ArtifactQuotaError,
  prepareProjectStorageSnapshot,
  ProjectQuotaError,
  ProjectStorageCleanupPendingError
} from '@openzcad/persistence';
import { toUserId } from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const OWNER = 'user_owner';
const PROJECT = 'p_owner';
const CREATED = '2026-01-01T00:00:00.000Z';
const GIB = 1024 ** 3;

/** An account with one inline project and the given single limit. */
function account(limitBytes: number, email = 'owner@example.com') {
  const db = migratedDatabase();
  db.prepare(
    `INSERT INTO users (id, email, created_at, artifact_limit_bytes,
       project_storage_limit_bytes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(OWNER, email, CREATED, limitBytes, limitBytes);
  project(db, PROJECT, 100);
  return db;
}

function project(
  db: DatabaseSync,
  id: string,
  bytes: number,
  status = 'active'
) {
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at,
       document_bytes, status)
     VALUES (?, ?, ?, '{}', ?, ?, ?)`
  ).run(id, OWNER, id, CREATED, bytes, status);
}

function artifact(db: DatabaseSync, id: string, bytes: number) {
  db.prepare(
    `INSERT INTO artifacts
       (id, project_id, kind, name, object_key, content_type, bytes,
        metadata_json, created_at)
     VALUES (?, ?, 'snapshot', 'part.step', ?, 'model/step', ?, '{}', ?)`
  ).run(id, PROJECT, `artifacts/${id}`, bytes, CREATED);
}

function documentObject(db: DatabaseSync, id: string, bytes: number) {
  db.prepare(
    `INSERT INTO project_document_objects
       (id, project_id, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, state, created_at)
     VALUES (?, ?, ?, 'sha', ?, ?, 'gzip', 'committed', ?)`
  ).run(id, PROJECT, id, bytes, bytes, CREATED);
}

function asset(db: DatabaseSync, id: string, bytes: number) {
  db.prepare(
    `INSERT INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, created_at)
     VALUES (?, ?, 'step-source', ?, ?, ?, ?, 'gzip', ?)`
  ).run(id, PROJECT, id, id, bytes, bytes, CREATED);
}

function revision(db: DatabaseSync, id: string, bytes: number) {
  db.prepare(
    `INSERT INTO revisions (id, project_id, reason, document_json, created_at,
       document_bytes)
     VALUES (?, ?, 'Saved', '{}', ?, ?)`
  ).run(id, PROJECT, CREATED, bytes);
}

function uploadSession(db: DatabaseSync, id: string) {
  db.prepare(
    `INSERT INTO upload_sessions
       (id, artifact_id, project_id, object_key, file_name, content_type,
        kind, metadata_json, expires_at, owner_user_id, reserved_bytes,
        reservation_state, upload_protocol_version)
     VALUES (?, ?, ?, ?, 'part.step', 'model/step', 'snapshot', '{}',
       '2099-01-01T00:00:00.000Z', ?, 0, 'open', 1)`
  ).run(id, `artifact_${id}`, PROJECT, `uploads/${id}`, OWNER);
}

describe('one storage allowance per account (migration 0049)', () => {
  it('refuses a project save once files fill the combined bucket', () => {
    // 100 inline project bytes + 9,900 file bytes: exactly at the limit.
    const db = account(10_000);
    artifact(db, 'a_full', 9_900);

    // Every way a project grows is refused: the inline document...
    expect(() =>
      db
        .prepare('UPDATE projects SET document_bytes = 101 WHERE id = ?')
        .run(PROJECT)
    ).toThrow('project_account_document_quota');
    // ...a save state...
    expect(() => revision(db, 'r_new', 1)).toThrow(
      'project_account_document_quota'
    );
    // ...an R2 document object, a source asset...
    expect(() => documentObject(db, 'o_new', 1)).toThrow(
      'project_account_storage_quota'
    );
    expect(() => asset(db, 's_new', 1)).toThrow(
      'project_account_storage_quota'
    );
    // ...and a new project.
    expect(() => project(db, 'p_new', 1)).toThrow(
      'project_account_document_quota'
    );

    // Before 0049 each allowance was separate: the same project save fit
    // its own 10,000 bytes. Shrinking, or a write that grows nothing, passes.
    db.prepare('UPDATE projects SET document_bytes = 60 WHERE id = ?').run(
      PROJECT
    );
    db.prepare("UPDATE projects SET name = 'Renamed' WHERE id = ?").run(
      PROJECT
    );
    // The freed 40 bytes are room again.
    revision(db, 'r_fits', 40);
  });

  it('refuses a file upload and finalize once projects fill the combined bucket', () => {
    const db = account(10_000);
    db.prepare('UPDATE projects SET document_bytes = 6_000 WHERE id = ?').run(
      PROJECT
    );
    documentObject(db, 'o_head', 3_000);
    asset(db, 's_source', 1_000);

    // Opening an upload session is refused at the limit...
    expect(() => uploadSession(db, 'session_full')).toThrow(
      'artifact_account_quota'
    );
    // ...and so is finalizing a file.
    expect(() => artifact(db, 'a_over', 1)).toThrow('artifact_account_quota');

    // Below it, a file that fits the remainder lands and one byte more not.
    db.prepare('UPDATE projects SET document_bytes = 5_000 WHERE id = ?').run(
      PROJECT
    );
    uploadSession(db, 'session_room');
    artifact(db, 'a_fits', 1_000);
    expect(() => artifact(db, 'a_byte', 1)).toThrow('artifact_account_quota');
    expect(
      db
        .prepare(
          'SELECT finalized_bytes FROM artifact_account_usage WHERE owner_user_id = ?'
        )
        .get(OWNER)
    ).toEqual({ finalized_bytes: 1_000 });
  });

  it('keeps data already over the limit and refuses only growth', () => {
    // Stored before a downgrade: well over the new limit.
    const db = account(1_000_000);
    artifact(db, 'a_old', 900_000);
    documentObject(db, 'o_old', 90_000);
    db.prepare(
      'UPDATE users SET artifact_limit_bytes = 1_000, project_storage_limit_bytes = 1_000'
    ).run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({
      n: 1
    });
    db.prepare('UPDATE projects SET document_bytes = 50 WHERE id = ?').run(
      PROJECT
    );
    expect(() => artifact(db, 'a_more', 1)).toThrow('artifact_account_quota');
    expect(() => documentObject(db, 'o_more', 1)).toThrow(
      'project_account_storage_quota'
    );
    db.prepare("DELETE FROM artifacts WHERE id = 'a_old'").run();
  });

  it('gives Premium one 25 GiB bucket and Free one 1 GiB bucket', async () => {
    const env = { PREMIUM_USER_EMAILS: 'premium@example.com' };
    const premium = accountEntitlements(env, 'premium@example.com');
    const free = accountEntitlements(env, 'free@example.com');
    expect(premium.storageLimitBytes).toBe(25 * GIB);
    expect(free.storageLimitBytes).toBe(GIB);

    for (const [email, limit] of [
      ['premium@example.com', 25 * GIB],
      ['free@example.com', GIB]
    ] as const) {
      // Stored under the old policy: 2 GiB each, two buckets.
      const db = account(2 * GIB, email);
      db.prepare(
        'UPDATE users SET artifact_limit_bytes = ?, project_storage_limit_bytes = ?'
      ).run(2 * GIB, 3 * GIB);
      await syncStoredAccountLimits(env, sqliteD1(db));
      expect(
        db
          .prepare(
            'SELECT artifact_limit_bytes, project_storage_limit_bytes FROM users WHERE id = ?'
          )
          .get(OWNER)
      ).toEqual({
        artifact_limit_bytes: limit,
        project_storage_limit_bytes: limit
      });

      // 60% of the bucket in files and 40% in projects fills it; the two
      // are not separate allowances (Free is 1 GiB in total, not 2).
      const files = Math.floor(limit * 0.6);
      artifact(db, 'a_six', files);
      documentObject(db, 'o_four', limit - files - 100);
      expect(() => documentObject(db, 'o_one', 1)).toThrow(
        'project_account_storage_quota'
      );
      expect(() => artifact(db, 'a_one', 1)).toThrow('artifact_account_quota');
    }
  });

  it('gives a row with diverged limits the larger as its one limit', () => {
    const dir = new URL('../apps/web/migrations/', import.meta.url);
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const db = new DatabaseSync(':memory:');
    for (const file of files.filter((name) => name < '0049'))
      db.exec(readFileSync(new URL(file, dir), 'utf8'));
    const insert = db.prepare(
      `INSERT INTO users (id, email, created_at, artifact_limit_bytes,
         project_storage_limit_bytes)
       VALUES (?, NULL, ?, ?, ?)`
    );
    insert.run('u_files', CREATED, 2 * GIB, GIB);
    insert.run('u_projects', CREATED, GIB, 3 * GIB);
    for (const file of files.filter((name) => name >= '0049'))
      db.exec(readFileSync(new URL(file, dir), 'utf8'));
    expect(
      db
        .prepare(
          'SELECT id, artifact_limit_bytes AS files, project_storage_limit_bytes AS projects FROM users ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 'u_files', files: 2 * GIB, projects: 2 * GIB },
      { id: 'u_projects', files: 3 * GIB, projects: 3 * GIB }
    ]);
  });
});

describe('migration staging is bounded by projected storage (migration 0049)', () => {
  function migration(
    db: DatabaseSync,
    projectId: string,
    direction: 'encrypt' | 'decrypt',
    state = 'staging'
  ) {
    db.prepare(
      `INSERT INTO e2ee_project_migrations
         (project_id, direction, state, owner_user_id, source_version,
          started_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(projectId, direction, state, OWNER, CREATED, CREATED);
  }
  function blob(
    db: DatabaseSync,
    projectId: string,
    id: string,
    bytes: number
  ) {
    db.prepare(
      `INSERT INTO e2ee_content_blobs
         (project_id, blob_id, kind, object_key, ciphertext_bytes, created_at)
       VALUES (?, ?, 'import-source', ?, ?, ?)`
    ).run(projectId, id.padEnd(32, '0'), `blobs/${id}`, bytes, CREATED);
  }
  const counted = (db: DatabaseSync) =>
    (
      db
        .prepare(
          `SELECT COALESCE((SELECT bytes FROM account_project_storage
                            WHERE user_id = ?1), 0)
                + COALESCE((SELECT finalized_bytes + reserved_bytes
                            FROM artifact_account_usage
                            WHERE owner_user_id = ?1), 0) AS bytes`
        )
        .get(OWNER) as { bytes: number }
    ).bytes;

  it('admits an encrypt staging up to its credit at a full account, then refuses every further staged byte', () => {
    const db = account(10_000);
    // 3,000 plaintext bytes in the project being encrypted, 7,000 of files
    // elsewhere: the account is full.
    db.prepare('UPDATE projects SET document_bytes = 3_000 WHERE id = ?').run(
      PROJECT
    );
    project(db, 'p_other', 0);
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_other', 'p_other', 'snapshot', 'other.step', 'other',
               'model/step', 7_000, '{}', ?)`
    ).run(CREATED);
    expect(counted(db)).toBe(10_000);
    migration(db, PROJECT, 'encrypt');

    // The cutover's purge would free the 3,000 plaintext bytes: that much
    // ciphertext may be staged, no more.
    blob(db, PROJECT, 'b1', 2_000);
    blob(db, PROJECT, 'b2', 1_000);
    expect(() => blob(db, PROJECT, 'b3', 1)).toThrow('artifact_account_quota');
    expect(() =>
      db
        .prepare(
          `INSERT INTO e2ee_project_versions
             (project_id, document_version, version_hash, key_epoch, prefix,
              signature, signer_device_id, envelope_inline, envelope_bytes,
              wrapped_version_key, created_at)
           VALUES (?, 1, ?, 0, ?, ?, 'device', 'x', 1, ?, ?)`
        )
        .run(
          PROJECT,
          'a'.repeat(64),
          'p'.repeat(11),
          's'.repeat(98),
          'w'.repeat(55),
          CREATED
        )
    ).toThrow('project_account_storage_quota');
    // Staged bytes still count toward nothing counted.
    expect(counted(db)).toBe(10_000);

    // An abandoned staging is credited nothing until its cleanup drops it.
    db.prepare(
      "UPDATE e2ee_project_migrations SET state = 'abandoned' WHERE project_id = ?"
    ).run(PROJECT);
    expect(() => blob(db, PROJECT, 'b4', 1)).toThrow('artifact_account_quota');
  });

  it('lets an account over its allowance stage a migration that shrinks it, in either direction', () => {
    // Usage 10,000 against an allowance of 5,000: 3,000 in the project being
    // migrated, 7,000 of files elsewhere. A replacement of 100 bytes lands
    // the account at 7,100, still over, but smaller: staging is admitted up
    // to the 3,000 the cutover frees, and refused past it.
    const encrypt = account(10_000);
    encrypt
      .prepare('UPDATE projects SET document_bytes = 3_000 WHERE id = ?')
      .run(PROJECT);
    project(encrypt, 'p_other', 0);
    encrypt
      .prepare(
        `INSERT INTO artifacts
           (id, project_id, kind, name, object_key, content_type, bytes,
            metadata_json, created_at)
         VALUES ('a_other', 'p_other', 'snapshot', 'other.step', 'other',
                 'model/step', 7_000, '{}', ?)`
      )
      .run(CREATED);
    encrypt
      .prepare(
        'UPDATE users SET artifact_limit_bytes = 5_000, project_storage_limit_bytes = 5_000'
      )
      .run();
    migration(encrypt, PROJECT, 'encrypt');
    blob(encrypt, PROJECT, 'small', 100);
    blob(encrypt, PROJECT, 'rest', 2_900);
    expect(() => blob(encrypt, PROJECT, 'more', 1)).toThrow(
      'artifact_account_quota'
    );
    expect(counted(encrypt)).toBe(10_000);

    const decrypt = account(10_000);
    decrypt
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json, updated_at,
           document_bytes, storage_format)
         VALUES ('p_enc', ?, 'Encrypted', '{}', ?, 0, 2)`
      )
      .run(OWNER, CREATED);
    blob(decrypt, 'p_enc', 'enc', 3_000);
    decrypt
      .prepare(
        `INSERT INTO artifacts
           (id, project_id, kind, name, object_key, content_type, bytes,
            metadata_json, created_at)
         VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step',
                 6_900, '{}', ?)`
      )
      .run(PROJECT, CREATED);
    expect(counted(decrypt)).toBe(10_000);
    decrypt
      .prepare(
        'UPDATE users SET artifact_limit_bytes = 5_000, project_storage_limit_bytes = 5_000'
      )
      .run();
    migration(decrypt, 'p_enc', 'decrypt');
    const object = (id: string, bytes: number) =>
      decrypt
        .prepare(
          `INSERT INTO project_document_objects
             (id, project_id, object_key, checksum_sha256, logical_bytes,
              stored_bytes, content_encoding, state, created_at)
           VALUES (?, 'p_enc', ?, 'sha', ?, ?, 'gzip', 'committed', ?)`
        )
        .run(id, id, bytes, bytes, CREATED);
    object('o_small', 100);
    object('o_rest', 2_900);
    expect(() => object('o_more', 1)).toThrow('project_account_storage_quota');
    expect(counted(decrypt)).toBe(10_000);
  });

  it('bounds a decrypt staging of plaintext files and documents by the ciphertext it replaces', () => {
    const db = account(10_000);
    // An encrypted project holding 5,000 bytes of blobs; the account full.
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at,
         document_bytes, storage_format)
       VALUES ('p_enc', ?, 'Encrypted', '{}', ?, 0, 2)`
    ).run(OWNER, CREATED);
    blob(db, 'p_enc', 'enc', 5_000);
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step',
               4_900, '{}', ?)`
    ).run(PROJECT, CREATED);
    expect(counted(db)).toBe(10_000);
    migration(db, 'p_enc', 'decrypt');
    const staged = (id: string, bytes: number) =>
      db
        .prepare(
          `INSERT INTO artifacts
             (id, project_id, kind, name, object_key, content_type, bytes,
              metadata_json, created_at)
           VALUES (?, 'p_enc', 'snapshot', 'staged.step', ?, 'model/step',
                   ?, '{}', ?)`
        )
        .run(id, `staged/${id}`, bytes, CREATED);

    // A staging session is admitted while there is projected room.
    db.prepare(
      `INSERT INTO upload_sessions
         (id, artifact_id, project_id, object_key, file_name, content_type,
          kind, metadata_json, expires_at, owner_user_id, reserved_bytes,
          reservation_state, upload_protocol_version)
       VALUES ('s_stage', 'artifact_s_stage', 'p_enc', 'uploads/s_stage',
               'f.step', 'model/step', 'snapshot', '{}',
               '2099-01-01T00:00:00.000Z', ?, 0, 'open', 1)`
    ).run(OWNER);
    staged('f1', 3_000);
    db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES ('o_staged', 'p_enc', 'o_staged', 'sha', 2_000, 2_000, 'gzip',
               'committed', ?)`
    ).run(CREATED);
    expect(() => staged('f2', 1)).toThrow('artifact_account_quota');
    expect(() =>
      db
        .prepare(
          `INSERT INTO project_storage_assets
             (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
              stored_bytes, content_encoding, created_at)
           VALUES ('s_staged', 'p_enc', 'step-source', 's_staged', 's', 1, 1,
                   'gzip', ?)`
        )
        .run(CREATED)
    ).toThrow('project_account_storage_quota');
    // At the projected limit, a further staging session is refused too.
    expect(() =>
      db
        .prepare(
          `INSERT INTO upload_sessions
             (id, artifact_id, project_id, object_key, file_name,
              content_type, kind, metadata_json, expires_at, owner_user_id,
              reserved_bytes, reservation_state, upload_protocol_version)
           VALUES ('s_more', 'artifact_s_more', 'p_enc', 'uploads/s_more',
                   'f.step', 'model/step', 'snapshot', '{}',
                   '2099-01-01T00:00:00.000Z', ?, 0, 'open', 1)`
        )
        .run(OWNER)
    ).toThrow('artifact_account_quota');
    expect(counted(db)).toBe(10_000);
  });
});

describe('a head-replacing save releases the head it replaces (migration 0049)', () => {
  function bucket(failDelete: boolean | number = false) {
    let failures = typeof failDelete === 'number' ? failDelete : 0;
    const objects = new Map<string, Uint8Array<ArrayBuffer>>();
    return {
      objects,
      bucket: {
        put: async (key: string, body: BodyInit) => {
          objects.set(
            key,
            new Uint8Array(await new Response(body).arrayBuffer())
          );
          return null;
        },
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes
            ? {
                size: bytes.length,
                body: new Response(bytes).body,
                arrayBuffer: async () => bytes.slice().buffer
              }
            : null;
        },
        head: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { size: bytes.length } : null;
        },
        delete: async (key: string | string[]) => {
          if (failDelete === true || failures > 0) {
            failures -= 1;
            throw new Error('injected R2 delete failure');
          }
          for (const item of typeof key === 'string' ? [key] : key)
            objects.delete(item);
        }
      } as unknown as R2Bucket
    };
  }

  it('saves a shrinking autosave at a full account, and refuses a growing one', async () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
    ).run(OWNER, CREATED);
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_STORAGE: bucket().bucket
    });
    const longName = `Long name ${'7dc6b0f86bd2'.repeat(6)}`;
    const { document } = await service.createProject(toUserId(OWNER), {
      name: longName
    });
    const stored = () =>
      (
        db
          .prepare(
            `SELECT COALESCE((SELECT bytes FROM account_project_storage
                              WHERE user_id = ?1), 0)
                  + COALESCE((SELECT finalized_bytes + reserved_bytes
                              FROM artifact_account_usage
                              WHERE owner_user_id = ?1), 0) AS bytes`
          )
          .get(OWNER) as { bytes: number }
      ).bytes;
    const limit = (
      db
        .prepare(
          'SELECT project_storage_limit_bytes AS bytes FROM users WHERE id = ?'
        )
        .get(OWNER) as { bytes: number }
    ).bytes;
    // Files fill the account to exactly its allowance.
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step', ?,
               '{}', ?)`
    ).run(document.projectId, limit - stored(), CREATED);
    expect(stored()).toBe(limit);

    // The same project under a short name: a smaller head replacing the
    // larger one. It does not grow the account, so it is saved.
    const shortened = JSON.parse(
      JSON.stringify(document).replaceAll(longName, 'x')
    ) as typeof document;
    const saved = await service.saveDocument(toUserId(OWNER), {
      projectId: document.projectId,
      expectedVersion: document.version,
      document: { ...shortened, version: document.version + 1 }
    });
    expect(saved.version).toBe(document.version + 1);
    expect(stored()).toBeLessThanOrEqual(limit);

    // Growing it back past the allowance is refused.
    await expect(
      service.saveDocument(toUserId(OWNER), {
        projectId: document.projectId,
        expectedVersion: document.version + 1,
        document: {
          ...(JSON.parse(
            JSON.stringify(shortened).replaceAll(
              '"x"',
              JSON.stringify(`${longName}${'y'.repeat(4000)}`)
            )
          ) as typeof document),
          version: document.version + 2
        }
      })
    ).rejects.toMatchObject({ kind: 'storage' });
  });

  it('credits a replaced head once: a second pending write claiming it is not credited', () => {
    const db = account(10_000);
    db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES ('o_head', ?, 'o_head', 'sha', 900, 900, 'gzip', 'committed', ?)`
    ).run(PROJECT, CREATED);
    db.prepare(
      "UPDATE projects SET document_object_id = 'o_head', document_bytes = 0 WHERE id = ?"
    ).run(PROJECT);
    project(db, 'p_other', 0);
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', 'p_other', 'snapshot', 'fill.step', 'fill',
               'model/step', 9_100, '{}', ?)`
    ).run(CREATED);
    const pending = (id: string, bytes: number, supersedes: string | null) =>
      db
        .prepare(
          `INSERT INTO project_document_objects
             (id, project_id, object_key, checksum_sha256, logical_bytes,
              stored_bytes, content_encoding, state, created_at,
              supersedes_object_id)
           VALUES (?, ?, ?, 'sha', ?, ?, 'gzip', 'pending', ?, ?)`
        )
        .run(id, PROJECT, id, bytes, bytes, CREATED, supersedes);
    // Full: 900 + 9,100. A smaller replacement of the head is admitted...
    pending('o_next', 800, 'o_head');
    // ...but a second one claiming the same head is not credited.
    expect(() => pending('o_again', 800, 'o_head')).toThrow(
      'project_account_storage_quota'
    );
    // Nor is a write that names no head (a checkpoint, say).
    expect(() => pending('o_checkpoint', 1, null)).toThrow(
      'project_account_storage_quota'
    );
  });

  it('keeps at most one replacement credited while a replaced head waits to be pruned', () => {
    const db = account(10_000);
    db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES ('o_head', ?, 'o_head', 'sha', 900, 900, 'gzip', 'committed', ?)`
    ).run(PROJECT, CREATED);
    db.prepare(
      "UPDATE projects SET document_object_id = 'o_head', document_bytes = 0 WHERE id = ?"
    ).run(PROJECT);
    project(db, 'p_other', 0);
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', 'p_other', 'snapshot', 'fill.step', 'fill',
               'model/step', 9_100, '{}', ?)`
    ).run(CREATED);
    // Each save inserts a same-size replacement, moves the head to it and
    // commits it, and its pruning of the old head fails.
    const replace = (id: string, supersedes: string) => {
      db.prepare(
        `INSERT INTO project_document_objects
           (id, project_id, object_key, checksum_sha256, logical_bytes,
            stored_bytes, content_encoding, state, created_at,
            supersedes_object_id)
         VALUES (?, ?, ?, 'sha', 900, 900, 'gzip', 'pending', ?, ?)`
      ).run(id, PROJECT, id, CREATED, supersedes);
      db.prepare('UPDATE projects SET document_object_id = ? WHERE id = ?').run(
        id,
        PROJECT
      );
      db.prepare(
        "UPDATE project_document_objects SET state = 'committed' WHERE id = ?"
      ).run(id);
    };
    replace('o_second', 'o_head');
    // o_head was not pruned: the next replacement is charged in full.
    expect(() => replace('o_third', 'o_second')).toThrow(
      'project_account_storage_quota'
    );
    // Once the old head is pruned, replacements are credited again.
    db.prepare(
      "DELETE FROM project_document_objects WHERE id = 'o_head'"
    ).run();
    replace('o_third', 'o_second');
  });

  it('shares one replaced head\u2019s credit across every asset of its save', () => {
    // Full: a 6,223-byte head and files filling the rest.
    const db = account(100_000);
    db.prepare('UPDATE projects SET document_bytes = 0 WHERE id = ?').run(
      PROJECT
    );
    db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES ('o_head', ?, 'o_head', 'sha', 6_223, 6_223, 'gzip',
               'committed', ?)`
    ).run(PROJECT, CREATED);
    db.prepare(
      "UPDATE projects SET document_object_id = 'o_head' WHERE id = ?"
    ).run(PROJECT);
    project(db, 'p_other', 0);
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', 'p_other', 'snapshot', 'fill.step', 'fill',
               'model/step', ?, '{}', ?)`
    ).run(100_000 - 6_223, CREATED);
    // The save, as its batch runs: a 1,816-byte head replacing it...
    db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at,
          supersedes_object_id)
       VALUES ('o_cur', ?, 'o_cur', 'sha', 1_816, 1_816, 'gzip', 'pending', ?,
               'o_head')`
    ).run(PROJECT, CREATED);
    db.prepare(
      "UPDATE projects SET document_object_id = 'o_cur' WHERE id = ?"
    ).run(PROJECT);
    db.prepare(
      "UPDATE project_document_objects SET state = 'committed' WHERE id = 'o_cur'"
    ).run();
    const saveAsset = (id: string, bytes: number) =>
      db
        .prepare(
          `INSERT INTO project_storage_assets
             (id, project_id, kind, object_key, checksum_sha256,
              logical_bytes, stored_bytes, content_encoding, created_at,
              added_by_object_id)
           VALUES (?, ?, 'step-source', ?, ?, ?, ?, 'gzip', ?, 'o_cur')`
        )
        .run(id, PROJECT, id, id, bytes, bytes, CREATED);
    // ...and two source assets. The first fits in what the save releases;
    // the second would leave the account 1,942 bytes over once the old
    // head is pruned, so it is refused.
    saveAsset('a_first', 3_175);
    expect(() => saveAsset('a_second', 3_174)).toThrow(
      'project_account_storage_quota'
    );
  });

  it('recovers from a failed prune: the next shrinking save at the allowance prunes, then is credited', async () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
    ).run(OWNER, CREATED);
    // The first save's prune fails once; R2 then recovers.
    const r2 = bucket(1);
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_STORAGE: r2.bucket
    });
    let name = randomBytes(5_000).toString('hex');
    let { document } = await service.createProject(toUserId(OWNER), { name });
    const stored = () =>
      (
        db
          .prepare(
            `SELECT COALESCE((SELECT bytes FROM account_project_storage
                              WHERE user_id = ?1), 0)
                  + COALESCE((SELECT finalized_bytes + reserved_bytes
                              FROM artifact_account_usage
                              WHERE owner_user_id = ?1), 0) AS bytes`
          )
          .get(OWNER) as { bytes: number }
      ).bytes;
    const limit = (
      db
        .prepare(
          'SELECT project_storage_limit_bytes AS bytes FROM users WHERE id = ?'
        )
        .get(OWNER) as { bytes: number }
    ).bytes;
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step', ?,
               '{}', ?)`
    ).run(document.projectId, limit - stored(), CREATED);
    const objects = () =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM project_document_objects')
          .get() as { n: number }
      ).n;
    const shrink = async () => {
      const nextName = name.slice(0, -1_000);
      const next = {
        ...(JSON.parse(
          JSON.stringify(document).replaceAll(name, nextName)
        ) as typeof document),
        version: document.version + 1
      };
      await service.saveDocument(toUserId(OWNER), {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: next
      });
      document = next;
      name = nextName;
    };
    await shrink();
    // Its old head could not be pruned.
    expect(objects()).toBe(2);
    // The next shrinking save prunes it first, is credited, and saves.
    await shrink();
    expect(objects()).toBe(1);
    expect(stored()).toBeLessThanOrEqual(limit);
  });

  it('bounds each prune, so a backlog of stale objects cannot stop a save, and keeps its progress', async () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
    ).run(OWNER, CREATED);
    const r2 = bucket();
    let deletes = 0;
    const removed = new Set<string>();
    const counting = {
      ...(r2.bucket as unknown as Record<string, unknown>),
      delete: async (key: string | string[]) => {
        deletes += 1;
        // Every other delete fails: its row must survive for a later prune.
        if (deletes % 2 === 0) throw new Error('injected R2 delete failure');
        for (const item of typeof key === 'string' ? [key] : key)
          removed.add(item);
        await r2.bucket.delete(key);
      }
    } as unknown as R2Bucket;
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_STORAGE: counting
    });
    const name = 'bounded prune';
    const { document } = await service.createProject(toUserId(OWNER), {
      name
    });
    // A backlog of replaced heads left by failed deletes.
    const insert = db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES (?, ?, ?, 'x', 1, 1, 'identity', 'committed', ?)`
    );
    for (let index = 0; index < 500; index += 1) {
      insert.run(
        `stale_${index}`,
        document.projectId,
        `stale/${index}`,
        CREATED
      );
    }
    const stale = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM project_document_objects
             WHERE id LIKE 'stale\\_%' ESCAPE '\\'`
          )
          .get() as { n: number }
      ).n;
    deletes = 0;
    removed.clear();
    const next = {
      ...(JSON.parse(
        JSON.stringify(document).replaceAll(name, 'bounded prune 2')
      ) as typeof document),
      version: document.version + 1
    };
    await service.saveDocument(toUserId(OWNER), {
      projectId: document.projectId,
      expectedVersion: document.version,
      document: next
    });
    // The save committed despite the backlog...
    const head = db
      .prepare('SELECT document_version AS version FROM projects WHERE id = ?')
      .get(document.projectId) as { version: number };
    expect(head.version).toBe(next.version);
    // ...issuing a bounded number of deletes (pre-save 8, post-save 32),
    expect(deletes).toBeLessThanOrEqual(8 + 32);
    // ...dropping exactly the rows whose R2 delete succeeded.
    const removedStale = [...removed].filter((key) =>
      key.startsWith('stale/')
    ).length;
    expect(removedStale).toBeGreaterThan(0);
    expect(stale()).toBe(500 - removedStale);
  });

  it('answers a save held back by a draining backlog retryably, and saves once it drains', async () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
    ).run(OWNER, CREATED);
    const r2 = bucket();
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_STORAGE: r2.bucket
    });
    let name = randomBytes(5_000).toString('hex');
    let { document } = await service.createProject(toUserId(OWNER), { name });
    // 25 replaced heads left behind by earlier failed deletes.
    const insert = db.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES (?, ?, ?, 'x', 1, 1, 'identity', 'committed', ?)`
    );
    for (let index = 0; index < 25; index += 1) {
      insert.run(
        `stale_${index}`,
        document.projectId,
        `stale/${index}`,
        CREATED
      );
    }
    const stored = () =>
      (
        db
          .prepare(
            `SELECT COALESCE((SELECT bytes FROM account_project_storage
                              WHERE user_id = ?1), 0)
                  + COALESCE((SELECT finalized_bytes + reserved_bytes
                              FROM artifact_account_usage
                              WHERE owner_user_id = ?1), 0) AS bytes`
          )
          .get(OWNER) as { bytes: number }
      ).bytes;
    const limit = (
      db
        .prepare(
          'SELECT project_storage_limit_bytes AS bytes FROM users WHERE id = ?'
        )
        .get(OWNER) as { bytes: number }
    ).bytes;
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step', ?,
               '{}', ?)`
    ).run(document.projectId, limit - stored(), CREATED);
    const stale = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM project_document_objects
             WHERE id LIKE 'stale\\_%' ESCAPE '\\'`
          )
          .get() as { n: number }
      ).n;
    const nextName = name.slice(0, -1_000);
    const next = {
      ...(JSON.parse(
        JSON.stringify(document).replaceAll(name, nextName)
      ) as typeof document),
      version: document.version + 1
    };
    const shrink = () =>
      service.saveDocument(toUserId(OWNER), {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: next
      });
    // Each attempt drains a bounded share and answers retryably, not with
    // a final quota refusal the client would halt on.
    for (const left of [17, 9, 1]) {
      await expect(shrink()).rejects.toBeInstanceOf(
        ProjectStorageCleanupPendingError
      );
      expect(stale()).toBe(left);
    }
    // The last attempt drains the rest, is credited, and saves.
    await shrink();
    expect(stale()).toBe(0);
    const head = db
      .prepare('SELECT document_version AS version FROM projects WHERE id = ?')
      .get(document.projectId) as { version: number };
    expect(head.version).toBe(next.version);
    expect(stored()).toBeLessThanOrEqual(limit);
    document = next;
    name = nextName;
    // With nothing left to prune, genuine growth is still a final refusal.
    const grown = {
      ...(JSON.parse(
        JSON.stringify(document).replaceAll(
          name,
          name + randomBytes(4_000).toString('hex')
        )
      ) as typeof document),
      version: document.version + 1
    };
    await expect(
      service.saveDocument(toUserId(OWNER), {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: grown
      })
    ).rejects.toBeInstanceOf(ProjectQuotaError);
  });

  it('refuses further credited saves once pruning fails, so storage stays within one replacement', async () => {
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
    ).run(OWNER, CREATED);
    const r2 = bucket(true);
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_STORAGE: r2.bucket
    });
    let name = randomBytes(5_000).toString('hex');
    let { document } = await service.createProject(toUserId(OWNER), { name });
    const used = () =>
      (
        db
          .prepare(
            `SELECT COALESCE((SELECT bytes FROM account_project_storage
                              WHERE user_id = ?1), 0)
                  + COALESCE((SELECT finalized_bytes + reserved_bytes
                              FROM artifact_account_usage
                              WHERE owner_user_id = ?1), 0) AS bytes`
          )
          .get(OWNER) as { bytes: number }
      ).bytes;
    const limit = (
      db
        .prepare(
          'SELECT project_storage_limit_bytes AS bytes FROM users WHERE id = ?'
        )
        .get(OWNER) as { bytes: number }
    ).bytes;
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step', ?,
               '{}', ?)`
    ).run(document.projectId, limit - used(), CREATED);
    const outcomes: string[] = [];
    const usage: number[] = [used()];
    for (let save = 0; save < 5; save++) {
      const nextName = name.slice(0, -1_000);
      const next = {
        ...(JSON.parse(
          JSON.stringify(document).replaceAll(name, nextName)
        ) as typeof document),
        version: document.version + 1
      };
      try {
        await service.saveDocument(toUserId(OWNER), {
          projectId: document.projectId,
          expectedVersion: document.version,
          document: next
        });
        document = next;
        name = nextName;
        outcomes.push('saved');
      } catch (error) {
        outcomes.push((error as { kind?: string }).kind ?? 'error');
      }
      usage.push(used());
    }
    // The first shrinking save is credited; its replaced head cannot be
    // pruned, so every later one is charged in full and refused.
    expect(outcomes).toEqual([
      'saved',
      'storage',
      'storage',
      'storage',
      'storage'
    ]);
    // At most one replacement's bytes stay outstanding.
    expect(new Set(usage.slice(1)).size).toBe(1);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM project_document_objects')
          .get() as { n: number }
      ).n
    ).toBe(2);
  });

  it('judges a save that adds a source asset on its net change', async () => {
    const run = async (stepText: string) => {
      const db = migratedDatabase();
      db.prepare(
        `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
      ).run(OWNER, CREATED);
      const service = new D1R2PersistenceService({
        DB: sqliteD1(db),
        PROJECT_STORAGE: bucket().bucket
      });
      const name = randomBytes(5_000).toString('hex');
      const { document } = await service.createProject(toUserId(OWNER), {
        name
      });
      const old = await prepareProjectStorageSnapshot(document);
      const manager = new CommandManager(
        JSON.parse(
          JSON.stringify(document).replaceAll(name, 'x')
        ) as typeof document
      );
      manager.execute(
        commandFactories.importStep({
          name: 'source',
          artifactId: 'artifact_source',
          sourceName: 'source.step',
          stepText
        })
      );
      const next = manager.document;
      const prepared = await prepareProjectStorageSnapshot(next);
      const limit = (
        db
          .prepare(
            'SELECT project_storage_limit_bytes AS bytes FROM users WHERE id = ?'
          )
          .get(OWNER) as { bytes: number }
      ).bytes;
      // Files fill the account to exactly its allowance.
      db.prepare(
        `INSERT INTO artifacts
           (id, project_id, kind, name, object_key, content_type, bytes,
            metadata_json, created_at)
         VALUES ('a_fill', ?, 'snapshot', 'fill.step', 'fill', 'model/step',
                 ?, '{}', ?)`
      ).run(document.projectId, limit - old.storedBytes, CREATED);
      const added =
        prepared.storedBytes +
        prepared.assets.reduce((total, asset) => total + asset.storedBytes, 0);
      expect(prepared.assets.length).toBeGreaterThan(0);
      return {
        old: old.storedBytes,
        added,
        save: () =>
          service.saveDocument(toUserId(OWNER), {
            projectId: document.projectId,
            expectedVersion: document.version,
            document: next
          })
      };
    };
    // A 6 KB head replaced by a 1.4 KB head and a small STEP source: the
    // save shrinks the account, so it is saved at the allowance.
    const shrinking = await run(
      `ISO-10303-21;\n${'CARTESIAN_POINT'.repeat(100)}\nEND-ISO-10303-21;`
    );
    expect(shrinking.added).toBeLessThan(shrinking.old);
    await expect(shrinking.save()).resolves.toBeTruthy();
    // A STEP source larger than the head it replaces grows it: refused.
    const growing = await run(
      `ISO-10303-21;\n${randomBytes(20_000).toString('hex')}\nEND-ISO-10303-21;`
    );
    expect(growing.added).toBeGreaterThan(growing.old);
    await expect(growing.save()).rejects.toMatchObject({ kind: 'storage' });
  });
});

describe('account storage usage (one bucket)', () => {
  it('reports combined usage against the one limit, trashed projects counted apart', async () => {
    const db = account(10 * GIB);
    project(db, 'p_archived', 200, 'archived');
    project(db, 'p_trash_1', 300, 'deleted');
    project(db, 'p_trash_2', 400, 'deleted');
    artifact(db, 'a_file', 5_000);

    const usage = await new D1R2PersistenceService({
      DB: sqliteD1(db)
    }).getStorageUsage(toUserId(OWNER));

    expect(usage).toMatchObject({
      // The library's count: active and archived, not the recycle bin.
      projectCount: 2,
      trashedProjectCount: 2,
      // Trashed projects are still stored, so their bytes count.
      projectStorageBytes: 100 + 200 + 300 + 400,
      artifactBytes: 5_000,
      storageBytes: 1_000 + 5_000,
      storageLimitBytes: GIB,
      artifactLimitBytes: GIB,
      entitlements: {
        storageLimitBytes: GIB,
        projectStorageLimitBytes: GIB,
        artifactLimitBytes: GIB
      }
    });
  });

  it('counts an upload in flight in the reported total, as the quota does', async () => {
    // Project storage 600 and a 400-byte multipart reservation fill a
    // 1,000-byte allowance: the meter must say so, not 600 of 1,000.
    const db = account(1_000);
    db.prepare('UPDATE projects SET document_bytes = 600 WHERE id = ?').run(
      PROJECT
    );
    uploadSession(db, 'session_inflight');
    db.prepare(
      `UPDATE upload_sessions
       SET reservation_state = 'uploading', multipart_upload_id = 'mp_1'
       WHERE id = 'session_inflight'`
    ).run();
    db.prepare(
      `INSERT INTO artifact_upload_parts
         (upload_session_id, part_number, bytes, reservation_token)
       VALUES ('session_inflight', 1, 400, 'token')`
    ).run();

    const usage = await new D1R2PersistenceService({
      DB: sqliteD1(db)
    }).getStorageUsage(toUserId(OWNER));
    expect(usage).toMatchObject({
      projectStorageBytes: 600,
      artifactBytes: 0,
      artifactReservedBytes: 400,
      storageBytes: 1_000
    });
    // And a one-byte save is refused, as the report says it will be.
    expect(() =>
      db
        .prepare('UPDATE projects SET document_bytes = 601 WHERE id = ?')
        .run(PROJECT)
    ).toThrow('project_account_document_quota');
  });

  it('measures inline project storage through the owner, not every account', async () => {
    // Inline rows of other accounts share the document-object indexes' NULL
    // key; the owner's sums must walk the owner's projects instead.
    const db = account(10 * GIB);
    const statements: string[] = [];
    await new D1R2PersistenceService({
      DB: sqliteD1(db, { onStatement: (sql) => statements.push(sql) })
    }).getStorageUsage(toUserId(OWNER));
    const measure = statements.find((sql) =>
      sql.includes('revisions.document_object_id IS NULL')
    );
    expect(measure).toBeDefined();
    const plans = [
      measure!,
      'SELECT bytes FROM account_project_storage WHERE user_id = ?1'
    ].map((sql) =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(OWNER) as {
          detail: string;
        }[]
      )
        .map((row) => row.detail)
        .join(' | ')
    );
    for (const plan of plans) {
      expect(plan).not.toMatch(/idx_revisions_document_object/);
      expect(plan).not.toMatch(/idx_projects_document_object/);
      expect(plan).toMatch(
        /SEARCH \w+ USING (COVERING )?INDEX idx_projects_user/
      );
    }
  });

  it('names the one allowance in its refusals', () => {
    expect(new ArtifactQuotaError(GIB).message).toBe(
      'Account storage limit reached.'
    );
  });
});
