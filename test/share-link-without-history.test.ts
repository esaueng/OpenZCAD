import { describe, expect, it } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  frozenShareDocument,
  frozenShareDocumentProblem,
  importStepBody,
  listNodesByKind,
  sharedProjectSnapshotDocument
} from '@openzcad/document-core';
import {
  InMemoryPersistenceService,
  ProjectSharingError,
  type PersistenceService
} from '@openzcad/persistence';
import {
  toUserId,
  type CreateProjectResponse,
  type ProjectDocument,
  type ProjectShareLinkSummary,
  type SharedProjectResponse
} from '@openzcad/shared';
import { hashProjectInvitationToken } from '../apps/web/worker/sharing';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const STEP = 'ISO-10303-21;\nEND-ISO-10303-21;\n';
const SECRET = 'SECRET_HISTORY_VALUE';
const token = (seed: string) => seed.repeat(43).slice(0, 43);
const now = () => Math.floor(Date.now() / 1000);

/** The owner's project: an import whose name, log and save states are history. */
function ownerProject(): ProjectDocument {
  const base = importStepBody(
    createProjectDocument('Bracket', toUserId('user_owner')),
    {
      name: `${SECRET} feature`,
      artifactId: 'artifact_local_owner',
      sourceName: `${SECRET}.step`,
      stepText: STEP
    }
  ).document;
  return {
    ...base,
    commandLog: [{ type: SECRET } as never],
    revisions: [{ ...base.revisions[0]!, reason: SECRET }]
  };
}

function frozenOf(document: ProjectDocument, bodyName = 'Plate') {
  return frozenShareDocument(document, [
    { name: bodyName, stepText: STEP, color: null, opacity: null }
  ]);
}

function database() {
  const document = ownerProject();
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    document.ownerUserId,
    'owner@example.com',
    '2026-11-21T00:00:00.000Z'
  );
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    document.projectId,
    document.ownerUserId,
    document.name,
    JSON.stringify(document),
    '2026-11-21T00:00:00.000Z'
  );
  const env = {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    ARTIFACTS: {} as R2Bucket,
    PROJECT_SHARING_ENABLED: 'true',
    DB: sqliteD1(db)
  };
  return { db, document, env, service: new D1R2PersistenceService(env) };
}

async function inMemory() {
  const service = new InMemoryPersistenceService();
  const owner = toUserId('user_owner');
  const created = await service.createProject(owner, { name: 'Bracket' });
  const document = {
    ...ownerProject(),
    projectId: created.document.projectId
  };
  return { service, document: { ...document, ownerUserId: owner } };
}

async function frozenLink(
  service: PersistenceService,
  document: ProjectDocument,
  id: string,
  seed: string,
  extra: { comments?: boolean } = {}
): Promise<ProjectShareLinkSummary> {
  return service.createProjectShareLink(
    document.ownerUserId,
    document.projectId,
    {
      shareLinkId: id,
      mode: 'view',
      tokenHash: await hashProjectInvitationToken(token(seed)),
      createdAt: now() - 10,
      frozenDocument: frozenOf(document),
      ...extra
    }
  );
}

const visit = (service: PersistenceService, seed: string) =>
  hashProjectInvitationToken(token(seed)).then((hash) =>
    service.loadSharedProjectByTokenHash(hash)
  );

