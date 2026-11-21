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
  EncryptedProjectSharingError,
  FROZEN_SHARE_LINK_TOKEN_HASH_PREFIX,
  InMemoryPersistenceService,
  ProjectSharingError,
  type PersistenceService
} from '@openzcad/persistence';
import {
  toUserId,
  type CreateProjectResponse,
  type ProjectComment,
  type ProjectDocument,
  type ProjectShareLinkSummary,
  type SharedProjectResponse
} from '@openzcad/shared';
import { createProjectComment } from '../apps/web/worker/projectComments';
import {
  hashFrozenShareLinkToken,
  hashProjectInvitationToken
} from '../apps/web/worker/sharing';
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
      tokenHash: await hashFrozenShareLinkToken(token(seed)),
      createdAt: now() - 10,
      frozenDocument: frozenOf(document),
      ...extra
    }
  );
}

/** As the visitor route reads a token: both hash domains. */
const visit = async (service: PersistenceService, seed: string) =>
  service.loadSharedProjectByTokenHash(
    await hashProjectInvitationToken(token(seed)),
    await hashFrozenShareLinkToken(token(seed))
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
        tokenHash: await hashFrozenShareLinkToken(token('f')),
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
            tokenHash: await hashFrozenShareLinkToken(token('b')),
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
    for (const hash of [
      await hashProjectInvitationToken(token('f')),
      await hashFrozenShareLinkToken(token('f'))
    ]) {
      expect(
        await service.loadSharedProjectImportSource(hash, 'artifact_1')
      ).toBeNull();
      expect(await service.loadSharedProjectAsset(hash, 'asset_1')).toBeNull();
    }
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

/**
 * Review of #1872, finding 1: a link without history must not resolve
 * through the read a Worker from before migration 0062 runs, which looks a
 * token up by its bare SHA-256 and serves the live project for the row.
 */
describe('a link without history against the lookups that serve a live project', () => {
  /** The visitor read as the Worker before this change ran it. */
  const LEGACY_READ = `SELECT l.mode, p.id AS project_id, p.name,
                              p.document_json, p.document_object_id
       FROM project_share_links l
       INNER JOIN projects p ON p.id = l.project_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.created_at > ?
         AND p.status != 'deleted' AND p.storage_format = 1`;

  it('stores its token hash where a bare-hash lookup cannot find it', async () => {
    const { db, document, service } = database();
    await frozenLink(service, document, 'share_f', 'f');
    const bare = await hashProjectInvitationToken(token('f'));
    const stored = (
      db
        .prepare('SELECT token_hash FROM project_share_links WHERE id = ?')
        .get('share_f') as { token_hash: string }
    ).token_hash;
    expect(stored.startsWith(FROZEN_SHARE_LINK_TOKEN_HASH_PREFIX)).toBe(true);
    expect(stored).toBe(await hashFrozenShareLinkToken(token('f')));
    // Not the bare hash behind a prefix either: another digest.
    expect(stored).not.toContain(bare);
    // A rolled-back Worker's read: no row, so a 404 and never the project.
    expect(db.prepare(LEGACY_READ).get(bare, 0)).toBeUndefined();
    // The same read does find a link to the live project.
    await service.createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_l',
        mode: 'view',
        tokenHash: await hashProjectInvitationToken(token('l')),
        createdAt: now()
      }
    );
    expect(
      db
        .prepare(LEGACY_READ)
        .get(await hashProjectInvitationToken(token('l')), 0)
    ).toMatchObject({ project_id: document.projectId });
  });

  it('answers a bare hash with nothing through this Worker too', async () => {
    const { document, service } = database();
    await frozenLink(service, document, 'share_f', 'f');
    const bare = await hashProjectInvitationToken(token('f'));
    const frozen = await hashFrozenShareLinkToken(token('f'));
    expect(await service.loadSharedProjectByTokenHash(bare)).toBeNull();
    // Nor by handing the frozen hash to the lookup of live projects.
    expect(await service.loadSharedProjectByTokenHash(frozen)).toBeNull();
    expect(
      (await service.loadSharedProjectByTokenHash(bare, frozen))?.history
    ).toBe(false);
  });

  it('serves nothing for the token while the schema probe says 0062 is missing', async () => {
    const { db, document, env } = database();
    await frozenLink(new D1R2PersistenceService(env), document, 'share_f', 'f');
    await new D1R2PersistenceService(env).createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_l',
        mode: 'view',
        tokenHash: await hashProjectInvitationToken(token('l')),
        createdAt: now()
      }
    );
    // An isolate that probed before the migration and cached the answer:
    // a new binding whose probe for the column reports it absent.
    const real = sqliteD1(db);
    const stale: D1Database = {
      ...real,
      prepare: (sql: string) =>
        real.prepare(
          sql.includes("name = 'frozen_document'") ? 'SELECT 0 AS ready' : sql
        )
    };
    const staleEnv = { ...env, DB: stale };
    const read = (seed: string) =>
      worker.fetch(
        new Request('https://example.com/api/share', {
          headers: { 'x-openzcad-share-token': token(seed) }
        }),
        staleEnv
      );
    // The frozen link: a 404, not the live project it belongs to.
    const frozen = await read('f');
    expect(frozen.status).toBe(404);
    expect(await frozen.text()).not.toContain(SECRET);
    // A link to the live project reads as before.
    expect((await read('l')).status).toBe(200);
    // And such a Worker makes no link without history at all.
    await expect(
      frozenLink(new D1R2PersistenceService(staleEnv), document, 'share_g', 'g')
    ).rejects.toMatchObject({ code: 'SHARE_LINK_HISTORY_UNAVAILABLE' });
  });

  it('keeps every row in its own token-hash domain', async () => {
    const { db, document, service } = database();
    const bare = await hashProjectInvitationToken(token('x'));
    const frozen = await hashFrozenShareLinkToken(token('x'));
    // The adapter refuses either mismatch before it stores anything.
    await expect(
      service.createProjectShareLink(document.ownerUserId, document.projectId, {
        shareLinkId: 'share_x',
        mode: 'view',
        tokenHash: bare,
        createdAt: now(),
        frozenDocument: frozenOf(document)
      })
    ).rejects.toBeInstanceOf(ProjectSharingError);
    await expect(
      service.createProjectShareLink(document.ownerUserId, document.projectId, {
        shareLinkId: 'share_x',
        mode: 'view',
        tokenHash: frozen,
        createdAt: now()
      })
    ).rejects.toBeInstanceOf(ProjectSharingError);
    // And so does the schema, whoever writes the row.
    const insert = (id: string, hash: string, history: number) =>
      db
        .prepare(
          `INSERT INTO project_share_links
             (id, project_id, mode, token_hash, created_by_user_id,
              created_at, history)
           VALUES (?, ?, 'view', ?, ?, ?, ?)`
        )
        .run(
          id,
          document.projectId,
          hash,
          document.ownerUserId,
          now(),
          history
        );
    expect(() => insert('share_a', bare, 0)).toThrow(/SHARE_LINK_TOKEN_DOMAIN/);
    expect(() => insert('share_b', frozen, 1)).toThrow(
      /SHARE_LINK_TOKEN_DOMAIN/
    );
    insert('share_c', frozen, 0);
    expect(() =>
      db
        .prepare('UPDATE project_share_links SET token_hash = ? WHERE id = ?')
        .run(bare, 'share_c')
    ).toThrow(/SHARE_LINK_TOKEN_DOMAIN/);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM project_share_links').get()
    ).toEqual({ n: 1 });
  });
});

