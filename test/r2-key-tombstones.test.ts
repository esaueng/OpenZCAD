import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  claimObjectKeysForDelete,
  R2_KEY_TOMBSTONE_TTL_MS
} from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const OWNER = toUserId('user_beta_dev');
const CREATED = '2026-11-13T00:00:00.000Z';
const STEP_TEXT = `ISO-10303-21;\n${'CLOSED_SHELL'.repeat(20_000)}\nEND-ISO-10303-21;`;

function database() {
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    OWNER,
    'dev@example.test',
    CREATED
  );
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES ('p1', ?, 'Project', '{}', ?)`
  ).run(OWNER, CREATED);
  return db;
}

function asset(
  db: ReturnType<typeof database>,
  id: string,
  key: string,
  checksum = id
) {
  db.prepare(
    `INSERT INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, created_at)
     VALUES (?, 'p1', 'step-source', ?, ?, 10, 10, 'gzip', ?)`
  ).run(id, key, checksum, CREATED);
}

function session(db: ReturnType<typeof database>, id: string, key: string) {
  db.prepare(
    `INSERT INTO upload_sessions
       (id, artifact_id, project_id, object_key, file_name, content_type,
        kind, metadata_json, expires_at, owner_user_id, reserved_bytes,
        reservation_state, upload_protocol_version)
     VALUES (?, ?, 'p1', ?, 'f.step', 'model/step', 'snapshot', '{}',
             '2099-01-01T00:00:00.000Z', ?, 0, 'open', 1)`
  ).run(id, `artifact_${id}`, key, OWNER);
}

describe('R2 key tombstones (migration 0050)', () => {
  it('claims a key only while no other row names it', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    asset(db, 'a_old', 'assets/k');
    // The cleanup removing a_old may claim its key...
    const mine = await claimObjectKeysForDelete(d1, ['assets/k'], {
      assets: ['a_old']
    });
    expect([...mine.keys]).toEqual(['assets/k']);
    await mine.release();
    // ...but not while another row names it.
    session(db, 's_new', 'assets/k');
    const blocked = await claimObjectKeysForDelete(d1, ['assets/k'], {
      assets: ['a_old']
    });
    expect([...blocked.keys]).toEqual([]);
    await blocked.release();
  });

  it('refuses every new row naming a key while it is claimed, and only then', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    const claim = await claimObjectKeysForDelete(d1, ['blobs/k', 'assets/k']);
    expect(claim.keys.size).toBe(2);
    expect(() => session(db, 's1', 'blobs/k')).toThrow('r2_key_deleting');
    expect(() => asset(db, 'a1', 'assets/k')).toThrow('r2_key_deleting');
    // A second deleter cannot claim a key already claimed.
    const second = await claimObjectKeysForDelete(d1, ['blobs/k']);
    expect(second.keys.size).toBe(0);
    await second.release();
    await claim.release();
    session(db, 's1', 'blobs/k');
    asset(db, 'a1', 'assets/k');
  });

  it('claims nothing once its fence no longer holds', async () => {
    const db = database();
    const claim = await claimObjectKeysForDelete(
      sqliteD1(db),
      ['assets/k'],
      {},
      { sql: 'EXISTS (SELECT 1 FROM projects WHERE id = ?)', binds: ['gone'] }
    );
    expect(claim.keys.size).toBe(0);
  });

  it('lets a claim that outlived its deleter go: it blocks nothing and can be taken again', async () => {
    const db = database();
    db.prepare(
      `INSERT INTO r2_key_tombstones (object_key, token, created_at)
       VALUES ('assets/k', 'dead', ?)`
    ).run(Date.now() - R2_KEY_TOMBSTONE_TTL_MS - 60_000);
    asset(db, 'a1', 'assets/other');
    session(db, 's1', 'assets/k');
    db.prepare('DELETE FROM upload_sessions').run();
    const claim = await claimObjectKeysForDelete(sqliteD1(db), ['assets/k']);
    expect([...claim.keys]).toEqual(['assets/k']);
    await claim.release();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM r2_key_tombstones').get()
    ).toEqual({ n: 0 });
  });
});

describe('a source asset whose object vanished before its row landed', () => {
  it('is stored again once the save commits', async () => {
    const db = database();
    const objects = new Map<string, ArrayBuffer>();
    let dropped: string | null = null;
    const bucket = {
      put: vi.fn(async (key: string, body: ArrayBuffer) => {
        // A cleanup deletes the content-addressed key right after this
        // write's put, under a claim it releases before the row lands.
        if (!dropped && key.includes('/assets/')) {
          dropped = key;
          return;
        }
        objects.set(key, body.slice(0));
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        return body
          ? { arrayBuffer: async () => body.slice(0), size: body.byteLength }
          : null;
      }),
      head: vi.fn(async (key: string) => {
        const body = objects.get(key);
        return body ? { size: body.byteLength } : null;
      }),
      delete: vi.fn(async (keys: string | string[]) => {
        for (const key of typeof keys === 'string' ? [keys] : keys)
          objects.delete(key);
      })
    };
    const env = {
      ENVIRONMENT: 'development' as const,
      AUTH_MODE: 'development' as const,
      DB: sqliteD1(db),
      PROJECT_STORAGE: bucket as unknown as R2Bucket,
      ARTIFACTS: {} as R2Bucket,
      PROJECT_ROOM: { getByName: vi.fn() }
    };
    const manager = new CommandManager(
      createProjectDocument('Split bracket', OWNER)
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Bracket STEP',
        artifactId: 'artifact_split_step',
        sourceName: 'bracket.step',
        stepText: STEP_TEXT
      })
    );
    const document: ProjectDocument = withoutDerivedProjection(
      manager.document
    );
    const split = await splitProjectStorageUpload(document);
    const created = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: document.name,
          initialDocument: split.document,
          storageAssets: split.storageAssets
        })
      }),
      env
    );
    expect(created.status).toBe(201);
    expect(dropped).not.toBeNull();
    const keys = (
      db.prepare('SELECT object_key FROM project_storage_assets').all() as {
        object_key: string;
      }[]
    ).map((row) => row.object_key);
    expect(keys).toContain(dropped);
    // The asset's row names it, and its bytes are there.
    for (const key of keys) expect(objects.has(key)).toBe(true);
  });
});
