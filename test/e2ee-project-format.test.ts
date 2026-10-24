import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import {
  cachedSchemaProbe,
  D1R2PersistenceService,
  ENCRYPTED_PROJECT_PLACEHOLDER_NAME,
  isProjectStorageFormatReady
} from '@openzcad/cloudflare-adapters';
import {
  isArtifactUploadAccountingReady,
  isD1ProjectStorageReady,
  isProjectObjectStorageReady
} from '../apps/web/worker/readiness';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  EncryptedProjectSharingError,
  ProjectFormatUnsupportedError
} from '@openzcad/persistence';
import {
  encodeProjectPreferences,
  fromBase64Url,
  macProjectPreferences,
  toBase64Url
} from '@openzcad/crypto';
import {
  ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE,
  ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE,
  ENCRYPTED_PROJECTS_REQUIRED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_MESSAGE,
  toProjectId,
  toUserId,
  type ListProjectsResponse,
  type ProjectDocument
} from '@openzcad/shared';
import { projectRouteFormatRule } from '../apps/web/worker/projectFormatGate';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

/** The Worker's development identity, and a member of the seeded project. */
const OWNER = toUserId('user_beta_dev');
const MEMBER = toUserId('user_member');
/** Stored where a document would be: anything that parses it fails loudly. */
const CIPHERTEXT = 'e2ee-v1:not-a-document';

function objectBucket() {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => {
      throw new Error('R2 must not be read for an encrypted project');
    }),
    head: vi.fn(async () => null),
    delete: vi.fn(async () => undefined)
  };
}

interface Seeded {
  db: ReturnType<typeof migratedDatabase>;
  projectId: string;
  plaintextId: string;
  service: D1R2PersistenceService;
  call(
    method: string,
    path: string,
    options?: { body?: unknown; user?: string; headers?: HeadersInit }
  ): Promise<Response>;
  room: ReturnType<typeof vi.fn>;
  bucket: ReturnType<typeof objectBucket>;
  env: Record<string, unknown>;
}

