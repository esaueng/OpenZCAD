import { describe, expect, it } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import {
  normalizeShareLinkLabel,
  PROJECT_SHARE_LINK_LABEL_MAX_LENGTH,
  toUserId,
  type CreateProjectResponse,
  type CreateProjectShareLinkResponse,
  type ProjectShareLinkSummary
} from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const routeEnv = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_SHARING_ENABLED: 'true'
};

function ownerRequest(
  owner: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: { 'x-openzcad-development-user': owner }
    }),
    routeEnv
  );
}

describe('normalizeShareLinkLabel', () => {
  it('collapses whitespace, trims, and treats blank as unnamed', () => {
    expect(normalizeShareLinkLabel('  Supplier \n\t review ')).toBe(
      'Supplier review'
    );
    expect(normalizeShareLinkLabel('')).toBeNull();
    expect(normalizeShareLinkLabel('   ')).toBeNull();
  });

  it('counts code points, matching SQLite length()', () => {
    // 60 astral characters are 120 UTF-16 units but 60 code points.
    const astral = '📐'.repeat(PROJECT_SHARE_LINK_LABEL_MAX_LENGTH);
    expect(normalizeShareLinkLabel(astral)).toBe(astral);
    expect(() =>
      normalizeShareLinkLabel(
        'x'.repeat(PROJECT_SHARE_LINK_LABEL_MAX_LENGTH + 1)
      )
    ).toThrow(RangeError);
  });

  it('rejects control characters that whitespace collapsing keeps', () => {
    expect(() => normalizeShareLinkLabel('bad\u0000name')).toThrow(RangeError);
    expect(() => normalizeShareLinkLabel('bad\u007fname')).toThrow(RangeError);
  });
});

describe('share link labels (D1)', () => {
  function database() {
    const document = createProjectDocument(
      'Bracket',
      toUserId('user_label_d1_owner')
    );
    const db = migratedDatabase();
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`
    ).run(
      document.ownerUserId,
      'owner@example.com',
      '2026-01-01T00:00:00.000Z'
    );
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      document.projectId,
      document.ownerUserId,
      document.name,
      JSON.stringify(document),
      '2026-01-01T00:00:00.000Z'
    );
    return { db, document };
  }

  it('stores, renames, clears on revoke, and keeps labels from visitors', async () => {
    const { db, document } = database();
    const owner = document.ownerUserId;
    const service = new D1R2PersistenceService({ DB: sqliteD1(db) });
    const now = Math.floor(Date.now() / 1000);

    const created = await service.createProjectShareLink(
      owner,
      document.projectId,
      {
        shareLinkId: 'share_label',
        mode: 'tweak',
        tokenHash: 'hash_label',
        createdAt: now,
        label: 'Supplier review'
      }
    );
    expect(created.label).toBe('Supplier review');
    await expect(
      service.listProjectShareLinks(owner, document.projectId)
    ).resolves.toMatchObject([
      { shareLinkId: 'share_label', label: 'Supplier review' }
    ]);

    await expect(
      service.renameProjectShareLink(
        owner,
        document.projectId,
        'share_label',
        'Forum post'
      )
    ).resolves.toMatchObject({
      shareLinkId: 'share_label',
      label: 'Forum post'
    });
    await expect(
      service.renameProjectShareLink(
        owner,
        document.projectId,
        'share_label',
        null
      )
    ).resolves.toMatchObject({ label: null });
    await service.renameProjectShareLink(
      owner,
      document.projectId,
      'share_label',
      'Forum post'
    );

    const shared = await service.loadSharedProjectByTokenHash('hash_label');
    expect(JSON.stringify(shared)).not.toContain('Forum post');

    await service.revokeProjectShareLink(
      owner,
      document.projectId,
      'share_label',
      now + 1
    );
    expect(
      db
        .prepare(`SELECT label FROM project_share_links WHERE id = ?`)
        .get('share_label')
    ).toEqual({ label: null });
    await expect(
      service.renameProjectShareLink(
        owner,
        document.projectId,
        'share_label',
        'Again'
      )
    ).rejects.toMatchObject({ code: 'SHARE_LINK_NOT_FOUND' });
  });

  it('refuses a rename by anyone but the owner', async () => {
    const { db, document } = database();
    const service = new D1R2PersistenceService({ DB: sqliteD1(db) });
    await service.createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_owner_only',
        mode: 'tweak',
        tokenHash: 'hash_owner_only',
        createdAt: Math.floor(Date.now() / 1000)
      }
    );
    await expect(
      service.renameProjectShareLink(
        toUserId('user_label_stranger'),
        document.projectId,
        'share_owner_only',
        'Mine now'
      )
    ).rejects.toThrow();
    await expect(
      service.listProjectShareLinks(document.ownerUserId, document.projectId)
    ).resolves.toMatchObject([{ label: null }]);
  });

  it('holds the 60-character limit in the schema too', () => {
    const { db, document } = database();
    expect(() =>
      db
        .prepare(
          `INSERT INTO project_share_links
             (id, project_id, mode, token_hash, created_by_user_id, created_at, label)
           VALUES ('share_long', ?, 'tweak', 'hash_long', ?, 0, ?)`
        )
        .run(document.projectId, document.ownerUserId, 'x'.repeat(61))
    ).toThrow(/CHECK/);
  });
});

describe('share link labels before migration 0046', () => {
  it('creates, lists and revokes links unnamed, and refuses only a rename', async () => {
    const document = createProjectDocument(
      'Bracket',
      toUserId('user_label_unmigrated')
    );
    const db = migratedDatabase();
    // As a live database looks if 0046 is delayed: the column is not there.
    db.exec('ALTER TABLE project_share_links DROP COLUMN label');
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`
    ).run(
      document.ownerUserId,
      'owner@example.com',
      '2026-01-01T00:00:00.000Z'
    );
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      document.projectId,
      document.ownerUserId,
      document.name,
      JSON.stringify(document),
      '2026-01-01T00:00:00.000Z'
    );
    const owner = document.ownerUserId;
    const service = new D1R2PersistenceService({ DB: sqliteD1(db) });
    const now = Math.floor(Date.now() / 1000);

    await expect(
      service.createProjectShareLink(owner, document.projectId, {
        shareLinkId: 'share_unmigrated',
        mode: 'tweak',
        tokenHash: 'hash_unmigrated',
        createdAt: now,
        label: 'Supplier review'
      })
    ).resolves.toMatchObject({ label: null });
    await expect(
      service.listProjectShareLinks(owner, document.projectId)
    ).resolves.toMatchObject([
      { shareLinkId: 'share_unmigrated', label: null }
    ]);
    await expect(
      service.renameProjectShareLink(
        owner,
        document.projectId,
        'share_unmigrated',
        'Forum post'
      )
    ).rejects.toMatchObject({ code: 'SHARE_LINK_LABEL_UNAVAILABLE' });
    await service.revokeProjectShareLink(
      owner,
      document.projectId,
      'share_unmigrated',
      now + 1
    );
    await expect(
      service.listProjectShareLinks(owner, document.projectId)
    ).resolves.toEqual([]);
  });
});