describe.each([
  ['D1', () => Promise.resolve(database())],
  ['in memory', inMemory]
] as const)('a share link without history (%s)', (_name, setup) => {
  it('serves only the frozen solids, never the project', async () => {
    const { service, document } = await setup();
    const created = await frozenLink(service, document, 'share_f', 'f');
    expect(created).toMatchObject({ mode: 'view', history: false });
    expect(created.frozenAt).toBe(created.createdAt);

    const shared = await visit(service, 'f');
    expect(shared).toMatchObject({ mode: 'view', history: false });
    expect(shared!.document.projectId).toBe(document.projectId);
    expect(frozenShareDocumentProblem(shared!.document)).toBeNull();
    expect(
      listNodesByKind(shared!.document, 'feature').map((node) => node.name)
    ).toEqual(['Plate']);
    expect(JSON.stringify(shared)).not.toContain(SECRET);
  });

  it('lists the link as having no history beside an ordinary one', async () => {
    const { service, document } = await setup();
    await frozenLink(service, document, 'share_f', 'f');
    await service.createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_live',
        mode: 'tweak',
        tokenHash: await hashProjectInvitationToken(token('l')),
        createdAt: now()
      }
    );
    const listed = await service.listProjectShareLinks(
      document.ownerUserId,
      document.projectId
    );
    const live = listed.find((link) => link.shareLinkId === 'share_live')!;
    expect(live.mode).toBe('tweak');
    expect(live).not.toHaveProperty('history');
    expect(live).not.toHaveProperty('frozenAt');
    expect(listed.find((link) => link.shareLinkId === 'share_f')).toMatchObject(
      { history: false, mode: 'view' }
    );
    // A rename keeps the mark.
    expect(
      await service.renameProjectShareLink(
        document.ownerUserId,
        document.projectId,
        'share_f',
        'For the supplier'
      )
    ).toMatchObject({ history: false, label: 'For the supplier' });
  });

  it('forces view even when asked for tweak', async () => {
    const { service, document } = await setup();
    const created = await service.createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_f',
        mode: 'tweak',
        tokenHash: await hashProjectInvitationToken(token('f')),
        createdAt: now(),
        frozenDocument: frozenOf(document)
      }
    );
    expect(created.mode).toBe('view');
    expect((await visit(service, 'f'))?.mode).toBe('view');
  });

  it('refuses to store the project itself as the frozen model', async () => {
    const { service, document } = await setup();
    for (const frozenDocument of [
      document,
      sharedProjectSnapshotDocument(document),
      // Another project's frozen model.
      frozenOf(createProjectDocument('Other', document.ownerUserId))
    ]) {
      await expect(
        service.createProjectShareLink(
          document.ownerUserId,
          document.projectId,
          {
            shareLinkId: 'share_bad',
            mode: 'view',
            tokenHash: await hashProjectInvitationToken(token('b')),
            createdAt: now(),
            frozenDocument
          }
        )
      ).rejects.toMatchObject({ code: 'SHARE_LINK_SNAPSHOT_INVALID' });
    }
    expect(await visit(service, 'b')).toBeNull();
    expect(
      await service.listProjectShareLinks(
        document.ownerUserId,
        document.projectId
      )
    ).toEqual([]);
  });

  it('keeps the frozen model until Update replaces it', async () => {
    const { service, document } = await setup();
    await frozenLink(service, document, 'share_f', 'f');
    const names = async () =>
      listNodesByKind((await visit(service, 'f'))!.document, 'feature').map(
        (node) => node.name
      );
    expect(await names()).toEqual(['Plate']);

    const updatedAt = now();
    const updated = await service.updateProjectShareLinkSnapshot(
      document.ownerUserId,
      document.projectId,
      'share_f',
      frozenOf(document, 'Plate v2'),
      updatedAt
    );
    expect(updated).toMatchObject({
      shareLinkId: 'share_f',
      history: false,
      frozenAt: updatedAt
    });
    // The same token now serves the new model.
    expect(await names()).toEqual(['Plate v2']);

    await expect(
      service.updateProjectShareLinkSnapshot(
        document.ownerUserId,
        document.projectId,
        'share_f',
        sharedProjectSnapshotDocument(document),
        now()
      )
    ).rejects.toMatchObject({ code: 'SHARE_LINK_SNAPSHOT_INVALID' });
    expect(await names()).toEqual(['Plate v2']);
  });

  it('does not turn a link to the live project into a frozen one', async () => {
    const { service, document } = await setup();
    await service.createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_live',
        mode: 'view',
        tokenHash: await hashProjectInvitationToken(token('l')),
        createdAt: now()
      }
    );
    await expect(
      service.updateProjectShareLinkSnapshot(
        document.ownerUserId,
        document.projectId,
        'share_live',
        frozenOf(document),
        now()
      )
    ).rejects.toBeInstanceOf(ProjectSharingError);
  });

  it('serves nothing once revoked', async () => {
    const { service, document } = await setup();
    await frozenLink(service, document, 'share_f', 'f');
    await service.revokeProjectShareLink(
      document.ownerUserId,
      document.projectId,
      'share_f',
      now()
    );
    expect(await visit(service, 'f')).toBeNull();
  });
});