async function seed(extraEnv: Record<string, unknown> = {}): Promise<Seeded> {
  const db = migratedDatabase();
  for (const user of [OWNER, MEMBER]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.test`, '2026-10-24T00:00:00.000Z');
  }
  const service = new D1R2PersistenceService({
    DB: sqliteD1(db),
    PROJECT_SHARING_ENABLED: 'true'
  });
  const create = async (name: string) =>
    (
      await service.createProject(OWNER, {
        name,
        initialDocument: withoutDerivedProjection(
          createProjectDocument(name, OWNER)
        )
      })
    ).document;
  const encrypted = await create('Secret bracket');
  const plaintext = await create('Plain bracket');
  db.prepare(
    `INSERT INTO project_members
       (project_id, user_id, role, added_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'editor', ?, 1, 1)`
  ).run(encrypted.projectId, MEMBER, OWNER);
  // An invitation and a share link made while the project was plaintext.
  await service.createProjectInvitation(OWNER, encrypted.projectId, {
    invitationId: 'invite_seeded',
    email: 'invitee@example.test',
    role: 'viewer',
    tokenHash: 'invite-token-hash',
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });
  await service.createProjectShareLink(OWNER, encrypted.projectId, {
    shareLinkId: 'share_seeded',
    mode: 'view',
    tokenHash: 'share-token-hash',
    createdAt: Math.floor(Date.now() / 1000)
  });
  // No API path creates a format-2 project yet (ADR-024 slice 4-5): seed it.
  db.prepare(
    'UPDATE projects SET storage_format = 2, document_json = ? WHERE id = ?'
  ).run(CIPHERTEXT, encrypted.projectId);
  db.prepare(
    `INSERT INTO artifacts
       (id, project_id, kind, name, object_key, content_type, bytes, metadata_json, created_at)
     VALUES ('artifact_thumb', ?, 'thumbnail', 'thumb.png', 'thumbs/x', 'image/png', 3, '{}', '2026-10-24T00:00:00.000Z')`
  ).run(encrypted.projectId);
  const room = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  const bucket = objectBucket();
  const env = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db),
    PROJECT_STORAGE: bucket,
    ARTIFACTS: bucket,
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_ROOM: { getByName: vi.fn(() => ({ fetch: room })) },
    ...extraEnv
  };
  const call: Seeded['call'] = (method, path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.user) headers.set('x-openzcad-development-user', options.user);
    if (options.body !== undefined)
      headers.set('content-type', 'application/json');
    return worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) })
      }),
      env as never
    );
  };
  return {
    db,
    projectId: encrypted.projectId,
    plaintextId: plaintext.projectId,
    service,
    call,
    room,
    bucket,
    env
  };
}

/**
 * Every `/api/projects/:id…` route the Worker router declares, read from its
 * source, so a route added later is walked without editing this test.
 */
function workerProjectRoutes(): {
  name: string;
  source: string;
  path: string;
}[] {
  const source = readFileSync(
    new URL('../apps/web/worker/index.ts', import.meta.url),
    'utf8'
  );
  const routes: { name: string; source: string; path: string }[] = [];
  for (const match of source.matchAll(
    /const (\w+_ROUTE)\s*=\s*\/(.+)\/;\s*$/gm
  )) {
    const [, name, pattern] = match as unknown as [string, string, string];
    if (!pattern.startsWith('^\\/api\\/projects\\/')) continue;
    let index = 0;
    const path = pattern
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\\\//g, '/')
      .replace(/\(\[\^\/\]\+\)/g, () =>
        index++ === 0 ? '{project}' : `segment_${index}`
      );
    expect(
      new RegExp(pattern).test(path.replace('{project}', 'proj_x')),
      name
    ).toBe(true);
    routes.push({ name, source: pattern, path });
  }
  return routes;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('project storage format (ADR-024 Phase 4, slice 4-1)', () => {
  it('finds every project route in the Worker router', () => {
    const suffixes = workerProjectRoutes().map((route) =>
      route.path.replace('/api/projects/{project}', '')
    );
    for (const expected of [
      '',
      '/duplicate',
      '/revisions',
      '/revisions/segment_2',
      '/document',
      '/workspace-sessions',
      '/measurements',
      '/collaboration',
      '/collaboration/ticket',
      '/sharing',
      '/invitations',
      '/invitations/segment_2',
      '/members/segment_2',
      '/share-links',
      '/share-links/segment_2',
      '/artifacts'
    ]) {
      expect(suffixes).toContain(expected);
    }
  });

  it('refuses every document route of an encrypted project, for every method', async () => {
    const refusals: string[] = [];
    for (const route of workerProjectRoutes()) {
      for (const method of METHODS) {
        const { call, projectId, room, bucket } = await seed();
        const path = route.path.replace('{project}', projectId);
        const rule = projectRouteFormatRule(method, path)!;
        expect(rule.projectId).toBe(projectId);
        if (rule.rule === 'metadata') continue;
        const response = await call(
          method,
          path,
          method === 'GET' ? {} : { body: {} }
        );
        const body = (await response.json()) as {
          code?: string;
          error?: string;
        };
        expect(response.status, `${method} ${route.path}`).toBe(409);
        expect(body.code, `${method} ${route.path}`).toBe(
          rule.rule === 'share'
            ? ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE
            : PROJECT_FORMAT_UNSUPPORTED_CODE
        );
        if (body.code === PROJECT_FORMAT_UNSUPPORTED_CODE) {
          expect(body.error).toBe(PROJECT_FORMAT_UNSUPPORTED_MESSAGE);
        }
        expect(
          room,
          `${method} ${route.path} reached the room`
        ).not.toHaveBeenCalled();
        expect(bucket.get).not.toHaveBeenCalled();
        refusals.push(`${method} ${route.path}`);
      }
    }
    // The routes that do handle documents are among them.
    for (const expected of [
      'GET /api/projects/{project}',
      'POST /api/projects/{project}/duplicate',
      'POST /api/projects/{project}/revisions',
      'GET /api/projects/{project}/revisions',
      'GET /api/projects/{project}/revisions/segment_2',
      'PUT /api/projects/{project}/document',
      'GET /api/projects/{project}/workspace-sessions',
      'PUT /api/projects/{project}/workspace-sessions',
      'GET /api/projects/{project}/measurements',
      'PUT /api/projects/{project}/measurements',
      'DELETE /api/projects/{project}/measurements',
      'GET /api/projects/{project}/collaboration',
      'POST /api/projects/{project}/collaboration',
      'POST /api/projects/{project}/collaboration/ticket',
      'POST /api/projects/{project}/invitations',
      'POST /api/projects/{project}/share-links',
      'GET /api/projects/{project}/artifacts'
    ]) {
      expect(refusals).toContain(expected);
    }
    // One freshly migrated database per request: slow under a loaded suite.
  }, 120_000);

  it('keeps metadata routes working and lists the project without reading it', async () => {
    const { call, projectId } = await seed();
    const listed = (await (
      await call('GET', '/api/projects')
    ).json()) as ListProjectsResponse;
    const summary = listed.projects.find(
      (project) => project.projectId === projectId
    );
    expect(summary).toMatchObject({
      projectId,
      name: ENCRYPTED_PROJECT_PLACEHOLDER_NAME,
      storageFormat: 2
    });
    // Its thumbnail is not an image an older browser can show.
    expect(summary).not.toHaveProperty('thumbnailArtifactId');
    expect(
      listed.projects.find((project) => project.projectId !== projectId)
    ).not.toHaveProperty('storageFormat');

    const archived = await call('PATCH', `/api/projects/${projectId}`, {
      body: { status: 'archived' }
    });
    expect(archived.status).toBe(200);
    expect(
      ((await archived.json()) as { project: { storageFormat?: number } })
        .project.storageFormat
    ).toBe(2);
    expect(
      (await call('GET', `/api/projects/${projectId}/sharing`)).status
    ).toBe(200);
    expect(
      (await call('GET', `/api/projects/${projectId}/share-links`)).status
    ).toBe(200);
    expect(
      (
        await call(
          'DELETE',
          `/api/projects/${projectId}/share-links/share_seeded`
        )
      ).status
    ).toBe(204);
    expect(
      (await call('DELETE', `/api/projects/${projectId}/members/${MEMBER}`))
        .status
    ).toBe(204);
    expect((await call('DELETE', `/api/projects/${projectId}`)).status).toBe(
      204
    );
  });

  it('answers an outsider with the same 404 as a missing project', async () => {
    const { call, projectId } = await seed();
    const response = await call('GET', `/api/projects/${projectId}`, {
      user: 'user_stranger'
    });
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty('code');
  });

  it('refuses a member room ticket as sharing, and the owner’s as unreadable', async () => {
    const { call, projectId, room } = await seed();
    const member = await call(
      'POST',
      `/api/projects/${projectId}/collaboration/ticket`,
      { user: MEMBER, body: {} }
    );
    expect(member.status).toBe(409);
    expect(((await member.json()) as { code: string }).code).toBe(
      ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE
    );
    const owner = await call(
      'POST',
      `/api/projects/${projectId}/collaboration/ticket`,
      { body: {} }
    );
    expect(((await owner.json()) as { code: string }).code).toBe(
      PROJECT_FORMAT_UNSUPPORTED_CODE
    );
    expect(room).not.toHaveBeenCalled();
  });

  it('does not forward a ticketed socket for an encrypted project', async () => {
    const seeded = await seed({
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AUTH_OTP_PEPPER: 'pepper'
    });
    const socket = (id: string) =>
      seeded.call(
        'GET',
        `/api/projects/${id}/collaboration?ticket=${'a'.repeat(43)}`,
        { headers: { upgrade: 'websocket' } }
      );
    expect((await socket(seeded.projectId)).status).toBe(401);
    expect(seeded.room).not.toHaveBeenCalled();
    // The same request for a plaintext project reaches the room.
    await socket(seeded.plaintextId);
    expect(seeded.room).toHaveBeenCalledTimes(1);
  });

  it('guards every document method of the persistence service itself', async () => {
    const { service, projectId } = await seed();
    const id = toProjectId(projectId);
    const document = { projectId, ownerUserId: OWNER } as ProjectDocument;
    const unsupported = [
      service.loadProject(OWNER, projectId),
      service.loadRevision(OWNER, projectId, 'rev_x'),
      service.listRevisions(OWNER, projectId),
      service.listArtifacts(OWNER, projectId),
      service.saveDocument(OWNER, {
        projectId: id,
        document,
        expectedVersion: 1
      }),
      service.saveRevision(OWNER, {
        projectId: id,
        document,
        expectedVersion: 1,
        reason: 'x'
      }),
      service.storeCollaborationCheckpoint(
        OWNER,
        document,
        async () => undefined,
        async () => true
      ),
      service.discardMeshPayload(OWNER, projectId, 'artifact_x'),
      service.duplicateProject(OWNER, { projectId: id }),
      service.loadProjectCopyState(OWNER, id)
    ];
    for (const attempt of unsupported) {
      await expect(attempt).rejects.toBeInstanceOf(
        ProjectFormatUnsupportedError
      );
    }
    for (const attempt of [
      service.createProjectInvitation(OWNER, projectId, {
        invitationId: 'invite_new',
        email: 'new@example.test',
        role: 'viewer',
        tokenHash: 'new-token-hash',
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      }),
      service.createProjectShareLink(OWNER, projectId, {
        shareLinkId: 'share_new',
        mode: 'view',
        tokenHash: 'new-share-hash',
        createdAt: Math.floor(Date.now() / 1000)
      }),
      service.acceptProjectInvitation(
        MEMBER,
        'invitee@example.test',
        'invite-token-hash',
        Math.floor(Date.now() / 1000)
      )
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(
        EncryptedProjectSharingError
      );
    }
    // An existing share link serves nothing; it is not an oracle either.
    await expect(
      service.loadSharedProjectByTokenHash('share-token-hash')
    ).resolves.toBeNull();
    await expect(
      service.loadSharedProjectAsset('share-token-hash', 'asset_x')
    ).resolves.toBeNull();
  });

  it('refuses the artifact and upload routes that sit outside /api/projects/:id', async () => {
    const { call, db, projectId } = await seed();
    // An upload session opened while the project was still plaintext.
    db.prepare('UPDATE projects SET storage_format = 1 WHERE id = ?').run(
      projectId
    );
    const opened = await call('POST', '/api/uploads', {
      user: OWNER,
      body: {
        projectId,
        fileName: 'part.step',
        contentType: 'model/step',
        kind: 'step-export'
      }
    });
    expect(opened.status).toBe(201);
    const { session } = (await opened.json()) as {
      session: { uploadSessionId: string; artifactId: string };
    };
    db.prepare('UPDATE projects SET storage_format = 2 WHERE id = ?').run(
      projectId
    );
    const refused = async (response: Response, label: string) => {
      expect(response.status, label).toBe(409);
      expect(((await response.json()) as { code: string }).code, label).toBe(
        PROJECT_FORMAT_UNSUPPORTED_CODE
      );
    };
    // A retained artifact id reads none of the project's earlier artifacts.
    for (const user of [OWNER, MEMBER]) {
      for (const path of [
        '/api/artifacts/artifact_thumb',
        '/api/artifacts/artifact_thumb/download'
      ])
        await refused(await call('GET', path, { user }), `${user} ${path}`);
    }
    // No new plaintext upload, and none through a session opened earlier.
    await refused(
      await call('POST', '/api/uploads', {
        user: OWNER,
        body: {
          projectId,
          fileName: 'more.step',
          contentType: 'model/step',
          kind: 'step-export'
        }
      }),
      'create upload'
    );
    await refused(
      await call('PUT', `/api/uploads/${session.uploadSessionId}/content`, {
        user: OWNER,
        body: 'png'
      }),
      'upload content'
    );
    await refused(
      await call('POST', '/api/artifacts/finalize', {
        user: OWNER,
        body: {
          projectId,
          artifactId: session.artifactId,
          uploadSessionId: session.uploadSessionId
        }
      }),
      'finalize'
    );
  });

  it('lists a project in a format this build does not know as locked', async () => {
    const { call, db, plaintextId } = await seed();
    // A later migration may add a format; this build must still show it.
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE projects SET storage_format = 3 WHERE id = ?').run(
      plaintextId
    );
    const response = await call('GET', '/api/projects', { user: OWNER });
    expect(response.status).toBe(200);
    const { projects } = (await response.json()) as {
      projects: { projectId: string; storageFormat?: number; name: string }[];
    };
    const listed = projects.find((p) => p.projectId === plaintextId);
    expect(listed).toMatchObject({ storageFormat: 3 });
    expect(listed?.name).not.toBe('Plain bracket');
  });

  it('refuses a member role change as sharing', async () => {
    const { call, projectId, service } = await seed();
    const response = await call(
      'PATCH',
      `/api/projects/${projectId}/members/${MEMBER}`,
      { user: OWNER, body: { role: 'viewer' } }
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(
      ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE
    );
    // The persistence service refuses it too, whoever calls it.
    await expect(
      service.updateProjectMemberRole(
        OWNER,
        projectId,
        toUserId(MEMBER),
        'editor',
        2
      )
    ).rejects.toMatchObject({
      code: ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE
    });
  });

  it('fails closed and caches nothing when a schema probe errors', async () => {
    const probe = cachedSchemaProbe(
      'SELECT 1 AS ready',
      (row) => row?.ready === 1
    );
    let failing = true;
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            if (failing) throw new Error('D1 is briefly unavailable');
            return { ready: 1 };
          }
        })
      })
    } as unknown as Parameters<typeof probe>[0];
    // An error is not "column missing": a format-sensitive caller must not
    // read an encrypted row as plaintext on the strength of it.
    await expect(probe(db)).rejects.toThrow('briefly unavailable');
    failing = false;
    await expect(probe(db)).resolves.toBe(true);
  });

  it('refuses invitations and share links on the HTTP routes as sharing', async () => {
    const { call, projectId } = await seed({
      PROJECT_INVITATION_EMAIL_FROM: 'invites@example.test',
      PUBLIC_APP_ORIGIN: 'https://example.com',
      EMAIL: { send: vi.fn() }
    });
    for (const [path, body] of [
      [
        `/api/projects/${projectId}/invitations`,
        { email: 'x@example.test', role: 'viewer' }
      ],
      [`/api/projects/${projectId}/share-links`, { mode: 'view' }]
    ] as const) {
      const response = await call('POST', path, { body });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe(
        ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE
      );
    }
  });
});

describe('encrypted projects required (decision D2)', () => {
  const projectsOn = {
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true'
  };

  function optIn(
    db: ReturnType<typeof migratedDatabase>,
    encryptNewProjects: boolean
  ) {
    db.prepare(
      `INSERT INTO e2ee_project_preferences
         (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
       VALUES (?, ?, 'cmVjb3Jk', ?, 1, '2026-10-24T00:00:00.000Z')`
    ).run(OWNER, encryptNewProjects ? 1 : 0, 'A'.repeat(43));
  }

  const createBody = () => ({
    name: 'New part',
    initialDocument: withoutDerivedProjection(
      createProjectDocument('New part', OWNER)
    )
  });

  it('refuses plaintext create, adopt and duplicate once the account opts in', async () => {
    const { call, db, plaintextId } = await seed(projectsOn);
    optIn(db, true);
    for (const [path, body] of [
      ['/api/projects', createBody()],
      [
        '/api/projects',
        {
          name: 'Adopted',
          adoptionProtocolVersion: 2,
          localProjectId: 'proj_local',
          document: createProjectDocument('Adopted', OWNER)
        }
      ],
      [`/api/projects/${plaintextId}/duplicate`, {}]
    ] as const) {
      const response = await call('POST', path, { body });
      expect(response.status, path).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe(
        ENCRYPTED_PROJECTS_REQUIRED_CODE
      );
    }
  });

  it('creates plaintext projects while the account has not opted in', async () => {
    const off = await seed();
    expect(
      (await off.call('POST', '/api/projects', { body: createBody() })).status
    ).toBe(201);
    const notOptedIn = await seed(projectsOn);
    optIn(notOptedIn.db, false);
    expect(
      (await notOptedIn.call('POST', '/api/projects', { body: createBody() }))
        .status
    ).toBe(201);
  });

  it('refuses a plaintext insert in the same write, however it races the opt-in', async () => {
    // The Worker's own check reads the opt-in first; migration 0031's trigger
    // refuses the insert itself, so a preference written between that read
    // and the insert (or a path that skips the read, as with the flag off)
    // still stores no plaintext project for an opted-in account.
    for (const env of [{}, { E2EE_KEYS_ENABLED: 'true' }, projectsOn]) {
      const { call, db, plaintextId } = await seed(env);
      const owned = () =>
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?')
            .get(OWNER) as { n: number }
        ).n;
      const before = owned();
      optIn(db, true);
      for (const [path, body] of [
        ['/api/projects', createBody()],
        [`/api/projects/${plaintextId}/duplicate`, {}]
      ] as const) {
        const response = await call('POST', path, { body });
        expect(response.status, `${path} ${JSON.stringify(env)}`).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe(
          ENCRYPTED_PROJECTS_REQUIRED_CODE
        );
      }
      expect(owned()).toBe(before);
    }
  });
});

describe('assistant on encrypted projects (decision D7)', () => {
  it('refuses a proposal for an encrypted project before calling a provider', async () => {
    const { call, projectId, plaintextId } = await seed({
      AI_API_KEY: 'test-key'
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const proposal = (id: string) => ({
        prompt: 'Make it thicker',
        digest: {
          schemaVersion: 1,
          projectId: id,
          name: 'x',
          units: 'mm',
          version: 1,
          parameters: [],
          features: [],
          warnings: []
        }
      });
      const refused = await call('POST', '/api/assistant/proposals', {
        body: proposal(projectId)
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe(
        ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      // A plaintext project is not refused by this check.
      const plain = await call('POST', '/api/assistant/proposals', {
        body: proposal(plaintextId)
      });
      expect(plain.status).not.toBe(409);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('the "encrypt new projects" record routes', () => {
  const projectsOn = {
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true'
  };
  const ACCOUNT_KEY = new Uint8Array(32).fill(7);

  async function record(
    sequence: number,
    encryptNewProjects = true,
    userId: string = OWNER
  ) {
    const bytes = encodeProjectPreferences({
      userId,
      encryptNewProjects,
      sequence
    });
    return {
      record: toBase64Url(bytes),
      recordMac: toBase64Url(await macProjectPreferences(ACCOUNT_KEY, bytes))
    };
  }

  it('stays closed and reports disabled until E2EE_PROJECTS_ENABLED is set', async () => {
    const keysOnly = await seed({ E2EE_KEYS_ENABLED: 'true' });
    expect(
      await (await keysOnly.call('GET', '/api/e2ee/config')).json()
    ).toEqual({ enabled: true, projectsEnabled: false });
    expect(
      (await keysOnly.call('GET', '/api/e2ee/project-preferences')).status
    ).toBe(501);
    // The projects flag alone opens nothing without the key routes.
    const projectsOnly = await seed({ E2EE_PROJECTS_ENABLED: 'true' });
    expect(
      await (await projectsOnly.call('GET', '/api/e2ee/config')).json()
    ).toEqual({ enabled: false, projectsEnabled: false });
    const open = await seed(projectsOn);
    expect(await (await open.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true
    });
  });

  it('reports disabled while migration 0031 is missing', async () => {
    const open = await seed(projectsOn);
    open.db.exec('DROP TABLE e2ee_project_preferences');
    expect(await (await open.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: false
    });
  });

  it('stores a forward-moving record for this account only', async () => {
    const { call } = await seed(projectsOn);
    expect(
      await (await call('GET', '/api/e2ee/project-preferences')).json()
    ).toEqual({ preference: null });
    const first = await call('PUT', '/api/e2ee/project-preferences', {
      body: await record(1)
    });
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { preference: unknown }).preference
    ).toMatchObject({ encryptNewProjects: true, sequence: 1 });
    // Replayed, or older: refused with the stored record.
    const replay = await call('PUT', '/api/e2ee/project-preferences', {
      body: await record(1, false)
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: 'E2EE_PREFERENCE_STALE',
      preference: { sequence: 1, encryptNewProjects: true }
    });
    const other = await call('PUT', '/api/e2ee/project-preferences', {
      body: await record(2, true, 'user_someone_else')
    });
    expect(other.status).toBe(400);
    const tampered = await record(2);
    const noncanonical = await call('PUT', '/api/e2ee/project-preferences', {
      body: {
        ...tampered,
        record: toBase64Url(
          new TextEncoder().encode(
            ` ${new TextDecoder().decode(fromBase64Url(tampered.record))}`
          )
        )
      }
    });
    expect(noncanonical.status).toBe(400);
    const second = await call('PUT', '/api/e2ee/project-preferences', {
      body: await record(2, false)
    });
    expect(second.status).toBe(200);
    expect(
      await (await call('GET', '/api/e2ee/project-preferences')).json()
    ).toMatchObject({ preference: { sequence: 2, encryptNewProjects: false } });
  });

  it('fences writes during erasure and erases the record with the profile', async () => {
    const { call, db } = await seed(projectsOn);
    expect(
      (
        await call('PUT', '/api/e2ee/project-preferences', {
          body: await record(1)
        })
      ).status
    ).toBe(200);
    const deleted = await call('POST', '/api/account/delete-data', {
      body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
    });
    expect(deleted.status).toBe(200);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM e2ee_project_preferences').get()
    ).toEqual({ n: 0 });
    db.prepare(
      'INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, ?, 1, 1)'
    ).run(OWNER, 'profile');
    expect(() =>
      db
        .prepare(
          `INSERT INTO e2ee_project_preferences
             (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
           VALUES (?, 1, 'x', ?, 5, 'now')`
        )
        .run(OWNER, 'A'.repeat(43))
    ).toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
  });

  it('never moves a stored sequence backwards, whoever writes', () => {
    const db = migratedDatabase();
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(OWNER, null, 'now');
    db.prepare(
      `INSERT INTO e2ee_project_preferences
         (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
       VALUES (?, 1, 'x', ?, 3, 'now')`
    ).run(OWNER, 'A'.repeat(43));
    expect(() =>
      db
        .prepare(
          'UPDATE e2ee_project_preferences SET sequence = 2 WHERE user_id = ?'
        )
        .run(OWNER)
    ).toThrow(/E2EE_PREFERENCE_SEQUENCE/);
  });
});

describe('migration 0031', () => {
  it('adds storage_format 1 by default and accepts only 1 or 2', () => {
    const db = migratedDatabase();
    const column = db
      .prepare(
        "SELECT dflt_value, \"notnull\" FROM pragma_table_info('projects') WHERE name = 'storage_format'"
      )
      .get() as { dflt_value: string; notnull: number };
    expect(column).toEqual({ dflt_value: '1', notnull: 1 });
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(OWNER, null, 'now');
    db.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at)
       VALUES ('proj_m', ?, 'n', '{}', 'now')`
    ).run(OWNER);
    expect(
      db
        .prepare("SELECT storage_format FROM projects WHERE id = 'proj_m'")
        .get()
    ).toEqual({ storage_format: 1 });
    expect(() =>
      db
        .prepare("UPDATE projects SET storage_format = 3 WHERE id = 'proj_m'")
        .run()
    ).toThrow(/CHECK/);
    db.prepare(
      "UPDATE projects SET storage_format = 2 WHERE id = 'proj_m'"
    ).run();
    // The opt-in goes with its user.
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO e2ee_project_preferences
         (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
       VALUES (?, 1, 'x', ?, 1, 'now')`
    ).run(OWNER, 'A'.repeat(43));
    db.prepare("DELETE FROM projects WHERE id = 'proj_m'").run();
    db.prepare('DELETE FROM users WHERE id = ?').run(OWNER);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM e2ee_project_preferences').get()
    ).toEqual({ n: 0 });
  });
});

/** Every tracked migration before `number`, as `pnpm deploy:beta` may leave D1. */
function databaseBefore(number: number) {
  const dir = new URL('../apps/web/migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith('.sql') && Number.parseInt(name.slice(0, 4), 10) < number
    )
    .sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return db;
}

/**
 * Merging runs `deploy:beta`, which applies migrations to the live database.
 * If 0031 fails or is delayed, ordinary project traffic must not notice:
 * every project is plaintext, no statement names the missing column, and
 * encrypted projects stay closed.
 */
describe('without migration 0031', () => {
  function unmigrated() {
    const db = databaseBefore(31);
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(OWNER, `${OWNER}@example.test`, '2026-10-24T00:00:00.000Z');
    const statements: string[] = [];
    const room = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const objects = new Map<string, ArrayBuffer>();
    const bucket = {
      put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array) => {
        objects.set(key, new Uint8Array(body).slice().buffer);
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
      delete: vi.fn(async () => undefined)
    };
    const env = {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development',
      DB: sqliteD1(db, { onStatement: (sql) => statements.push(sql) }),
      ARTIFACTS: bucket,
      PROJECT_SHARING_ENABLED: 'true',
      PROJECT_PERSONAL_SYNC_ENABLED: 'true',
      PROJECT_ROOM: { getByName: vi.fn(() => ({ fetch: room })) },
      E2EE_KEYS_ENABLED: 'true',
      E2EE_PROJECTS_ENABLED: 'true'
    };
    const call = (method: string, path: string, body?: unknown) =>
      worker.fetch(
        new Request(`https://example.com${path}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
              })
        }),
        env as never
      );
    return { db, statements, room, call };
  }

  /** The only statements allowed to name the column are the schema probes. */
  function expectNoStorageFormatQueries(statements: string[]) {
    const naming = statements.filter((sql) => sql.includes('storage_format'));
    expect(naming.length).toBeGreaterThan(0);
    for (const sql of naming) {
      expect(sql, sql).toMatch(/pragma_table_info\('projects'\)/);
      expect(sql).not.toMatch(/FROM projects\b|UPDATE projects|JOIN projects/);
    }
  }

  it('keeps create, load, save, list, share, uploads and the room ticket working', async () => {
    const { call, statements, room } = unmigrated();
    const created = await call('POST', '/api/projects', {
      name: 'Bracket',
      initialDocument: withoutDerivedProjection(
        createProjectDocument('Bracket', OWNER)
      )
    });
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as {
      document: ProjectDocument;
    };
    const id = document.projectId;

    expect((await call('GET', `/api/projects/${id}`)).status).toBe(200);
    const saved = await call('PUT', `/api/projects/${id}/document`, {
      projectId: id,
      expectedVersion: document.version,
      document: { ...document, version: document.version + 1 }
    });
    expect(saved.status).toBe(200);

    const listed = (await (
      await call('GET', '/api/projects')
    ).json()) as ListProjectsResponse;
    const summary = listed.projects.find((project) => project.projectId === id);
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('storageFormat');

    for (const path of [
      `/api/projects/${id}/revisions`,
      `/api/projects/${id}/workspace-sessions`,
      `/api/projects/${id}/measurements`,
      `/api/projects/${id}/artifacts`
    ]) {
      expect((await call('GET', path)).status, path).toBe(200);
    }
    expect(
      (
        await call('POST', '/api/uploads', {
          kind: 'thumbnail',
          projectId: id,
          fileName: 'thumb.webp',
          contentType: 'image/webp'
        })
      ).status
    ).toBe(201);

    const link = await call('POST', `/api/projects/${id}/share-links`, {
      mode: 'view'
    });
    expect(link.status).toBe(201);
    const { token } = (await link.json()) as { token: string };
    expect((await call('GET', `/api/share/${token}`)).status).toBe(200);

    const ticket = await call(
      'POST',
      `/api/projects/${id}/collaboration/ticket`,
      {}
    );
    expect(ticket.status).toBe(200);
    expect(room).toHaveBeenCalledTimes(1);

    expect(
      (await call('POST', `/api/projects/${id}/duplicate`, {})).status
    ).toBe(201);
    expectNoStorageFormatQueries(statements);
  });

  it('reports encrypted projects off, refuses the opt-in routes and never requires them', async () => {
    const { call, statements } = unmigrated();
    expect(await (await call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: false
    });
    expect((await call('GET', '/api/e2ee/project-preferences')).status).toBe(
      503
    );
    // No opt-in can exist, so plaintext creation is never refused (D2).
    expect(
      (
        await call('POST', '/api/projects', {
          name: 'Part',
          initialDocument: withoutDerivedProjection(
            createProjectDocument('Part', OWNER)
          )
        })
      ).status
    ).toBe(201);
    expectNoStorageFormatQueries(statements);
  });

  it('passes the format guards for every project', async () => {
    const { db } = unmigrated();
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_SHARING_ENABLED: 'true'
    });
    const { document } = await service.createProject(OWNER, {
      name: 'Guarded',
      initialDocument: withoutDerivedProjection(
        createProjectDocument('Guarded', OWNER)
      )
    });
    const access = await service.requireProjectRead(OWNER, document.projectId);
    expect(access).not.toHaveProperty('storageFormat');
    await expect(
      service.loadProject(OWNER, document.projectId)
    ).resolves.toMatchObject({ projectId: document.projectId });
  });

  it('keeps project and upload storage ready', async () => {
    const db = sqliteD1(databaseBefore(31));
    const bucket = {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn()
    } as unknown as R2Bucket;
    await expect(isProjectObjectStorageReady(db, bucket)).resolves.toBe(true);
    await expect(isArtifactUploadAccountingReady(db)).resolves.toBe(true);
    await expect(isD1ProjectStorageReady(db)).resolves.toBe(true);
  });

  it('notices the column once the migration lands, without a redeploy', async () => {
    const db = databaseBefore(31);
    const d1 = sqliteD1(db);
    await expect(isProjectStorageFormatReady(d1)).resolves.toBe(false);
    db.exec(
      readFileSync(
        new URL(
          '../apps/web/migrations/0031_project_storage_format.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    // Still read as missing for the rest of the minute, then found and kept.
    await expect(isProjectStorageFormatReady(d1)).resolves.toBe(false);
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    try {
      await expect(isProjectStorageFormatReady(d1)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