describe('share link labels (routes)', () => {
  async function projectWithLink(owner: string, label?: unknown) {
    const created = await ownerRequest(owner, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Labelled' })
    });
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as CreateProjectResponse;
    const minted = await ownerRequest(
      owner,
      `/api/projects/${document.projectId}/share-links`,
      {
        method: 'POST',
        body: JSON.stringify(
          label === undefined ? { mode: 'tweak' } : { mode: 'tweak', label }
        )
      }
    );
    return { projectId: document.projectId, minted };
  }

  it('names a link at creation and renames it with PATCH', async () => {
    const owner = 'user_label_route_owner';
    const { projectId, minted } = await projectWithLink(
      owner,
      '  Supplier   review '
    );
    expect(minted.status).toBe(201);
    const { shareLink, token } =
      (await minted.json()) as CreateProjectShareLinkResponse;
    expect(shareLink.label).toBe('Supplier review');

    const renamed = await ownerRequest(
      owner,
      `/api/projects/${projectId}/share-links/${shareLink.shareLinkId}`,
      { method: 'PATCH', body: JSON.stringify({ label: 'Forum post' }) }
    );
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      shareLink: { shareLinkId: shareLink.shareLinkId, label: 'Forum post' }
    });

    const listed = await ownerRequest(
      owner,
      `/api/projects/${projectId}/share-links`
    );
    const { shareLinks } = (await listed.json()) as {
      shareLinks: ProjectShareLinkSummary[];
    };
    expect(shareLinks).toMatchObject([{ label: 'Forum post' }]);

    // Visitors never see the owner's label.
    const visitor = await worker.fetch(
      new Request(`https://example.com/api/share/${token}`),
      routeEnv
    );
    expect(visitor.status).toBe(200);
    expect(await visitor.text()).not.toContain('Forum post');

    const cleared = await ownerRequest(
      owner,
      `/api/projects/${projectId}/share-links/${shareLink.shareLinkId}`,
      { method: 'PATCH', body: JSON.stringify({ label: '  ' }) }
    );
    await expect(cleared.json()).resolves.toMatchObject({
      shareLink: { label: null }
    });
  });

  it('rejects invalid labels and non-owners', async () => {
    const owner = 'user_label_route_invalid';
    const tooLong = await projectWithLink(owner, 'x'.repeat(61));
    expect(tooLong.minted.status).toBe(400);
    await expect(tooLong.minted.json()).resolves.toMatchObject({
      code: 'SHARE_LINK_LABEL_INVALID'
    });
    const notText = await projectWithLink(owner, 42);
    expect(notText.minted.status).toBe(400);

    const { projectId, minted } = await projectWithLink(owner);
    const { shareLink } =
      (await minted.json()) as CreateProjectShareLinkResponse;
    expect(shareLink.label).toBeNull();
    const path = `/api/projects/${projectId}/share-links/${shareLink.shareLinkId}`;

    const missing = await ownerRequest(owner, path, {
      method: 'PATCH',
      body: JSON.stringify({})
    });
    expect(missing.status).toBe(400);
    const control = await ownerRequest(owner, path, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'a\u0000b' })
    });
    expect(control.status).toBe(400);

    const outsider = await ownerRequest('user_label_route_outsider', path, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Mine now' })
    });
    expect(outsider.status).toBe(404);
  });
});
