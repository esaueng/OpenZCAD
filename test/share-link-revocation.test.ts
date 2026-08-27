import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/**
 * A D1 stand-in backed by real SQLite.
 *
 * The existing share-link D1 coverage asserts on query *text* — that the string
 * contains `l.revoked_at IS NULL` and so on. That shape can be satisfied by SQL
 * that does not run, or that runs and filters nothing, so it cannot tell a
 * working predicate from a broken one. These are authorization predicates on an
 * unauthenticated route, so they are executed here instead: same statements,
 * real `json_valid`/`json_extract`, real joins.
 */
function d1(db: DatabaseSync): D1Database {
  const normalize = (row: unknown) =>
    row === undefined ? null : (row as Record<string, unknown>);
  return {
    prepare(query: string) {
      const statement = {
        bind(...bindings: unknown[]) {
          return {
            async first() {
              return normalize(db.prepare(query).get(...(bindings as never[])));
            },
            async all() {
              return {
                results: db.prepare(query).all(...(bindings as never[]))
              };
            },
            async run() {
              db.prepare(query).run(...(bindings as never[]));
              return { meta: { changes: 0 } };
            }
          };
        },
        async first() {
          return normalize(db.prepare(query).get());
        },
        async run() {
          db.prepare(query).run();
          return { meta: { changes: 0 } };
        }
      };
      return statement as unknown as D1PreparedStatement;
    }
  } as unknown as D1Database;
}

const OWNER = 'user_share_owner';
const PROJECT = 'proj_shared';
const TOKEN_HASH = 'hash_live_link';

let db: DatabaseSync;
let service: D1R2PersistenceService;

function setSharingEnabled(enabled: boolean): void {
  db.prepare(
    `INSERT INTO user_settings (user_id, settings_json, revision, updated_at)
     VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z')
     ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json`
  ).run(OWNER, JSON.stringify({ collaboration: { enabled } }));
}

function setProjectStatus(status: string): void {
  db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(status, PROJECT);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      document_object_id TEXT
    );
    CREATE TABLE project_share_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_storage_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      object_key TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      logical_bytes INTEGER NOT NULL,
      content_encoding TEXT NOT NULL
    );
  `);

  const document = createProjectDocument('Bracket', toUserId(OWNER));
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at, status)
     VALUES (?, ?, 'Bracket', ?, '2026-01-01T00:00:00.000Z', 'active')`
  ).run(PROJECT, OWNER, JSON.stringify({ ...document, projectId: PROJECT }));
  db.prepare(
    `INSERT INTO project_share_links
       (id, project_id, mode, token_hash, created_by_user_id, created_at, revoked_at)
     VALUES ('share_one', ?, 'tweak', ?, ?, 1, NULL)`
  ).run(PROJECT, TOKEN_HASH, OWNER);
  db.prepare(
    `INSERT INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes, content_encoding)
     VALUES ('asset_one', ?, 'import-source', 'key/one', 'sha', 10, 'gzip')`
  ).run(PROJECT);

  service = new D1R2PersistenceService({ DB: d1(db) });
});

/**
 * The owner has two controls that read as "stop sharing this", and neither
 * reached the anonymous read. Turning "Project sharing" off cut every signed-in
 * member off at once and refused new links, while every link already pasted
 * into a supplier thread kept serving the whole document — and because the same
 * setting hides the Share button and force-closes the dialog, the owner could
 * no longer see or revoke what was still being served. Trashing the project did
 * nothing either.
 */
describe('an anonymous share link after the owner withdraws it', () => {
  it('serves the document while sharing is on and the project is active', async () => {
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toMatchObject({ projectId: PROJECT, mode: 'tweak' });
  });

  it('stops serving once the owner turns project sharing off', async () => {
    setSharingEnabled(false);
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toBeNull();
  });

  it('stops serving once the project is moved to trash', async () => {
    setProjectStatus('deleted');
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toBeNull();
  });

  it('withdraws the project assets too, not just the document', async () => {
    // A side asset is the imported source of the same model. Refusing the
    // document while still serving its STEP would withdraw nothing.
    setSharingEnabled(false);
    await expect(
      service.loadSharedProjectAsset(TOKEN_HASH, 'asset_one')
    ).resolves.toBeNull();

    setSharingEnabled(true);
    setProjectStatus('deleted');
    await expect(
      service.loadSharedProjectAsset(TOKEN_HASH, 'asset_one')
    ).resolves.toBeNull();
  });

  it('comes back when sharing is re-enabled or the project is restored', async () => {
    // A predicate, not a revocation: the owner turning the switch back on gets
    // the links they minted, rather than silently losing them.
    setSharingEnabled(false);
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toBeNull();

    setSharingEnabled(true);
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.not.toBeNull();

    setProjectStatus('deleted');
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toBeNull();
    setProjectStatus('active');
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.not.toBeNull();
  });

  it('keeps serving an archived project, which is a shelf rather than a withdrawal', async () => {
    setProjectStatus('archived');
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.not.toBeNull();
  });

  it('defaults to enabled when the owner has no settings row or invalid JSON', async () => {
    // Most accounts have never opened the settings page. Absent or unparseable
    // settings must not read as "sharing off" and break every existing link.
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.not.toBeNull();

    db.prepare(
      `INSERT INTO user_settings (user_id, settings_json, revision, updated_at)
       VALUES (?, 'not json', 1, '2026-01-01T00:00:00.000Z')`
    ).run(OWNER);
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.not.toBeNull();
  });

  it('still refuses a revoked link and an unknown token', async () => {
    db.prepare(
      `UPDATE project_share_links SET revoked_at = 2 WHERE token_hash = ?`
    ).run(TOKEN_HASH);
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toBeNull();
    await expect(
      service.loadSharedProjectByTokenHash('hash_never_minted')
    ).resolves.toBeNull();
  });
});
