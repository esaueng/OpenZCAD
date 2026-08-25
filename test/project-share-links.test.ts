import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError
} from '@openzcad/persistence';
import {
  createShareLink,
  hashProjectInvitationToken,
  parseCreateShareLink,
  parseShareLinkToken
} from '../apps/web/worker/sharing';
import { toUserId, type CreateProjectResponse } from '@openzcad/shared';

const routeEnv = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_SHARING_ENABLED: 'true'
};

async function createProjectViaRoute(
  owner: string,
  name: string
): Promise<CreateProjectResponse> {
  const response = await worker.fetch(
    new Request('https://example.com/api/projects', {
      method: 'POST',
      headers: { 'x-openzcad-development-user': owner },
      body: JSON.stringify({ name })
    }),
    routeEnv
  );
  expect(response.status).toBe(201);
  return (await response.json()) as CreateProjectResponse;
}

describe('project share links (persistence)', () => {
  it('mints owner-only links, lists them without hashes, and revokes', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_share_owner');
    const stranger = toUserId('user_share_stranger');
    const project = await service.createProject(owner, { name: 'Shared' });
    const projectId = project.document.projectId;
    const now = 2_000_000_000;

    await expect(
      service.createProjectShareLink(stranger, projectId, {
        shareLinkId: 'share_denied',
        mode: 'tweak',
        tokenHash: 'hash_denied',
        createdAt: now
      })
    ).rejects.toThrow(ProjectNotFoundError);

    const created = await service.createProjectShareLink(owner, projectId, {
      shareLinkId: 'share_first',
      mode: 'tweak',
      tokenHash: 'hash_first',
      createdAt: now
    });
    expect(created).toEqual({
      shareLinkId: 'share_first',
      projectId,
      mode: 'tweak',
      createdAt: now,
      revokedAt: null
    });

    await expect(
      service.listProjectShareLinks(stranger, projectId)
    ).rejects.toThrow(ProjectNotFoundError);
    const listed = await service.listProjectShareLinks(owner, projectId);
    expect(listed).toEqual([created]);
    expect(JSON.stringify(listed)).not.toContain('hash_first');

    await expect(
      service.revokeProjectShareLink(stranger, projectId, 'share_first', now)
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      service.revokeProjectShareLink(owner, projectId, 'share_missing', now)
    ).rejects.toMatchObject({ code: 'SHARE_LINK_NOT_FOUND' });
    await service.revokeProjectShareLink(owner, projectId, 'share_first', now);
    await expect(
      service.revokeProjectShareLink(owner, projectId, 'share_first', now)
    ).rejects.toMatchObject({ code: 'SHARE_LINK_NOT_FOUND' });
    await expect(
      service.listProjectShareLinks(owner, projectId)
    ).resolves.toEqual([]);
  });

  it('loads a shared project by token hash until the link is revoked', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_share_loader');
    const project = await service.createProject(owner, { name: 'Loadable' });
    const projectId = project.document.projectId;
    const now = 2_000_000_000;
    await service.createProjectShareLink(owner, projectId, {
      shareLinkId: 'share_loadable',
      mode: 'tweak',
      tokenHash: 'hash_loadable',
      createdAt: now
    });

    const shared = await service.loadSharedProjectByTokenHash('hash_loadable');
    expect(shared).toMatchObject({
      projectId,
      name: 'Loadable',
      mode: 'tweak'
    });
    // The visitor rebuilds geometry locally; the stored projection stays home.
    expect(shared?.document.derived.bodyRepresentations).toEqual({});
    expect(shared?.document.derived.exportableBodyIds).toEqual([]);

    await expect(
      service.loadSharedProjectByTokenHash('hash_unknown')
    ).resolves.toBeNull();
    await service.revokeProjectShareLink(
      owner,
      projectId,
      'share_loadable',
      now + 1
    );
    await expect(
      service.loadSharedProjectByTokenHash('hash_loadable')
    ).resolves.toBeNull();
  });

  it('drops share links when their project is destroyed', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_share_destroy');
    const project = await service.createProject(owner, { name: 'Doomed' });
    const projectId = project.document.projectId;
    await service.createProjectShareLink(owner, projectId, {
      shareLinkId: 'share_doomed',
      mode: 'view',
      tokenHash: 'hash_doomed',
      createdAt: 2_000_000_000
    });

    await service.deleteProject(owner, projectId);
    await expect(
      service.loadSharedProjectByTokenHash('hash_doomed')
    ).resolves.toBeNull();
  });

  it('withdraws a link while the project sits in the trash', async () => {
    // Trashing a project reads as "stop sharing this" and did nothing to the
    // links; the D1 path had the same hole. Restoring brings them back, so
    // this is a predicate rather than a revocation.
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_share_trash');
    const project = await service.createProject(owner, { name: 'Trashed' });
    const projectId = project.document.projectId;
    await service.createProjectShareLink(owner, projectId, {
      shareLinkId: 'share_trash',
      mode: 'view',
      tokenHash: 'hash_trash',
      createdAt: 2_000_000_000
    });
    await expect(
      service.loadSharedProjectByTokenHash('hash_trash')
    ).resolves.not.toBeNull();

    await service.updateProject(owner, { projectId, status: 'deleted' });
    await expect(
      service.loadSharedProjectByTokenHash('hash_trash')
    ).resolves.toBeNull();

    await service.updateProject(owner, { projectId, status: 'active' });
    await expect(
      service.loadSharedProjectByTokenHash('hash_trash')
    ).resolves.not.toBeNull();

    // An archived project is shelved, not withdrawn.
    await service.updateProject(owner, { projectId, status: 'archived' });
    await expect(
      service.loadSharedProjectByTokenHash('hash_trash')
    ).resolves.not.toBeNull();
  });

  it('authorizes the D1 shared reads purely by unrevoked token hash', async () => {
    const statements: Array<{ query: string; bindings: unknown[] }> = [];
    const prepare = vi.fn((query: string) => ({
      bind: (...bindings: unknown[]) => {
        statements.push({ query, bindings });
        return {
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } })
        };
      }
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database
    });

    await expect(
      service.loadSharedProjectByTokenHash('hash_d1')
    ).resolves.toBeNull();
    await expect(
      service.loadSharedProjectAsset('hash_d1', 'asset_d1')
    ).resolves.toBeNull();

    const projectRead = statements.find((statement) =>
      statement.query.includes('FROM project_share_links l')
    );
    expect(projectRead?.query).toContain('l.token_hash = ?');
    expect(projectRead?.query).toContain('l.revoked_at IS NULL');
    expect(projectRead?.query).not.toContain('user_id = ?');
    const assetRead = statements.find((statement) =>
      statement.query.includes('FROM project_storage_assets a')
    );
    expect(assetRead?.query).toContain('l.revoked_at IS NULL');
    expect(assetRead?.query).toContain('a.id = ?');
    expect(assetRead?.bindings).toEqual(['hash_d1', 'asset_d1']);
  });
});

