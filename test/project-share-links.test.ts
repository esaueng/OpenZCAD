import type { ProjectDocument } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError,
  getInMemoryPersistence
} from '@openzcad/persistence';
import {
  createCheckpoint,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';
import {
  createShareLink,
  hashProjectInvitationToken,
  parseCreateShareLink,
  parseShareLinkToken
} from '../apps/web/worker/sharing';
import {
  toArtifactId,
  toProjectId,
  toRevisionId,
  toUserId,
  type CreateProjectResponse
} from '@openzcad/shared';

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

  it('refuses a link at its fixed expiration boundary', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_share_expiry');
    const project = await service.createProject(owner, { name: 'Expires' });
    const createdAt = Math.floor(Date.now() / 1000);
    await service.createProjectShareLink(owner, project.document.projectId, {
      shareLinkId: 'share_expiry',
      mode: 'view',
      tokenHash: 'hash_expiry',
      createdAt
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue((createdAt + 30 * 24 * 60 * 60 - 1) * 1000);
      await expect(
        service.loadSharedProjectByTokenHash('hash_expiry')
      ).resolves.not.toBeNull();
      clock.mockReturnValue((createdAt + 30 * 24 * 60 * 60) * 1000);
      await expect(
        service.loadSharedProjectByTokenHash('hash_expiry')
      ).resolves.toBeNull();
    } finally {
      clock.mockRestore();
    }
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

  it('authorizes the D1 shared reads by unrevoked, unexpired token hash', async () => {
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
    expect(assetRead?.bindings).toEqual([
      'hash_d1',
      expect.any(Number),
      'asset_d1'
    ]);
  });

  it('rechecks D1 link authorization when serving a referenced STEP artifact', async () => {
    const owner = toUserId('user_d1_share_source');
    const artifactId = toArtifactId('artifact_synthetic');
    const base = (
      await new InMemoryPersistenceService().createProject(owner, {
        name: 'D1 source'
      })
    ).document;
    const document = importStepBody(base, {
      name: 'Synthetic import',
      sourceName: 'synthetic.step',
      artifactId,
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: 'a'.repeat(64),
        logicalBytes: 4
      }
    }).document;
    let sourceAvailable = true;
    const queries: string[] = [];
    const prepare = vi.fn((query: string) => ({
      bind: (...bindings: unknown[]) => ({
        all: async () => {
          expect(query).toContain('FROM project_copy_source_archives');
          expect(bindings).toEqual([base.projectId]);
          return { results: [] };
        },
        first: async () => {
          // The storage-format schema probe answers "not installed".
          if (query.includes('pragma_table_info')) return null;
          queries.push(query);
          if (query.includes('FROM project_share_links l')) {
            expect(bindings).toEqual(['hash_source', expect.any(Number)]);
            return {
              mode: 'tweak',
              project_id: base.projectId,
              name: base.name,
              document_json: JSON.stringify(document),
              document_object_id: null
            };
          }
          expect(bindings).toEqual([
            'hash_source',
            expect.any(Number),
            artifactId
          ]);
          return sourceAvailable
            ? {
                id: artifactId,
                project_id: base.projectId,
                kind: 'step-import',
                name: 'synthetic.step',
                object_key: 'source-object',
                content_type: 'application/step',
                bytes: 4,
                metadata_json: '{}',
                created_at: '2026-01-01T00:00:00.000Z'
              }
            : null;
        }
      })
    }));
    const get = vi.fn(async () => ({ body: new Response('STEP').body }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      ARTIFACTS: { get } as unknown as R2Bucket
    });
    const source = await service.loadSharedProjectImportSource(
      'hash_source',
      artifactId
    );
    expect(source?.contentType).toBe('application/step');
    expect(await new Response(source?.body).text()).toBe('STEP');
    expect(get).toHaveBeenCalledWith('source-object');
    const sourceQuery = queries.find((query) =>
      query.includes('FROM artifacts a')
    );
    expect(sourceQuery).toContain('l.revoked_at IS NULL');
    // Import sources only: STEP sources and mesh payloads, never exports.
    expect(sourceQuery).toContain("a.kind IN ('step-import', 'mesh-payload')");
    expect(sourceQuery).toContain("p.status != 'deleted'");
    expect(sourceQuery).toContain('$.collaboration.enabled');
    sourceAvailable = false;
    get.mockClear();
    await expect(
      service.loadSharedProjectImportSource('hash_source', artifactId)
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * The owner models a CONFIDENTIAL insert, deletes it, and shares what is left.
 * The stored document still remembers the insert — its undo history and
 * command log hold the feature with its dimensions, a save-state name
 * mentions it, and the project was branched off another one whose name is
 * private too. Dimensions use four decimals so no timestamp can contain them.
 */
function ownerDocumentWithDeletedFeature(
  base: ProjectDocument
): ProjectDocument {
  const manager = new CommandManager(base, base.ownerUserId);
  manager.execute(
    commandFactories.setParameter({ name: 'plate_width', expression: '80' })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Bracket',
      primitiveKind: 'box',
      dimensions: { width: 80, depth: 40, height: 6 }
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'CONFIDENTIAL insert',
      primitiveKind: 'cylinder',
      dimensions: { radius: 7.2531, height: 31.4159 }
    })
  );
  const secret = listFeaturesInOrder(manager.document).at(-1)!;
  manager.execute(
    commandFactories.deleteFeature({ featureId: secret.featureId })
  );
  return {
    ...createCheckpoint(
      manager.document,
      'Before removing the CONFIDENTIAL insert'
    ),
    branchedFrom: {
      projectId: toProjectId('proj_private_source'),
      revisionId: toRevisionId('rev_private_source'),
      projectName: 'CONFIDENTIAL customer program',
      checkpointReason: 'Saved',
      branchedAt: '2026-01-01T00:00:00.000Z'
    }
  };
}

function featureNames(document: ProjectDocument): string[] {
  return listFeaturesInOrder(document).map((feature) => feature.name);
}

/** What a share-link visitor may and may not receive, from either backend. */
function expectCurrentModelOnly(document: ProjectDocument): void {
  expect(featureNames(document)).toEqual(['Bracket']);
  const payload = JSON.stringify(document);
  expect(payload).not.toContain('CONFIDENTIAL');
  expect(payload).not.toContain('7.2531');
  expect(payload).not.toContain('31.4159');
  expect(document.editHistory).toBeUndefined();
  expect(document.commandLog).toEqual([]);
  expect(document.revisions).toEqual([]);
  expect(document.checkpoints).toEqual([]);
  expect(document.branchedFrom).toBeUndefined();
  expect(document.ownerUserId).toBe('user_shared');

  // The signed-out visitor's workspace builds a CommandManager over the
  // snapshot as the shared owner. Undo used to walk the owner's history and
  // put the deleted insert back in the visitor's tab.
  const visitor = new CommandManager(document, document.ownerUserId);
  expect(visitor.canUndo).toBe(false);
  visitor.undo();
  expect(featureNames(visitor.document)).toEqual(['Bracket']);
  // Tweak still works: a parameter edit starts the visitor's own history.
  visitor.execute(
    commandFactories.setParameter({ name: 'plate_width', expression: '90' })
  );
  expect(visitor.undoEntryKinds).toEqual(['parameter.set']);
  visitor.undo();
  expect(visitor.canUndo).toBe(false);
  expect(visitor.document.nodes).toEqual(document.nodes);
}

/** A real-SQLite D1 holding one project, as its owner saved it, and one link. */
function sharedProjectD1(document: ProjectDocument) {
  const db = migratedDatabase();
  db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(
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
  db.prepare(
    `INSERT INTO project_share_links
       (id, project_id, mode, token_hash, created_by_user_id, created_at)
     VALUES ('share_projection', ?, 'tweak', 'hash_projection', ?, ?)`
  ).run(
    document.projectId,
    document.ownerUserId,
    Math.floor(Date.now() / 1000)
  );
  return db;
}

describe('project share links (visitor snapshot)', () => {
  it('serves the current model without the history behind it (in memory)', async () => {
    const owner = toUserId('user_share_history_owner');
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Bracket' });
    await service.saveDocument(owner, {
      projectId: created.document.projectId,
      expectedVersion: created.document.version,
      document: ownerDocumentWithDeletedFeature(created.document)
    });
    await service.createProjectShareLink(owner, created.document.projectId, {
      shareLinkId: 'share_history',
      mode: 'tweak',
      tokenHash: 'hash_history',
      createdAt: Math.floor(Date.now() / 1000)
    });

    const shared = await service.loadSharedProjectByTokenHash('hash_history');
    expect(shared).not.toBeNull();
    expectCurrentModelOnly(shared!.document);
    // The owner's own copy is untouched: the projection is for visitors only.
    const own = await service.loadProject(owner, created.document.projectId);
    expect(own?.editHistory?.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(own)).toContain('CONFIDENTIAL');
  });

  it('serves the same projection from D1', async () => {
    const document = ownerDocumentWithDeletedFeature(
      createProjectDocument('Bracket', toUserId('user_share_history_d1'))
    );
    const service = new D1R2PersistenceService({
      DB: sqliteD1(sharedProjectD1(document))
    });

    const shared =
      await service.loadSharedProjectByTokenHash('hash_projection');
    expect(shared).toMatchObject({
      projectId: document.projectId,
      name: 'Bracket',
      mode: 'tweak'
    });
    expectCurrentModelOnly(shared!.document);
  });

  it('serves only the import sources the current model uses', async () => {
    const owner = toUserId('user_share_sources_d1');
    const sourceRef = (seed: string) => ({
      marker: 'openzcad-source-ref' as const,
      version: 1 as const,
      hashAlgorithm: 'sha256' as const,
      checksumSha256: seed.repeat(64),
      logicalBytes: 4
    });
    const manager = new CommandManager(
      createProjectDocument('Sources', owner),
      owner
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Kept import',
        sourceName: 'kept.step',
        artifactId: toArtifactId('artifact_kept'),
        stepSourceRef: sourceRef('a')
      })
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Deleted import',
        sourceName: 'deleted.step',
        artifactId: toArtifactId('artifact_deleted'),
        stepSourceRef: sourceRef('b')
      })
    );
    const deleted = listFeaturesInOrder(manager.document).at(-1)!;
    manager.execute(
      commandFactories.deleteFeature({ featureId: deleted.featureId })
    );
    const db = sharedProjectD1(manager.document);
    for (const id of ['artifact_kept', 'artifact_deleted']) {
      db.prepare(
        `INSERT INTO artifacts
           (id, project_id, kind, name, object_key, content_type, metadata_json,
            created_at, bytes)
         VALUES (?, ?, 'step-import', ?, ?, 'application/step', '{}', ?, 4)`
      ).run(
        id,
        manager.document.projectId,
        `${id}.step`,
        `objects/${id}`,
        '2026-01-01T00:00:00.000Z'
      );
    }
    const get = vi.fn(async () => ({ body: new Response('STEP').body }));
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      ARTIFACTS: { get } as unknown as R2Bucket
    });

    const kept = await service.loadSharedProjectImportSource(
      'hash_projection',
      'artifact_kept'
    );
    expect(await new Response(kept?.body).text()).toBe('STEP');
    // Reachable only through undo history: the owner deleted it before
    // sharing, so its source is not part of what they shared.
    await expect(
      service.loadSharedProjectImportSource(
        'hash_projection',
        'artifact_deleted'
      )
    ).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('objects/artifact_kept');
  });
});