/**
 * Review of #1872, finding 3: the cutover that encrypts a project revokes
 * the links it finds. A link (or an Update) whose write reaches the
 * database after that must store nothing.
 */
describe('a link without history racing the project’s encryption', () => {
  /** Encrypts the project the moment the given write is about to run. */
  function racing(write: RegExp) {
    const document = ownerProject();
    const db = migratedDatabase();
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(
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
    let armed = false;
    let fired = 0;
    const env = {
      ENVIRONMENT: 'development' as const,
      AUTH_MODE: 'development' as const,
      ARTIFACTS: {} as R2Bucket,
      PROJECT_SHARING_ENABLED: 'true',
      DB: sqliteD1(db, {
        onStatement(sql) {
          if (!armed || !write.test(sql)) return;
          armed = false;
          fired += 1;
          // What the cutover's batch does to the project and its links.
          db.prepare('UPDATE projects SET storage_format = 2 WHERE id = ?').run(
            document.projectId
          );
          db.prepare(
            `UPDATE project_share_links SET revoked_at = MAX(?, created_at)
             WHERE project_id = ? AND revoked_at IS NULL`
          ).run(now(), document.projectId);
        }
      })
    };
    return {
      db,
      document,
      service: new D1R2PersistenceService(env),
      arm: () => (armed = true),
      fired: () => fired
    };
  }
  const models = (db: ReturnType<typeof migratedDatabase>) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM project_share_links
         WHERE frozen_document IS NOT NULL OR revoked_at IS NULL`
      )
      .get() as { n: number };

  it('stores no link when the project is encrypted before the insert', async () => {
    const { db, document, service, arm, fired } = racing(
      /INSERT INTO project_share_links/
    );
    arm();
    await expect(
      frozenLink(service, document, 'share_f', 'f')
    ).rejects.toBeInstanceOf(EncryptedProjectSharingError);
    expect(fired()).toBe(1);
    // No unrevoked row, and no plaintext model left beside the project.
    expect(models(db)).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM project_share_links').get()
    ).toEqual({ n: 0 });
  });

  it('stores no link to the live project then either', async () => {
    const { db, document, service, arm } = racing(
      /INSERT INTO project_share_links/
    );
    arm();
    await expect(
      service.createProjectShareLink(document.ownerUserId, document.projectId, {
        shareLinkId: 'share_l',
        mode: 'view',
        tokenHash: await hashProjectInvitationToken(token('l')),
        createdAt: now()
      })
    ).rejects.toBeInstanceOf(EncryptedProjectSharingError);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM project_share_links').get()
    ).toEqual({ n: 0 });
  });

  it('stores no model when the project is encrypted before an Update', async () => {
    const { db, document, service, arm, fired } = racing(
      /UPDATE project_share_links SET frozen_document/
    );
    await frozenLink(service, document, 'share_f', 'f');
    arm();
    await expect(
      service.updateProjectShareLinkSnapshot(
        document.ownerUserId,
        document.projectId,
        'share_f',
        frozenOf(document, 'Plate v2'),
        now()
      )
    ).rejects.toBeInstanceOf(EncryptedProjectSharingError);
    expect(fired()).toBe(1);
    // The cutover revoked the link and cleared its model; the late Update
    // put nothing back.
    expect(models(db)).toEqual({ n: 0 });
  });
});

/**
 * Review of #1872, finding 5: a commenter link without history shows none
 * of the project's comments, whose pins are on the live model.
 */
describe('comments through a link without history', () => {
  const anchor = { point: [1, 2, 3], documentVersion: 7 };

  async function commenting() {
    const { db, document, env, service } = database();
    await frozenLink(service, document, 'share_f', 'f', { comments: true });
    await service.createProjectShareLink(
      document.ownerUserId,
      document.projectId,
      {
        shareLinkId: 'share_l',
        mode: 'view',
        tokenHash: await hashProjectInvitationToken(token('l')),
        createdAt: now(),
        comments: true
      }
    );
    const visit = (seed: string, init?: RequestInit) =>
      worker.fetch(
        new Request('https://example.com/api/share/comments', {
          ...init,
          headers: { 'x-openzcad-share-token': token(seed) }
        }),
        env
      );
    const seen = async (seed: string) =>
      ((await (await visit(seed)).json()) as { comments: ProjectComment[] })
        .comments;
    const owner = {
      userId: document.ownerUserId,
      name: 'Owner',
      role: 'owner' as const
    };
    return { db, document, env, visit, seen, owner };
  }

  it('shows no pin of the project, only the threads started through the link', async () => {
    const { db, document, env, visit, seen, owner } = await commenting();
    // A member pins a body the frozen model never held, at a later version.
    const secret = await createProjectComment(
      env.DB,
      document.projectId,
      owner,
      {
        anchor: {
          point: [41, 42, 43],
          normal: [0, 0, 1],
          bodyId: 'body_private',
          documentVersion: 99
        } as never,
        text: 'PRIVATE_PIN_TEXT'
      }
    );
    await createProjectComment(env.DB, document.projectId, owner, {
      parentId: secret.commentId,
      text: 'PRIVATE_REPLY_TEXT'
    });
    const frozenRead = await visit('f');
    expect(frozenRead.status).toBe(200);
    const body = await frozenRead.text();
    expect(JSON.parse(body)).toEqual({ comments: [] });
    for (const leaked of ['PRIVATE', 'body_private', '41', '99'])
      expect(body).not.toContain(leaked);
    // A link that shares the project reads them as before.
    // (Sorted: comments made in the same millisecond list in id order.)
    expect((await seen('l')).map((comment) => comment.text).sort()).toEqual([
      'PRIVATE_PIN_TEXT',
      'PRIVATE_REPLY_TEXT'
    ]);

    // The visitor's own thread, pinned to the model they were shown.
    const posted = await visit('f', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sam', anchor, text: 'Chamfer this?' })
    });
    expect(posted.status).toBe(201);
    const { comment } = (await posted.json()) as { comment: ProjectComment };
    // The owner answers it; a member starts another thread meanwhile.
    await createProjectComment(env.DB, document.projectId, owner, {
      parentId: comment.commentId,
      text: 'Yes, 1 mm.'
    });
    await createProjectComment(env.DB, document.projectId, owner, {
      anchor: { point: [5, 5, 5], documentVersion: 100 } as never,
      text: 'PRIVATE_LATER'
    });
    expect((await seen('f')).map((entry) => entry.text).sort()).toEqual([
      'Chamfer this?',
      'Yes, 1 mm.'
    ]);
    // Another frozen link of the same project sees neither.
    const other = await hashFrozenShareLinkToken(token('g'));
    db.prepare(
      `INSERT INTO project_share_links
         (id, project_id, mode, token_hash, created_by_user_id, created_at,
          history, frozen_document, frozen_at, allow_comments)
       SELECT 'share_g', project_id, mode, ?, created_by_user_id, created_at,
              0, frozen_document, frozen_at, 1
       FROM project_share_links WHERE id = 'share_f'`
    ).run(other);
    expect(await seen('g')).toEqual([]);
  });

  it('takes no reply to a thread the link does not show', async () => {
    const { document, env, visit, seen, owner } = await commenting();
    const secret = await createProjectComment(
      env.DB,
      document.projectId,
      owner,
      { anchor: anchor as never, text: 'PRIVATE_PIN_TEXT' }
    );
    const reply = (seed: string, parentId: string) =>
      visit(seed, {
        method: 'POST',
        body: JSON.stringify({ name: 'Sam', parentId, text: 'Reply' })
      });
    const refused = await reply('f', secret.commentId);
    expect(refused.status).toBe(404);
    // The same answer as for an id that does not exist.
    const unknown = await reply('f', 'cmt_unknown');
    expect(unknown.status).toBe(404);
    expect(await refused.text()).toBe(await unknown.text());
    expect((await seen('l')).map((entry) => entry.text)).toEqual([
      'PRIVATE_PIN_TEXT'
    ]);
    // A link that shares the project still replies to it.
    expect((await reply('l', secret.commentId)).status).toBe(201);
  });
});
