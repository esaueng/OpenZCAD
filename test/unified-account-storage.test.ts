import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  accountEntitlements,
  D1R2PersistenceService,
  syncStoredAccountLimits
} from '@openzcad/cloudflare-adapters';
import { ArtifactQuotaError } from '@openzcad/persistence';
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