describe('project share links (worker helpers)', () => {
  it.each(['application/step', 'text/html', 'image/svg+xml'])(
    'serves referenced sources as inert downloads even for %s',
    async (contentType) => {
      const service = getInMemoryPersistence();
      const owner = toUserId(`user_share_source_${crypto.randomUUID()}`);
      const project = await service.createProject(owner, {
        name: 'Synthetic source'
      });
      const projectId = project.document.projectId;
      const source = new TextEncoder().encode(
        contentType === 'application/step'
          ? 'ISO-10303-21;\nEND-ISO-10303-21;'
          : '<script>fetch("/api/account/delete-data", {method: "POST"})</script>'
      );
      const checksumSha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', source)),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
      const { session } = await service.createUploadSession(owner, {
        projectId,
        fileName: 'synthetic.step',
        contentType,
        kind: 'step-import'
      });
      await service.putUpload(owner, session.uploadSessionId, source.buffer);
      await service.finalizeArtifact(owner, {
        projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      });
      const imported = importStepBody(project.document, {
        name: 'Synthetic import',
        sourceName: 'synthetic.step',
        artifactId: session.artifactId,
        stepSourceRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256,
          logicalBytes: source.byteLength
        }
      }).document;
      await service.saveRevision(owner, {
        projectId,
        expectedVersion: project.document.version,
        reason: 'Import source',
        document: imported
      });
      const { token, shareLink } = await createShareLink(
        service,
        owner,
        projectId,
        { mode: 'tweak' },
        2_000_000_000
      );
      const sourceUrl = `https://example.com/api/share/${token}/sources/${session.artifactId}`;
      const load = () => worker.fetch(new Request(sourceUrl), routeEnv);
      const anonymous = await worker.fetch(
        new Request(`https://example.com/api/share/${token}`),
        routeEnv
      );
      const projection = (await anonymous.json()) as {
        document: ProjectDocument;
      };
      expect(projection.document.ownerUserId).toBe('user_shared');
      expect(projection.document.ownerUserId).not.toBe(owner);
      const available = await load();
      expect(available.status).toBe(200);
      expect(available.headers.get('cache-control')).toBe('no-store');
      expect(available.headers.get('content-disposition')).toBe('attachment');
      expect(available.headers.get('content-security-policy')).toContain(
        "default-src 'none'; sandbox"
      );
      expect(new Uint8Array(await available.arrayBuffer())).toEqual(source);
      const unrelated = await worker.fetch(
        new Request(
          `https://example.com/api/share/${token}/sources/artifact_unrelated`
        ),
        routeEnv
      );
      expect(unrelated.status).toBe(404);
      await service.revokeProjectShareLink(
        owner,
        projectId,
        shareLink.shareLinkId,
        2_000_000_001
      );
      expect((await load()).status).toBe(404);
    }
  );

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