describe('a share link without history in D1 (migration 0062)', () => {
  it('reads every existing link as sharing its history', async () => {
    const { db, document, service } = database();
    db.prepare(
      `INSERT INTO project_share_links
         (id, project_id, mode, token_hash, created_by_user_id, created_at)
       VALUES (?, ?, 'tweak', ?, ?, ?)`
    ).run(
      'share_old',
      document.projectId,
      await hashProjectInvitationToken(token('o')),
      document.ownerUserId,
      now()
    );
    expect(
      db
        .prepare(
          'SELECT history, frozen_document, frozen_at FROM project_share_links'
        )
        .get()
    ).toEqual({ history: 1, frozen_document: null, frozen_at: null });
    const shared = await visit(service, 'o');
    expect(shared?.mode).toBe('tweak');
    expect(shared).not.toHaveProperty('history');
    // The live project, as before: its feature tree is there.
    expect(JSON.stringify(shared!.document)).toContain(SECRET);
  });

  it('stores the model compressed and clears it on revoke', async () => {
    const { db, document, service } = database();
    await frozenLink(service, document, 'share_f', 'f');
    const row = () =>
      db
        .prepare(
          'SELECT history, frozen_document FROM project_share_links WHERE id = ?'
        )
        .get('share_f') as { history: number; frozen_document: string | null };
    expect(row().history).toBe(0);
    expect(row().frozen_document).toMatch(/^H4sI/);
    await service.revokeProjectShareLink(
      document.ownerUserId,
      document.projectId,
      'share_f',
      now()
    );
    expect(row()).toEqual({ history: 0, frozen_document: null });
  });

  it('drops the model when anything else revokes the link', async () => {
    const { db, document, service } = database();
    await frozenLink(service, document, 'share_f', 'f');
    // As the cutover that encrypts a project revokes its plaintext links.
    db.prepare(
      'UPDATE project_share_links SET revoked_at = created_at WHERE project_id = ?'
    ).run(document.projectId);
    expect(
      db
        .prepare(
          'SELECT history, frozen_document FROM project_share_links WHERE id = ?'
        )
        .get('share_f')
    ).toEqual({ history: 0, frozen_document: null });
  });

  it('serves nothing when the stored model is not a frozen one', async () => {
    const { db, document, service } = database();
    await frozenLink(service, document, 'share_f', 'f');
    // A row that lost its model, or names no history without one.
    db.prepare(
      'UPDATE project_share_links SET frozen_document = NULL WHERE id = ?'
    ).run('share_f');
    expect(await visit(service, 'f')).toBeNull();
    // The schema itself refuses to flip a link back to the live project.
    expect(() =>
      db
        .prepare('UPDATE project_share_links SET history = 1 WHERE id = ?')
        .run('share_f')
    ).toThrow(/SHARE_LINK_HISTORY_IMMUTABLE/);
  });

  it('serves no project asset or import source through the link', async () => {
    const { db, document, env, service } = database();
    await frozenLink(service, document, 'share_f', 'f');
    db.prepare(
      `INSERT INTO artifacts
         (id, project_id, kind, name, object_key, content_type, bytes,
          metadata_json, created_at)
       VALUES ('artifact_1', ?, 'step-import', 'a.step', 'k', 'model/step', 3,
               '{}', '2026-11-21T00:00:00.000Z')`
    ).run(document.projectId);
    const hash = await hashProjectInvitationToken(token('f'));
    expect(
      await service.loadSharedProjectImportSource(hash, 'artifact_1')
    ).toBeNull();
    expect(await service.loadSharedProjectAsset(hash, 'asset_1')).toBeNull();
    for (const path of ['sources/artifact_1', 'assets/asset_1']) {
      const response = await worker.fetch(
        new Request(`https://example.com/api/share/${path}`, {
          headers: { 'x-openzcad-share-token': token('f') }
        }),
        env
      );
      expect(response.status).toBe(404);
    }
  });

  it('answers the visitor route with the frozen model and its mark', async () => {
    const { document, env, service } = database();
    await frozenLink(service, document, 'share_f', 'f', { comments: true });
    const response = await worker.fetch(
      new Request('https://example.com/api/share', {
        headers: { 'x-openzcad-share-token': token('f') }
      }),
      env
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const payload = JSON.parse(text) as SharedProjectResponse;
    expect(payload.project).toMatchObject({
      mode: 'view',
      history: false,
      comments: true
    });
    expect(payload.document.sketchOrder).toEqual([]);
    expect(payload.document.parameterOrder).toEqual([]);
    expect(payload.document.revisions).toEqual([]);
    expect(payload.document.commandLog).toEqual([]);
    expect(
      listNodesByKind(payload.document, 'feature').map(
        (node) => node.featureKind
      )
    ).toEqual(['imported-step']);
  });
});

describe('share links without history (owner routes)', () => {
  const routeEnv = {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    ARTIFACTS: {} as R2Bucket,
    PROJECT_SHARING_ENABLED: 'true'
  };
  const owner = 'history-owner@example.com';
  const call = (path: string, method: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers: { 'x-openzcad-development-user': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      routeEnv
    );

  it('creates, updates and refuses through the API', async () => {
    const createdProject = (await (
      await call('/api/projects', 'POST', { name: 'Routes without history' })
    ).json()) as CreateProjectResponse;
    const project = createdProject.document;
    const links = `/api/projects/${project.projectId}/share-links`;

    // Tweak has nothing to tweak; a model is required; and a link that
    // shares history takes no model.
    expect(
      (
        await call(links, 'POST', {
          mode: 'tweak',
          history: false,
          document: frozenOf(project)
        })
      ).status
    ).toBe(400);
    expect(
      (await call(links, 'POST', { mode: 'view', history: false })).status
    ).toBe(400);
    expect(
      (
        await call(links, 'POST', {
          mode: 'view',
          document: frozenOf(project)
        })
      ).status
    ).toBe(400);
    const refused = await call(links, 'POST', {
      mode: 'view',
      history: false,
      document: project
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'SHARE_LINK_SNAPSHOT_INVALID'
    );

    const minted = await call(links, 'POST', {
      mode: 'view',
      history: false,
      document: frozenOf(project)
    });
    expect(minted.status).toBe(201);
    const { shareLink, token: minting } = (await minted.json()) as {
      shareLink: ProjectShareLinkSummary;
      token: string;
    };
    expect(shareLink).toMatchObject({ mode: 'view', history: false });

    const read = async () =>
      (await (
        await worker.fetch(
          new Request('https://example.com/api/share', {
            headers: { 'x-openzcad-share-token': minting }
          }),
          routeEnv
        )
      ).json()) as SharedProjectResponse;
    expect((await read()).project.history).toBe(false);

    const updated = await call(`${links}/${shareLink.shareLinkId}`, 'PATCH', {
      document: frozenOf(project, 'Plate v2')
    });
    expect(updated.status).toBe(200);
    expect(
      ((await updated.json()) as { shareLink: ProjectShareLinkSummary })
        .shareLink
    ).toMatchObject({ shareLinkId: shareLink.shareLinkId, history: false });
    expect(
      listNodesByKind((await read()).document, 'feature').map(
        (node) => node.name
      )
    ).toEqual(['Plate v2']);

    expect(
      (
        await call(`${links}/${shareLink.shareLinkId}`, 'PATCH', {
          document: project
        })
      ).status
    ).toBe(400);
    // A rename still works on the same route.
    const renamed = await call(`${links}/${shareLink.shareLinkId}`, 'PATCH', {
      label: 'Supplier'
    });
    expect(
      ((await renamed.json()) as { shareLink: ProjectShareLinkSummary })
        .shareLink
    ).toMatchObject({ label: 'Supplier', history: false });
  });
});
