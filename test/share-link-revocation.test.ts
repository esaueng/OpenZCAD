import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

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
  db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(
    status,
    PROJECT
  );
}

beforeEach(() => {
  db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    OWNER,
    'share-owner@example.com',
    '2026-01-01T00:00:00.000Z'
  );

  const document = createProjectDocument('Bracket', toUserId(OWNER));
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at, status)
     VALUES (?, ?, 'Bracket', ?, '2026-01-01T00:00:00.000Z', 'active')`
  ).run(PROJECT, OWNER, JSON.stringify({ ...document, projectId: PROJECT }));
  db.prepare(
    `INSERT INTO project_share_links
       (id, project_id, mode, token_hash, created_by_user_id, created_at, revoked_at)
     VALUES ('share_one', ?, 'tweak', ?, ?, ?, NULL)`
  ).run(PROJECT, TOKEN_HASH, OWNER, Math.floor(Date.now() / 1000));
  db.prepare(
    `INSERT INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes, stored_bytes, content_encoding, created_at)
     VALUES ('asset_one', ?, 'step-source', 'key/one', 'sha', 10, 10, 'gzip', '2026-01-01T00:00:00.000Z')`
  ).run(PROJECT);

  service = new D1R2PersistenceService({ DB: sqliteD1(db) });
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
      `UPDATE project_share_links SET revoked_at = created_at + 1 WHERE token_hash = ?`
    ).run(TOKEN_HASH);
    await expect(
      service.loadSharedProjectByTokenHash(TOKEN_HASH)
    ).resolves.toBeNull();
    await expect(
      service.loadSharedProjectByTokenHash('hash_never_minted')
    ).resolves.toBeNull();
  });
});
