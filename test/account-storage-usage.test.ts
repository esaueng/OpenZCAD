import { describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { toUserId } from '@openzcad/shared';
import { d1Database, migratedDatabase } from './d1-sqlite';

const OWNER = 'user_owner';
const CREATED = '2026-01-01T00:00:00.000Z';

describe('account storage usage', () => {
  it('reports project storage as the quota measures it: inline bytes, stored R2 objects and assets', async () => {
    const sqlite = migratedDatabase();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, created_at) VALUES (?, 'owner@example.com', ?)`
      )
      .run(OWNER, CREATED);
    const project = sqlite.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at,
         document_bytes, document_object_id)
       VALUES (?, ?, ?, '{}', ?, ?, ?)`
    );
    const revision = sqlite.prepare(
      `INSERT INTO revisions (id, project_id, reason, document_json, created_at,
         document_bytes, document_object_id)
       VALUES (?, ?, 'Saved', '{}', ?, ?, ?)`
    );
    const object = sqlite.prepare(
      `INSERT INTO project_document_objects
         (id, project_id, object_key, checksum_sha256, logical_bytes,
          stored_bytes, content_encoding, state, created_at)
       VALUES (?, ?, ?, 'sha', ?, ?, 'gzip', 'committed', ?)`
    );
    // One project held inline in D1, one moved to R2 (compressed).
    project.run('p_inline', OWNER, 'Inline', CREATED, 1_000, null);
    revision.run('r_inline', 'p_inline', CREATED, 300, null);
    project.run('p_r2', OWNER, 'Stored', CREATED, 5_000, null);
    object.run('o_head', 'p_r2', 'o_head', 5_000, 700, CREATED);
    sqlite
      .prepare(
        "UPDATE projects SET document_object_id = 'o_head' WHERE id = 'p_r2'"
      )
      .run();
    object.run('o_rev', 'p_r2', 'o_rev', 4_000, 400, CREATED);
    revision.run('r_r2', 'p_r2', CREATED, 4_000, 'o_rev');
    sqlite
      .prepare(
        `INSERT INTO project_storage_assets
           (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
            stored_bytes, content_encoding, created_at)
         VALUES ('a1', 'p_r2', 'step-source', 'a1', 'a1', 900, 250, 'gzip', ?)`
      )
      .run(CREATED);
    // Another account's storage counts for nobody here.
    sqlite
      .prepare(
        `INSERT INTO users (id, email, created_at) VALUES ('user_other', NULL, ?)`
      )
      .run(CREATED);
    project.run('p_other', 'user_other', 'Other', CREATED, 9_999, null);

    const usage = await new D1R2PersistenceService({
      DB: d1Database(sqlite)
    }).getStorageUsage(toUserId(OWNER));

    expect(usage).toMatchObject({
      projectCount: 2,
      // Logical sizes, for the erasure preview.
      documentBytes: 6_000,
      revisionBytes: 4_300,
      revisionCount: 2,
      // Inline 1,000 + 300; R2 objects 700 + 400; asset 250.
      projectStorageBytes: 2_650,
      trashedProjectCount: 0,
      // One bucket: project storage plus files (none here).
      storageBytes: 2_650,
      storageLimitBytes: 1024 ** 3
    });
    expect(usage.entitlements?.storageLimitBytes).toBe(1024 ** 3);
    expect(usage.entitlements?.projectStorageLimitBytes).toBe(1024 ** 3);
  });
});