describe('project share links (worker helpers)', () => {
  it('mints a 256-bit token and persists only its hash', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_share_helper');
    const project = await service.createProject(owner, { name: 'Helper' });
    const now = 2_000_000_000;

    const created = await createShareLink(
      service,
      owner,
      project.document.projectId,
      { mode: 'tweak' },
      now
    );
    expect(created.token).toHaveLength(43);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.shareLink).toMatchObject({
      projectId: project.document.projectId,
      mode: 'tweak',
      createdAt: now,
      revokedAt: null
    });
    const links = await service.listProjectShareLinks(
      owner,
      project.document.projectId
    );
    expect(JSON.stringify(links)).not.toContain(created.token);
    await expect(
      service.loadSharedProjectByTokenHash(
        await hashProjectInvitationToken(created.token)
      )
    ).resolves.toMatchObject({ projectId: project.document.projectId });
  });

  it('rejects unknown modes and malformed tokens', () => {
    expect(() => parseCreateShareLink({ mode: 'edit' })).toThrow(
      'Share link mode must be tweak or view.'
    );
    expect(() => parseCreateShareLink(null)).toThrow(
      'Sharing request must be a JSON object.'
    );
    expect(parseCreateShareLink({ mode: 'view' })).toEqual({ mode: 'view' });
    expect(parseShareLinkToken('a'.repeat(43))).toBe('a'.repeat(43));
    expect(parseShareLinkToken('short')).toBeNull();
    expect(parseShareLinkToken(`${'a'.repeat(42)}!`)).toBeNull();
    expect(parseShareLinkToken('a'.repeat(129))).toBeNull();
  });
});

describe('project share links (worker routes)', () => {
  it('mints, lists, serves anonymously, and revokes into an opaque 404', async () => {
    const owner = toUserId('user_share_route_owner');
    const created = await createProjectViaRoute(owner, 'Share routes');
    const projectId = created.document.projectId;

    const minted = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/share-links`, {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({ mode: 'tweak' })
      }),
      routeEnv
    );
    expect(minted.status).toBe(201);
    const mintedPayload = (await minted.json()) as {
      shareLink: { shareLinkId: string; mode: string; revokedAt: null };
      token: string;
    };
    expect(mintedPayload.shareLink).toMatchObject({
      projectId,
      mode: 'tweak',
      revokedAt: null
    });
    expect(mintedPayload.token).toHaveLength(43);

    const listed = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/share-links`, {
        headers: { 'x-openzcad-development-user': owner }
      }),
      routeEnv
    );
    expect(listed.status).toBe(200);
    const listedPayload = (await listed.json()) as {
      shareLinks: Array<{ shareLinkId: string; mode: string }>;
    };
    expect(listedPayload).toMatchObject({
      shareLinks: [
        { shareLinkId: mintedPayload.shareLink.shareLinkId, mode: 'tweak' }
      ]
    });
    expect(JSON.stringify(listedPayload)).not.toContain(mintedPayload.token);

    // The visitor is anonymous: no session header on the public routes.
    const sharedResponse = await worker.fetch(
      new Request(`https://example.com/api/share/${mintedPayload.token}`),
      routeEnv
    );
    expect(sharedResponse.status).toBe(200);
    await expect(sharedResponse.json()).resolves.toMatchObject({
      project: { projectId, name: 'Share routes', mode: 'tweak' },
      document: { projectId }
    });

    const unknownToken = await worker.fetch(
      new Request(`https://example.com/api/share/${'b'.repeat(43)}`),
      routeEnv
    );
    expect(unknownToken.status).toBe(404);
    const opaqueNotFound = (await unknownToken.json()) as { error: string };
    const malformedToken = await worker.fetch(
      new Request('https://example.com/api/share/not-a-real-token'),
      routeEnv
    );
    expect(malformedToken.status).toBe(404);
    await expect(malformedToken.json()).resolves.toEqual(opaqueNotFound);
    const missingAsset = await worker.fetch(
      new Request(
        `https://example.com/api/share/${mintedPayload.token}/assets/asset_missing`
      ),
      routeEnv
    );
    expect(missingAsset.status).toBe(404);

    const revoked = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${projectId}/share-links/${mintedPayload.shareLink.shareLinkId}`,
        {
          method: 'DELETE',
          headers: { 'x-openzcad-development-user': owner }
        }
      ),
      routeEnv
    );
    expect(revoked.status).toBe(204);

    const afterRevoke = await worker.fetch(
      new Request(`https://example.com/api/share/${mintedPayload.token}`),
      routeEnv
    );
    expect(afterRevoke.status).toBe(404);
    await expect(afterRevoke.json()).resolves.toEqual(opaqueNotFound);
  });

  it('rejects invalid modes and keeps minting owner-only', async () => {
    const owner = toUserId('user_share_route_mode_owner');
    const outsider = toUserId('user_share_route_outsider');
    const created = await createProjectViaRoute(owner, 'Share route modes');
    const projectId = created.document.projectId;

    const invalidMode = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/share-links`, {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({ mode: 'edit' })
      }),
      routeEnv
    );
    expect(invalidMode.status).toBe(400);
    await expect(invalidMode.json()).resolves.toMatchObject({
      code: 'SHARE_LINK_MODE_INVALID'
    });

    const outsiderMint = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/share-links`, {
        method: 'POST',
        headers: { 'x-openzcad-development-user': outsider },
        body: JSON.stringify({ mode: 'tweak' })
      }),
      routeEnv
    );
    expect(outsiderMint.status).toBe(404);
  });

  it('keeps the owner routes closed while sharing is disabled', async () => {
    const owner = toUserId('user_share_route_flag_owner');
    const disabledEnv = { ...routeEnv, PROJECT_SHARING_ENABLED: 'false' };
    const created = await createProjectViaRoute(owner, 'Share routes gated');
    const response = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.document.projectId}/share-links`,
        {
          method: 'POST',
          headers: { 'x-openzcad-development-user': owner },
          body: JSON.stringify({ mode: 'tweak' })
        }
      ),
      disabledEnv
    );
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: 'FEATURE_DISABLED'
    });
  });

  it('stops serving links already in the wild once sharing is disabled', async () => {
    // The flag has to be a kill switch, not just a mint switch: a link handed
    // out before it was turned off must stop resolving too, or disabling
    // sharing would leave every existing link serving whole documents.
    const owner = toUserId('user_share_kill_switch_owner');
    const created = await createProjectViaRoute(owner, 'Share kill switch');
    const minted = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.document.projectId}/share-links`,
        {
          method: 'POST',
          headers: { 'x-openzcad-development-user': owner },
          body: JSON.stringify({ mode: 'tweak' })
        }
      ),
      routeEnv
    );
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const whileEnabled = await worker.fetch(
      new Request(`https://example.com/api/share/${token}`),
      routeEnv
    );
    expect(whileEnabled.status).toBe(200);

    const disabledEnv = { ...routeEnv, PROJECT_SHARING_ENABLED: 'false' };
    const whileDisabled = await worker.fetch(
      new Request(`https://example.com/api/share/${token}`),
      disabledEnv
    );
    expect(whileDisabled.status).toBe(404);
    // The same opaque body as an unknown token: an anonymous prober learns
    // nothing about how this deployment is configured.
    const unknown = await worker.fetch(
      new Request(`https://example.com/api/share/${'c'.repeat(43)}`),
      disabledEnv
    );
    await expect(whileDisabled.json()).resolves.toEqual(await unknown.json());

    const assetWhileDisabled = await worker.fetch(
      new Request(`https://example.com/api/share/${token}/assets/asset_any`),
      disabledEnv
    );
    expect(assetWhileDisabled.status).toBe(404);
  });
});
