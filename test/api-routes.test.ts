import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { getInMemoryPersistence } from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import {
  DEFAULT_APP_SETTINGS,
  MAX_ARTIFACT_UPLOAD_PARTS,
  MAX_PROJECT_NAME_LENGTH,
  projectOrganization,
  toUserId,
  type CreateProjectResponse,
  type ProjectDocument,
  type ProjectSummary
} from '@openzcad/shared';

const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_ROOM: {
    getByName: vi.fn()
  }
};

interface StorageAccountingReadinessRow {
  projects_document_bytes: number;
  revisions_document_bytes: number;
  revisions_bytes_index: number;
}

interface ProjectObjectStorageReadinessRow {
  project_columns: number;
  revision_pointer: number;
  document_objects_table: number;
  storage_assets_table: number;
  document_objects_index: number;
  storage_assets_index: number;
  pointer_indexes: number;
}

interface ProjectMeasurementReadinessRow {
  table_ready: number;
  columns_ready: number;
  cascade_ready: number;
  erasure_triggers: number;
}

const READY_STORAGE_ACCOUNTING_SCHEMA: StorageAccountingReadinessRow = {
  projects_document_bytes: 1,
  revisions_document_bytes: 1,
  revisions_bytes_index: 1
};

const READY_PROJECT_OBJECT_STORAGE_SCHEMA: ProjectObjectStorageReadinessRow = {
  project_columns: 3,
  revision_pointer: 1,
  document_objects_table: 1,
  storage_assets_table: 1,
  document_objects_index: 1,
  storage_assets_index: 1,
  pointer_indexes: 2
};

const READY_PROJECT_MEASUREMENT_SCHEMA: ProjectMeasurementReadinessRow = {
  table_ready: 1,
  columns_ready: 5,
  cascade_ready: 1,
  erasure_triggers: 2
};

const readyProjectStorageBucket = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn()
} as unknown as R2Bucket;

function storageAccountingDb(
  row: StorageAccountingReadinessRow | null = READY_STORAGE_ACCOUNTING_SCHEMA,
  failure?: Error,
  projectObjectRow: ProjectObjectStorageReadinessRow | null = READY_PROJECT_OBJECT_STORAGE_SCHEMA,
  projectMeasurementRow: ProjectMeasurementReadinessRow | null = READY_PROJECT_MEASUREMENT_SCHEMA
) {
  const prepare = vi.fn((query: string) => ({
    first: vi.fn(async () => {
      if (failure) {
        throw failure;
      }
      if (query.includes('idx_project_document_objects_project_state')) {
        return projectObjectRow;
      }
      if (query.includes("pragma_table_info('project_measurements')")) {
        return projectMeasurementRow;
      }
      if (query.includes('account_erasure_requests')) {
        return { table_ready: 1, trigger_count: 25 };
      }
      return row;
    })
  }));
  return {
    db: { prepare } as unknown as D1Database,
    prepare
  };
}

function projectMeasurementRouteDb() {
  let measurement: { payloadJson: string; revision: number } | null = null;
  const prepare = vi.fn((query: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first() {
        if (query.includes('idx_project_document_objects_project_state')) {
          return READY_PROJECT_OBJECT_STORAGE_SCHEMA;
        }
        if (query.includes("pragma_table_info('project_measurements')")) {
          return READY_PROJECT_MEASUREMENT_SCHEMA;
        }
        if (query.includes('FROM account_erasure_requests')) {
          return null;
        }
        if (query.includes('user_id AS owner_user_id')) {
          return { owner_user_id: 'user_beta_dev' };
        }
        if (query.includes('SELECT payload_json')) {
          return measurement
            ? {
                payload_json: measurement.payloadJson,
                revision: measurement.revision
              }
            : null;
        }
        if (query.includes('SELECT revision')) {
          return measurement ? { revision: measurement.revision } : null;
        }
        return READY_STORAGE_ACCOUNTING_SCHEMA;
      },
      async run() {
        if (query.includes('INSERT INTO project_measurements')) {
          if (measurement) return { meta: { changes: 0 } };
          measurement = { payloadJson: String(values[2]), revision: 1 };
          return { meta: { changes: 1 } };
        }
        if (query.includes('UPDATE project_measurements')) {
          if (!measurement || measurement.revision !== Number(values[5])) {
            return { meta: { changes: 0 } };
          }
          measurement = {
            payloadJson: String(values[2]),
            revision: Number(values[1])
          };
          return { meta: { changes: 1 } };
        }
        if (query.includes('DELETE FROM project_measurements')) {
          if (!measurement || measurement.revision !== Number(values[1])) {
            return { meta: { changes: 0 } };
          }
          measurement = null;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
    };
    return statement;
  });
  return { prepare } as unknown as D1Database;
}

function withEnabledDeploymentAssistant<T extends Record<string, unknown>>(
  overrides: T
) {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.assistant.enabled = true;
  const DB = {
    prepare(query: string) {
      return {
        bind() {
          return {
            async first() {
              if (query.includes('FROM auth_sessions')) {
                return {
                  user_id: 'user_allowed_test',
                  email: 'allowed@example.com',
                  expires_at: 4_000_000_000
                };
              }
              return query.includes('FROM user_settings')
                ? {
                    settings_json: JSON.stringify(settings),
                    revision: 1
                  }
                : null;
            }
          };
        }
      };
    }
  };
  return { ...env, ...overrides, DB } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(path: string, body: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

function patch(path: string, body: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}

function put(path: string, body: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

function settingsConflictEnv(options: {
  storedRevision: number;
  changes: number;
}) {
  const run = vi.fn(async () => ({ meta: { changes: options.changes } }));
  const prepare = vi.fn((query: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () =>
        query.includes('FROM user_settings')
          ? {
              settings_json: JSON.stringify(DEFAULT_APP_SETTINGS),
              revision: options.storedRevision
            }
          : null
      ),
      run
    }))
  }));
  return {
    workerEnv: { ...env, DB: { prepare } } as never,
    prepare,
    run
  };
}

async function createProject(name: string): Promise<CreateProjectResponse> {
  const response = await worker.fetch(post('/api/projects', { name }), env);
  expect(response.status).toBe(201);
  return (await response.json()) as CreateProjectResponse;
}

describe('worker api routes', () => {
  it('creates and lists projects', async () => {
    const created = await createProject('Worker Test');

    const listResponse = await worker.fetch(
      new Request('https://example.com/api/projects'),
      env
    );
    const listed = (await listResponse.json()) as {
      projects: Array<{ projectId: string }>;
    };
    expect(
      listed.projects.some(
        (project) => project.projectId === created.project.projectId
      )
    ).toBe(true);
  });

  it('duplicates, archives, bins, restores, and destroys a project', async () => {
    const created = await createProject('Shelf Test');
    const projectId = created.project.projectId;

    const duplicated = await worker.fetch(
      post(`/api/projects/${projectId}/duplicate`, {}),
      env
    );
    expect(duplicated.status).toBe(201);
    const copy = (await duplicated.json()) as CreateProjectResponse;
    expect(copy.project.projectId).not.toBe(projectId);
    expect(copy.project.name).toBe('Shelf Test (copy)');

    const archived = await worker.fetch(
      patch(`/api/projects/${projectId}`, { status: 'archived' }),
      env
    );
    expect(archived.status).toBe(200);
    const { project: archivedProject } = (await archived.json()) as {
      project: ProjectSummary;
    };
    expect(projectOrganization(archivedProject).status).toBe('archived');
    expect(projectOrganization(archivedProject).archivedAt).toBeTruthy();

    const binned = await worker.fetch(
      patch(`/api/projects/${projectId}`, { status: 'deleted', pinned: true }),
      env
    );
    const { project: binnedProject } = (await binned.json()) as {
      project: ProjectSummary;
    };
    expect(projectOrganization(binnedProject).status).toBe('deleted');
    expect(projectOrganization(binnedProject).pinned).toBe(true);
    // Binning hides a project; it must still load until it is purged.
    expect(
      (
        await worker.fetch(
          new Request(`https://example.com/api/projects/${projectId}`),
          env
        )
      ).status
    ).toBe(200);

    const destroyed = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${copy.project.projectId}`,
        {
          method: 'DELETE'
        }
      ),
      env
    );
    expect(destroyed.status).toBe(204);
    expect(
      (
        await worker.fetch(
          new Request(
            `https://example.com/api/projects/${copy.project.projectId}`
          ),
          env
        )
      ).status
    ).toBe(404);
  });

  it('reorders projects and reads "reorder" as a route rather than a project id', async () => {
    const first = await createProject('Order A');
    const second = await createProject('Order B');

    const response = await worker.fetch(
      post('/api/projects/reorder', {
        projectIds: [second.project.projectId, first.project.projectId]
      }),
      env
    );
    expect(response.status).toBe(200);
    const { projects } = (await response.json()) as {
      projects: ProjectSummary[];
    };
    const ordered = projects
      .filter((project) =>
        [first.project.projectId, second.project.projectId].includes(
          project.projectId
        )
      )
      .map((project) => project.projectId);
    expect(ordered).toEqual([
      second.project.projectId,
      first.project.projectId
    ]);
  });

  it('rejects shelf edits that say nothing or say something invalid', async () => {
    const created = await createProject('Validation');
    const projectId = created.project.projectId;

    for (const [body, message] of [
      [{}, 'Provide at least one of "status", "pinned", or "sortOrder".'],
      [{ status: 'shredded' }, /"status" must be one of/],
      [{ pinned: 'yes' }, '"pinned" must be a boolean.'],
      [{ sortOrder: Number.NaN }, '"sortOrder" must be a finite number.']
    ] as const) {
      const response = await worker.fetch(
        patch(`/api/projects/${projectId}`, body),
        env
      );
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error).toMatch(message);
    }

    const repeated = await worker.fetch(
      post('/api/projects/reorder', { projectIds: [projectId, projectId] }),
      env
    );
    expect(repeated.status).toBe(400);
  });

  it('reports a shelf edit to a project that does not exist as a 404', async () => {
    const response = await worker.fetch(
      patch('/api/projects/proj_missing', { pinned: true }),
      env
    );
    expect(response.status).toBe(404);
  });

  it('allows development authentication only in an unguarded development environment', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      documentStorageAccountingReady: false,
      projectSharingEnabled: false,
      projectEditLeasesEnforced: false,
      projectPersonalSyncEnabled: false,
      projectMeasurementStorageReady: false,
      projectMeasurementSyncEnabled: false
    });
  });

  it('publishes collaboration rollout capabilities without exposing secrets', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      {
        ...env,
        PROJECT_SHARING_ENABLED: 'true',
        PROJECT_EDIT_LEASES_ENFORCED: '1'
      }
    );
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      projectSharingEnabled: true,
      projectEditLeasesEnforced: true
    });
  });

  it('keeps an account canary private and returns it only to that session', async () => {
    const canaryEnv = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      PRODUCTION_GUARD: 'enabled',
      PROJECT_COLLABORATION_CANARY_EMAILS: 'canary@example.com',
      DB: {
        prepare(query: string) {
          return {
            bind() {
              return {
                async first() {
                  return query.includes('FROM auth_sessions')
                    ? {
                        user_id: 'user_canary',
                        email: 'canary@example.com',
                        expires_at: 4_000_000_000
                      }
                    : null;
                }
              };
            }
          };
        }
      } as unknown as D1Database
    };
    const publicHealth = await worker.fetch(
      new Request('https://example.com/api/health'),
      canaryEnv
    );
    await expect(publicHealth.json()).resolves.toMatchObject({
      projectSharingEnabled: false,
      projectEditLeasesEnforced: false,
      projectPersonalSyncEnabled: false
    });

    const authenticated = await worker.fetch(
      new Request('https://example.com/api/collaboration/config', {
        headers: { cookie: '__Host-openzcad_session=test-session' }
      }),
      canaryEnv
    );
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toEqual({
      sharingEnabled: true,
      editLeasesEnforced: true,
      personalSyncEnabled: true,
      canary: true
    });
  });

  it('reports migration 0010 ready only when all required D1 schema objects exist', async () => {
    const { db, prepare } = storageAccountingDb();
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      { ...env, DB: db }
    );

    await expect(response.json()).resolves.toMatchObject({
      documentStorageAccountingReady: true,
      projectPersonalSyncEnabled: false
    });
    const query = prepare.mock.calls
      .map(([statement]) => statement)
      .find((statement) => statement.includes('idx_revisions_project_bytes'));
    expect(query).toBeDefined();
    expect(query).toContain("pragma_table_info('projects')");
    expect(query).toContain("pragma_table_info('revisions')");
    expect(query).toContain('idx_revisions_project_bytes');
  });

  it('keeps personal device sync closed when migration 0010 is incomplete', async () => {
    const { db } = storageAccountingDb({
      ...READY_STORAGE_ACCOUNTING_SCHEMA,
      revisions_bytes_index: 0
    });
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      {
        ...env,
        DB: db,
        PROJECT_PERSONAL_SYNC_ENABLED: 'true'
      }
    );

    await expect(response.json()).resolves.toMatchObject({
      documentStorageAccountingReady: false,
      projectPersonalSyncEnabled: false
    });
  });

  it('fails migration readiness closed when the D1 probe errors', async () => {
    const { db } = storageAccountingDb(
      READY_STORAGE_ACCOUNTING_SCHEMA,
      new Error('D1 unavailable')
    );
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      {
        ...env,
        DB: db,
        PROJECT_PERSONAL_SYNC_ENABLED: 'true'
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      documentStorageAccountingReady: false,
      projectPersonalSyncEnabled: false
    });
  });

  it('refuses development authentication in guarded or non-development environments', async () => {
    await expect(
      worker.fetch(new Request('https://example.com/api/health'), {
        ...env,
        ENVIRONMENT: 'beta'
      } as never)
    ).rejects.toThrow(/Refusing to start/);
    await expect(
      worker.fetch(new Request('https://example.com/api/health'), {
        ...env,
        PRODUCTION_GUARD: 'enabled'
      })
    ).rejects.toThrow(/Refusing to start/);
  });

  it('returns feature-disabled before touching persistence when deployment bindings are absent', async () => {
    const prepare = vi.fn(() => {
      throw new Error('Persistence must not be touched.');
    });
    const bindinglessEnv = {
      ENVIRONMENT: 'development' as const,
      AUTH_MODE: 'development' as const,
      DB: { prepare }
    };

    const uploadResponse = await worker.fetch(
      post('/api/uploads', {
        projectId: 'proj_test',
        fileName: 'part.stl',
        contentType: 'model/stl',
        kind: 'stl-import'
      }),
      bindinglessEnv as never
    );
    expect(uploadResponse.status).toBe(501);
    expect(await uploadResponse.json()).toEqual({
      error: 'Artifact storage is disabled for this deployment.',
      code: 'FEATURE_DISABLED'
    });

    const collaborationResponse = await worker.fetch(
      new Request('https://example.com/api/projects/proj_test/collaboration'),
      bindinglessEnv as never
    );
    expect(collaborationResponse.status).toBe(501);
    expect(await collaborationResponse.json()).toEqual({
      error: 'Collaboration is disabled for this deployment.',
      code: 'FEATURE_DISABLED'
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('exposes public email-auth readiness without exposing secrets', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/auth/config'),
      {
        ...env,
        AUTH_MODE: 'email-code',
        TURNSTILE_SITE_KEY: 'public-site-key',
        TURNSTILE_SECRET_KEY: 'secret-never-returned'
      } as never
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: 'email-code',
      emailCodeEnabled: false,
      turnstileSiteKey: 'public-site-key'
    });
  });

  it('exposes the authenticated beta session', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/session'),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: 'user_beta_dev',
      mode: 'development'
    });
  });

  it('returns device-safe settings defaults when account storage is unavailable', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/settings'),
      env
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      revision: 0,
      synced: false,
      settings: {
        general: { defaultUnits: 'mm' },
        assistant: { credentialSource: 'deployment' }
      },
      credential: { stored: false, storageAvailable: false }
    });
    expect(JSON.stringify(payload)).not.toMatch(/API_KEY|secret-test-value/);
  });

  it('rejects cross-origin settings mutations', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/settings', {
        method: 'PATCH',
        headers: {
          origin: 'https://attacker.example',
          'content-type': 'application/json'
        },
        body: '{}'
      }),
      env
    );
    expect(response.status).toBe(403);
  });

  it('returns 409 before writing when the settings revision is already stale', async () => {
    const conflictEnv = settingsConflictEnv({
      storedRevision: 4,
      changes: 1
    });

    const response = await worker.fetch(
      patch('/api/settings', {
        settings: DEFAULT_APP_SETTINGS,
        expectedRevision: 3
      }),
      conflictEnv.workerEnv
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Settings changed elsewhere. Reload and try again.'
    });
    expect(conflictEnv.run).not.toHaveBeenCalled();
  });

  it('returns 409 when a concurrent settings write wins the conditional update', async () => {
    const conflictEnv = settingsConflictEnv({
      storedRevision: 4,
      changes: 0
    });

    const response = await worker.fetch(
      patch('/api/settings', {
        settings: DEFAULT_APP_SETTINGS,
        expectedRevision: 4
      }),
      conflictEnv.workerEnv
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Settings changed elsewhere. Reload and try again.'
    });
    expect(conflictEnv.run).toHaveBeenCalledOnce();
    expect(
      conflictEnv.prepare.mock.calls.some(([query]) =>
        query.includes('UPDATE user_settings')
      )
    ).toBe(true);
  });

  it('reports assistant configuration without exposing secrets', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status'),
      withEnabledDeploymentAssistant({
        OPENROUTER_API_KEY: 'secret-test-value',
        AI_MODEL: 'model-test'
      })
    );
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      configured: boolean;
      provider: string;
      model: string;
      reasoningEffort: string;
    };
    expect(status).toMatchObject({
      configured: true,
      provider: 'openrouter',
      model: 'model-test',
      reasoningEffort: 'high'
    });
    expect(JSON.stringify(status)).not.toContain('secret-test-value');
  });

  it('does not expose deployment assistant availability without an allowlisted session', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status'),
      {
        ...env,
        AUTH_MODE: 'email-code',
        OPENROUTER_API_KEY: 'secret-test-value'
      } as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      provider: 'openrouter'
    });
  });

  it('reports deployment assistant availability to an allowlisted session', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status', {
        headers: { cookie: '__Host-openzcad_session=test-session' }
      }),
      withEnabledDeploymentAssistant({
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        AI_DEPLOYMENT_ALLOWED_EMAILS: 'allowed@example.com',
        OPENROUTER_API_KEY: 'secret-test-value'
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      provider: 'openrouter',
      source: 'deployment'
    });
  });

  // wrangler.jsonc deliberately leaves AI_DEPLOYMENT_ALLOWED_EMAILS out of
  // secrets.required, which is only safe because an unset allowlist denies
  // every account rather than admitting them. A regression here would hand the
  // deployment's provider key to any authenticated session.
  it('denies deployment assistant funding when no allowlist is configured', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status', {
        headers: { cookie: '__Host-openzcad_session=test-session' }
      }),
      withEnabledDeploymentAssistant({
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        OPENROUTER_API_KEY: 'secret-test-value'
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false });
  });

  it('requires an email-code identity for cloud routes', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/projects'),
      { ...env, AUTH_MODE: 'email-code' } as never
    );
    expect(response.status).toBe(401);
  });

  it('isolates projects between authenticated development users', async () => {
    const ownerRequest = new Request('https://example.com/api/projects', {
      method: 'POST',
      headers: { 'x-openzcad-development-user': 'user_owner' },
      body: JSON.stringify({ name: 'Private worker project' })
    });
    const createdResponse = await worker.fetch(ownerRequest, env);
    const created = (await createdResponse.json()) as CreateProjectResponse;

    const intruderResponse = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.project.projectId}`,
        { headers: { 'x-openzcad-development-user': 'user_intruder' } }
      ),
      env
    );
    expect(intruderResponse.status).toBe(404);
  });

  it('authorizes and forwards collaboration WebSocket upgrades', async () => {
    const created = await createProject('Live project');
    const roomFetch = vi.fn(async (request: Request) =>
      Response.json({
        userId: request.headers.get('x-openzcad-user-id'),
        displayName: request.headers.get('x-openzcad-display-name'),
        role: request.headers.get('x-openzcad-project-role')
      })
    );
    env.PROJECT_ROOM.getByName.mockReturnValueOnce({ fetch: roomFetch });

    const response = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.project.projectId}/collaboration`,
        {
          headers: {
            upgrade: 'websocket',
            // The Worker must replace, never trust, a client-forged role.
            'x-openzcad-project-role': 'viewer'
          }
        }
      ),
      { ...env, PROJECT_PERSONAL_SYNC_ENABLED: 'true' }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: 'user_beta_dev',
      displayName: 'Beta developer',
      role: 'owner'
    });
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('mints a native collaboration ticket only after project authorization', async () => {
    const created = await createProject('Native live project');
    const ticket = 'n'.repeat(43);
    const roomFetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('PUT');
      expect(request.headers.get('x-openzcad-internal-ticket-request')).toBe(
        'v1'
      );
      expect(request.headers.get('x-openzcad-user-id')).toBe('user_beta_dev');
      expect(request.headers.get('x-openzcad-display-name')).toBe(
        'Beta developer'
      );
      expect(request.headers.get('x-openzcad-project-role')).toBe('owner');
      expect(new URL(request.url).searchParams.get('projectId')).toBe(
        created.project.projectId
      );
      return Response.json(
        { ticket, expiresAt: Date.now() + 30_000 },
        { headers: { 'cache-control': 'no-store' } }
      );
    });
    env.PROJECT_ROOM.getByName.mockReturnValueOnce({ fetch: roomFetch });

    const response = await worker.fetch(
      post(
        `/api/projects/${created.project.projectId}/collaboration/ticket`,
        undefined
      ),
      { ...env, PROJECT_PERSONAL_SYNC_ENABLED: 'true' }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const issued: unknown = await response.json();
    expect(issued).toMatchObject({ ticket });
    expect(
      typeof issued === 'object' && issued !== null && 'expiresAt' in issued
        ? typeof issued.expiresAt
        : null
    ).toBe('number');
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('rejects collaboration tickets when the account preference is disabled', async () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.collaboration.enabled = false;
    const rowFor = (query: string) =>
      query.includes('FROM account_erasure_requests')
        ? null
        : query.includes('FROM user_settings')
          ? { settings_json: JSON.stringify(settings), revision: 1 }
          : query.includes('FROM projects p')
            ? { owner_user_id: 'user_beta_dev', resolved_role: 'owner' }
            : query.includes('idx_project_document_objects_project_state')
              ? READY_PROJECT_OBJECT_STORAGE_SCHEMA
              : READY_STORAGE_ACCOUNTING_SCHEMA;
    const prepare = vi.fn((query: string) => ({
      first: vi.fn(async () => rowFor(query)),
      bind: vi.fn(() => ({ first: vi.fn(async () => rowFor(query)) }))
    }));
    const getByName = vi.fn();

    const response = await worker.fetch(
      post('/api/projects/project_direct/collaboration/ticket', undefined),
      {
        ...env,
        DB: { prepare } as unknown as D1Database,
        PROJECT_STORAGE: readyProjectStorageBucket,
        PROJECT_ROOM: { getByName },
        PROJECT_PERSONAL_SYNC_ENABLED: 'true'
      }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("uses the project owner's sharing preference for collaborator tickets", async () => {
    const actorSettings = structuredClone(DEFAULT_APP_SETTINGS);
    actorSettings.collaboration.enabled = false;
    const ownerSettings = structuredClone(DEFAULT_APP_SETTINGS);
    ownerSettings.collaboration.enabled = true;
    const prepare = vi.fn((query: string) => ({
      first: vi.fn(async () =>
        query.includes('idx_project_document_objects_project_state')
          ? READY_PROJECT_OBJECT_STORAGE_SCHEMA
          : null
      ),
      bind: vi.fn((...values: unknown[]) => ({
        first: vi.fn(async () => {
          if (query.includes('idx_project_document_objects_project_state')) {
            return READY_PROJECT_OBJECT_STORAGE_SCHEMA;
          }
          if (query.includes('FROM user_settings')) {
            return {
              settings_json: JSON.stringify(
                values[0] === 'owner_shared' ? ownerSettings : actorSettings
              ),
              revision: 1
            };
          }
          if (query.includes('FROM projects p')) {
            return {
              owner_user_id: 'owner_shared',
              resolved_role: 'viewer'
            };
          }
          return null;
        })
      }))
    }));
    const roomFetch = vi.fn(async () =>
      Response.json({ ticket: 's'.repeat(43), expiresAt: Date.now() + 30_000 })
    );
    const getByName = vi.fn(() => ({ fetch: roomFetch }));

    const response = await worker.fetch(
      post('/api/projects/project_shared/collaboration/ticket', undefined),
      {
        ...env,
        DB: { prepare } as unknown as D1Database,
        PROJECT_STORAGE: readyProjectStorageBucket,
        PROJECT_ROOM: { getByName },
        PROJECT_SHARING_ENABLED: 'true',
        PROJECT_PERSONAL_SYNC_ENABLED: 'true'
      } as never
    );

    expect(response.status).toBe(200);
    expect(getByName).toHaveBeenCalledOnce();
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('forwards a ticketed native upgrade without browser credentials or forged identity', async () => {
    const projectId = 'proj_native_ticket';
    const ticket = 't'.repeat(43);
    const roomFetch = vi.fn(async (request: Request) =>
      Response.json({
        projectId: new URL(request.url).searchParams.get('projectId'),
        ticket: new URL(request.url).searchParams.get('ticket'),
        authorization: request.headers.get('authorization'),
        cookie: request.headers.get('cookie'),
        userId: request.headers.get('x-openzcad-user-id'),
        role: request.headers.get('x-openzcad-project-role')
      })
    );
    const getByName = vi.fn(() => ({ fetch: roomFetch }));

    const response = await worker.fetch(
      new Request(
        `https://zcad.esau.app/api/projects/${projectId}/collaboration?ticket=${ticket}`,
        {
          headers: {
            origin: 'tauri://localhost',
            upgrade: 'websocket',
            authorization: `Bearer ${'b'.repeat(43)}`,
            cookie: '__Host-openzcad_session=forged',
            'x-openzcad-user-id': 'user_forged',
            'x-openzcad-project-role': 'owner'
          }
        }
      ),
      {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'email-code',
        PROJECT_ROOM: { getByName }
      } as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId,
      ticket,
      authorization: null,
      cookie: null,
      userId: null,
      role: null
    });
    expect(getByName).toHaveBeenCalledWith(projectId);
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('streams collaboration snapshots to the room without buffering them', async () => {
    const created = await createProject('Streamed collaboration project');
    const roomFetch = vi.fn(async (request: Request) => {
      expect(request.body).not.toBeNull();
      return Response.json({ forwarded: true });
    });
    env.PROJECT_ROOM.getByName.mockReturnValueOnce({ fetch: roomFetch });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"clientId":"streamed"'));
      },
      pull() {
        throw new Error('The outer Worker consumed the collaboration body.');
      }
    });

    const response = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.project.projectId}/collaboration`,
        {
          method: 'POST',
          headers: { origin: 'https://example.com' },
          body,
          duplex: 'half'
        } as RequestInit & { duplex: 'half' }
      ),
      { ...env, PROJECT_PERSONAL_SYNC_ENABLED: 'true' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forwarded: true });
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('creates, lists, and revokes viewer invitations behind the sharing flag', async () => {
    const owner = toUserId('user_sharing_route_owner');
    const emailSend = vi.fn(async (_message: EmailMessageBuilder) => ({
      messageId: 'message_sharing'
    }));
    const sharingEnv = {
      ...env,
      PROJECT_SHARING_ENABLED: 'true',
      PROJECT_INVITATION_EMAIL_FROM: 'noreply@zcad.esau.app',
      PUBLIC_APP_ORIGIN: 'https://zcad.esau.app',
      EMAIL: { send: emailSend }
    };
    const createdResponse = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({ name: 'Sharing routes' })
      }),
      sharingEnv
    );
    const created = (await createdResponse.json()) as CreateProjectResponse;
    const projectId = created.document.projectId;

    const invited = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/invitations`, {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({
          email: ' Viewer@Example.com ',
          role: 'viewer'
        })
      }),
      sharingEnv
    );
    expect(invited.status).toBe(201);
    const invitation = (await invited.json()) as {
      invitation: { invitationId: string; email: string };
      token: string;
    };
    expect(invitation.invitation.email).toBe('viewer@example.com');
    expect(invitation.token).toHaveLength(43);
    expect(emailSend).toHaveBeenCalledOnce();
    expect(emailSend.mock.calls[0]![0]).toMatchObject({
      to: 'viewer@example.com',
      from: { email: 'noreply@zcad.esau.app', name: 'OpenZCAD' },
      subject: 'You are invited to an OpenZCAD project'
    });
    expect(emailSend.mock.calls[0]![0].text).toContain(
      `https://zcad.esau.app/#invite=${invitation.token}`
    );
    expect(emailSend.mock.calls[0]![0].html).toContain('Sharing routes');

    const listed = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/sharing`, {
        headers: { 'x-openzcad-development-user': owner }
      }),
      sharingEnv
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      projectId,
      ownerUserId: owner,
      invitations: [
        {
          invitationId: invitation.invitation.invitationId,
          email: 'viewer@example.com',
          role: 'viewer'
        }
      ]
    });

    const revoked = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${projectId}/invitations/${invitation.invitation.invitationId}`,
        {
          method: 'DELETE',
          headers: { 'x-openzcad-development-user': owner }
        }
      ),
      sharingEnv
    );
    expect(revoked.status).toBe(204);
  });

  it('revokes a newly created invitation when email delivery fails', async () => {
    const owner = toUserId('user_sharing_email_failure_owner');
    const createdResponse = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({ name: 'Email failure cleanup' })
      }),
      env
    );
    const created = (await createdResponse.json()) as CreateProjectResponse;
    const deliveryError = Object.assign(
      new Error('member@example.com secret-token-value'),
      { code: 'E_DELIVERY_FAILED' }
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const failureEnv = {
      ...env,
      PROJECT_SHARING_ENABLED: 'true',
      PROJECT_INVITATION_EMAIL_FROM: 'noreply@zcad.esau.app',
      PUBLIC_APP_ORIGIN: 'https://zcad.esau.app',
      EMAIL: {
        send: vi.fn(async (_message: EmailMessageBuilder) =>
          Promise.reject(deliveryError)
        )
      }
    };

    try {
      const response = await worker.fetch(
        new Request(
          `https://example.com/api/projects/${created.document.projectId}/invitations`,
          {
            method: 'POST',
            headers: { 'x-openzcad-development-user': owner },
            body: JSON.stringify({
              email: 'member@example.com',
              role: 'viewer'
            })
          }
        ),
        failureEnv
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: 'INVITATION_EMAIL_UNAVAILABLE'
      });

      const listed = await worker.fetch(
        new Request(
          `https://example.com/api/projects/${created.document.projectId}/sharing`,
          { headers: { 'x-openzcad-development-user': owner } }
        ),
        failureEnv
      );
      await expect(listed.json()).resolves.toMatchObject({ invitations: [] });
      const logs = JSON.stringify(consoleError.mock.calls);
      expect(logs).toContain('E_DELIVERY_FAILED');
      expect(logs).not.toContain('member@example.com');
      expect(logs).not.toContain('secret-token-value');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('lets viewers read shared projects but rejects every revision mutation', async () => {
    const owner = toUserId('user_route_owner');
    const viewer = toUserId('user_route_viewer');
    const createdResponse = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({ name: 'Read-only shared project' })
      }),
      env
    );
    const created = (await createdResponse.json()) as CreateProjectResponse;
    await getInMemoryPersistence().setProjectMemberRole(
      owner,
      created.document.projectId,
      viewer,
      'viewer'
    );

    const viewed = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.document.projectId}`,
        { headers: { 'x-openzcad-development-user': viewer } }
      ),
      env
    );
    expect(viewed.status).toBe(200);

    const mutated = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.document.projectId}/revisions`,
        {
          method: 'POST',
          headers: { 'x-openzcad-development-user': viewer },
          body: JSON.stringify({
            projectId: created.document.projectId,
            reason: 'Viewer bypass attempt',
            expectedVersion: created.document.version,
            document: created.document
          })
        }
      ),
      env
    );
    expect(mutated.status).toBe(404);
  });

  it('enforces owner, editor, and viewer roles across project write routes', async () => {
    const owner = toUserId('user_route_matrix_owner');
    const editor = toUserId('user_route_matrix_editor');
    const viewer = toUserId('user_route_matrix_viewer');
    const roleEnv = {
      ...env,
      PROJECT_SHARING_ENABLED: 'true',
      PROJECT_EDIT_LEASES_ENFORCED: 'true'
    };
    const createdResponse = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: { 'x-openzcad-development-user': owner },
        body: JSON.stringify({ name: 'REST role matrix' })
      }),
      roleEnv
    );
    const created = (await createdResponse.json()) as CreateProjectResponse;
    const projectId = created.document.projectId;
    const persistence = getInMemoryPersistence();
    await persistence.setProjectMemberRole(owner, projectId, editor, 'editor');
    await persistence.setProjectMemberRole(owner, projectId, viewer, 'viewer');

    const asUser = (userId: string, path: string, init: RequestInit) =>
      worker.fetch(
        new Request(`https://example.com${path}`, {
          ...init,
          headers: {
            'content-type': 'application/json',
            'x-openzcad-development-user': userId,
            ...init.headers
          }
        }),
        roleEnv
      );
    const ownerOnlyWrites: Array<[string, RequestInit]> = [
      [
        `/api/projects/${projectId}`,
        { method: 'PATCH', body: '{"pinned":true}' }
      ],
      [`/api/projects/${projectId}`, { method: 'DELETE' }],
      [
        `/api/projects/${projectId}/invitations`,
        {
          method: 'POST',
          body: '{"email":"matrix@example.com","role":"viewer"}'
        }
      ],
      [
        `/api/projects/${projectId}/invitations/invite_missing`,
        { method: 'DELETE' }
      ],
      [
        `/api/projects/${projectId}/members/user_missing`,
        { method: 'PATCH', body: '{"role":"viewer"}' }
      ],
      [`/api/projects/${projectId}/members/user_missing`, { method: 'DELETE' }]
    ];
    for (const user of [editor, viewer]) {
      for (const [path, init] of ownerOnlyWrites) {
        expect((await asUser(user, path, init)).status).toBe(404);
      }
    }
    for (const user of [editor, viewer]) {
      const duplicated = await asUser(
        user,
        `/api/projects/${projectId}/duplicate`,
        { method: 'POST', body: '{}' }
      );
      expect(duplicated.status).toBe(201);
      await expect(duplicated.json()).resolves.toMatchObject({
        document: { ownerUserId: user }
      });
    }

    const revisionPayload = {
      projectId,
      reason: 'Editor checkpoint',
      expectedVersion: created.document.version,
      document: created.document
    };
    expect(
      (
        await asUser(viewer, `/api/projects/${projectId}/revisions`, {
          method: 'POST',
          body: JSON.stringify(revisionPayload)
        })
      ).status
    ).toBe(404);
    const editorRevision = await asUser(
      editor,
      `/api/projects/${projectId}/revisions`,
      { method: 'POST', body: JSON.stringify(revisionPayload) }
    );
    expect(editorRevision.status).toBe(200);
    const editorDocument = (await editorRevision.json()) as ProjectDocument;

    expect(
      (
        await asUser(viewer, `/api/projects/${projectId}/document`, {
          method: 'PUT',
          body: JSON.stringify({
            projectId,
            expectedVersion: editorDocument.version,
            document: editorDocument
          })
        })
      ).status
    ).toBe(404);
    expect(
      (
        await asUser(editor, `/api/projects/${projectId}/document`, {
          method: 'PUT',
          body: JSON.stringify({
            projectId,
            expectedVersion: editorDocument.version,
            document: editorDocument
          })
        })
      ).status
    ).toBe(200);

    const uploadPayload = {
      projectId,
      fileName: 'editor.step',
      contentType: 'model/step',
      kind: 'step-export'
    };
    expect(
      (
        await asUser(viewer, '/api/uploads', {
          method: 'POST',
          body: JSON.stringify(uploadPayload)
        })
      ).status
    ).toBe(404);
    const uploadResponse = await asUser(editor, '/api/uploads', {
      method: 'POST',
      body: JSON.stringify(uploadPayload)
    });
    expect(uploadResponse.status).toBe(201);
    const { session } = (await uploadResponse.json()) as {
      session: { uploadSessionId: string; artifactId: string };
    };
    expect(
      (
        await asUser(
          viewer,
          `/api/uploads/${session.uploadSessionId}/content`,
          { method: 'PUT', body: 'STEP DATA' }
        )
      ).status
    ).toBe(404);
    expect(
      (
        await asUser(
          editor,
          `/api/uploads/${session.uploadSessionId}/content`,
          { method: 'PUT', body: 'STEP DATA' }
        )
      ).status
    ).toBe(204);
    const finalizePayload = {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    };
    expect(
      (
        await asUser(viewer, '/api/artifacts/finalize', {
          method: 'POST',
          body: JSON.stringify(finalizePayload)
        })
      ).status
    ).toBe(404);
    expect(
      (
        await asUser(editor, '/api/artifacts/finalize', {
          method: 'POST',
          body: JSON.stringify(finalizePayload)
        })
      ).status
    ).toBe(200);
  });

  it('rejects cross-origin collaboration WebSocket upgrades', async () => {
    const created = await createProject('Protected live project');
    const roomLookupsBefore = env.PROJECT_ROOM.getByName.mock.calls.length;
    const response = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.project.projectId}/collaboration`,
        {
          headers: {
            origin: 'https://attacker.example',
            upgrade: 'websocket'
          }
        }
      ),
      env
    );

    expect(response.status).toBe(403);
    expect(env.PROJECT_ROOM.getByName.mock.calls).toHaveLength(
      roomLookupsBefore
    );
  });

  it('keeps assistant generation disabled until a secret is configured', async () => {
    const response = await worker.fetch(
      post('/api/assistant/proposals', {
        prompt: 'Make it wider',
        digest: {
          schemaVersion: 3,
          projectId: 'proj_ai',
          name: 'Bracket',
          units: 'mm',
          version: 1,
          parameters: [],
          features: [],
          warnings: []
        }
      }),
      env
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });

  it('fails closed before provider dispatch when the beta usage guard is unavailable', async () => {
    const providerFetch = vi.fn(
      async () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', providerFetch);
    const publicEnv = withEnabledDeploymentAssistant({
      AI_PROVIDER: 'responses-compatible',
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AI_IDENTITY_PEPPER: 'route-test-pepper',
      AI_DEPLOYMENT_ALLOWED_EMAILS: 'allowed@example.com',
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://models.example.test/v1/responses'
    });
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/proposals', {
        method: 'POST',
        headers: {
          cookie: '__Host-openzcad_session=test-session',
          'cf-connecting-ip': '203.0.113.42'
        },
        body: JSON.stringify({
          prompt: 'Make it wider',
          digest: {
            schemaVersion: 3,
            projectId: 'proj_ai_public',
            name: 'Bracket',
            units: 'mm',
            version: 1,
            parameters: [],
            features: [],
            warnings: []
          }
        })
      }),
      publicEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'AI_GUARD_UNAVAILABLE'
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('does not lock out the next assistant request after a provider outage', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('upstream unavailable', { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
      );
    vi.stubGlobal('fetch', providerFetch);
    const publicEnv = withEnabledDeploymentAssistant({
      AI_PROVIDER: 'responses-compatible',
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://models.example.test/v1/responses'
    });
    const request = () =>
      new Request('https://example.com/api/assistant/proposals', {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Make it wider',
          digest: {
            schemaVersion: 3,
            projectId: 'proj_ai_retry',
            name: 'Bracket',
            units: 'mm',
            version: 1,
            parameters: [],
            features: [],
            warnings: []
          }
        })
      });

    const failed = await worker.fetch(request(), publicEnv);
    expect(failed.status).toBe(502);
    const retry = await worker.fetch(request(), publicEnv);
    expect(retry.status).toBe(200);
    await retry.body?.cancel();
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized assistant digests before provider dispatch', async () => {
    const response = await worker.fetch(
      post('/api/assistant/proposals', {
        prompt: 'Inspect this model',
        digest: {
          schemaVersion: 3,
          projectId: 'proj_large',
          name: 'Large model',
          units: 'mm',
          version: 1,
          parameters: [],
          features: Array.from({ length: 1_001 }, (_, index) => ({ index })),
          bodies: [],
          warnings: []
        }
      }),
      env
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: '"digest.features" has too many items.'
    });
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        body: '{nope'
      }),
      env
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/valid JSON/);
  });

  it('rejects project creation without a name', async () => {
    const response = await worker.fetch(post('/api/projects', {}), env);
    expect(response.status).toBe(400);

    const blankResponse = await worker.fetch(
      post('/api/projects', { name: '   ' }),
      env
    );
    expect(blankResponse.status).toBe(400);
  });

  it('rejects a project name longer than the shared limit', async () => {
    const atLimit = await worker.fetch(
      post('/api/projects', { name: 'n'.repeat(MAX_PROJECT_NAME_LENGTH) }),
      env
    );
    expect(atLimit.status).toBe(201);

    const overLimit = await worker.fetch(
      post('/api/projects', { name: 'n'.repeat(MAX_PROJECT_NAME_LENGTH + 1) }),
      env
    );
    expect(overLimit.status).toBe(400);
  });

  it('rejects invalid units', async () => {
    const response = await worker.fetch(
      post('/api/projects', { name: 'Units', units: 'furlong' }),
      env
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown projects and nested paths', async () => {
    const missing = await worker.fetch(
      new Request('https://example.com/api/projects/proj_missing'),
      env
    );
    expect(missing.status).toBe(404);

    const nested = await worker.fetch(
      new Request('https://example.com/api/projects/proj_x/unknown'),
      env
    );
    expect(nested.status).toBe(404);
  });

  it('saves revisions and rejects path/payload project mismatches', async () => {
    const created = await createProject('Revision Test');
    const document = created.document;

    const saved = await worker.fetch(
      post(`/api/projects/${document.projectId}/revisions`, {
        projectId: document.projectId,
        reason: 'Manual save',
        expectedVersion: document.version,
        document
      }),
      env
    );
    expect(saved.status).toBe(200);
    const savedDocument = (await saved.json()) as ProjectDocument;
    expect(savedDocument.projectId).toBe(document.projectId);

    const mismatch = await worker.fetch(
      post('/api/projects/proj_other/revisions', {
        projectId: document.projectId,
        reason: 'Manual save',
        expectedVersion: document.version,
        document
      }),
      env
    );
    expect(mismatch.status).toBe(400);
  });

  it('returns a conflict response for stale revision writes', async () => {
    const created = await createProject('Revision Conflict');
    const document = created.document;
    const newerDocument = { ...document, version: document.version + 1 };

    const saved = await worker.fetch(
      post(`/api/projects/${document.projectId}/revisions`, {
        projectId: document.projectId,
        reason: 'Newer save',
        expectedVersion: document.version,
        document: newerDocument
      }),
      env
    );
    expect(saved.status).toBe(200);

    const stale = await worker.fetch(
      post(`/api/projects/${document.projectId}/revisions`, {
        projectId: document.projectId,
        reason: 'Stale save',
        expectedVersion: document.version,
        document: { ...newerDocument, version: newerDocument.version + 1 }
      }),
      env
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: `Project ${document.projectId} has a newer remote revision.`,
      code: 'REVISION_CONFLICT',
      currentVersion: newerDocument.version
    });
  });

  it('returns 404 when saving a revision for an unknown project', async () => {
    const created = await createProject('Orphan Revision');
    const ghostId = 'proj_ghost';
    const document = { ...created.document, projectId: ghostId };

    const response = await worker.fetch(
      post(`/api/projects/${ghostId}/revisions`, {
        projectId: ghostId,
        reason: 'Manual save',
        expectedVersion: document.version,
        document
      }),
      env
    );
    expect(response.status).toBe(404);
  });

  it('runs the upload/finalize flow and consumes the session', async () => {
    const created = await createProject('Upload Test');
    const projectId = created.project.projectId;

    const sessionResponse = await worker.fetch(
      post('/api/uploads', {
        projectId,
        fileName: 'part.stl',
        contentType: 'model/stl',
        kind: 'stl-import'
      }),
      env
    );
    expect(sessionResponse.status).toBe(201);
    const { session } = (await sessionResponse.json()) as {
      session: { uploadSessionId: string; artifactId: string };
    };

    const finalizeBody = {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    };
    const uploaded = await worker.fetch(
      new Request(
        `https://example.com/api/uploads/${session.uploadSessionId}/content`,
        { method: 'PUT', body: 'solid part' }
      ),
      env
    );
    expect(uploaded.status).toBe(204);
    const finalized = await worker.fetch(
      post('/api/imports/finalize', finalizeBody),
      env
    );
    expect(finalized.status).toBe(200);
    expect(
      ((await finalized.json()) as { artifactId: string }).artifactId
    ).toBe(session.artifactId);

    const replayed = await worker.fetch(
      post('/api/imports/finalize', finalizeBody),
      env
    );
    expect(replayed.status).toBe(404);
  });

  it('rejects multipart part numbers above the upload ceiling', async () => {
    const created = await createProject('Bounded Multipart Upload');
    const sessionResponse = await worker.fetch(
      post('/api/uploads', {
        projectId: created.project.projectId,
        fileName: 'large.step',
        contentType: 'model/step',
        kind: 'step-import'
      }),
      env
    );
    const { session } = (await sessionResponse.json()) as {
      session: { uploadSessionId: string };
    };
    const multipartResponse = await worker.fetch(
      post(`/api/uploads/${session.uploadSessionId}/multipart`, {}),
      env
    );
    const { uploadId } = (await multipartResponse.json()) as {
      uploadId: string;
    };

    const rejected = await worker.fetch(
      new Request(
        `https://example.com/api/uploads/${session.uploadSessionId}/parts/${MAX_ARTIFACT_UPLOAD_PARTS + 1}?uploadId=${encodeURIComponent(uploadId)}`,
        { method: 'PUT', body: 'x' }
      ),
      env
    );

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: `Upload part number cannot exceed ${MAX_ARTIFACT_UPLOAD_PARTS}.`
    });
  });

  it('lists and downloads completed artifacts', async () => {
    const created = await createProject('Artifact Test');
    const projectId = created.project.projectId;
    const sessionResponse = await worker.fetch(
      post('/api/uploads', {
        projectId,
        fileName: 'part.step',
        contentType: 'model/step',
        kind: 'step-export',
        metadata: { documentVersion: 1 }
      }),
      env
    );
    const { session } = (await sessionResponse.json()) as {
      session: { uploadSessionId: string; artifactId: string };
    };
    await worker.fetch(
      new Request(
        `https://example.com/api/uploads/${session.uploadSessionId}/content`,
        { method: 'PUT', body: 'STEP DATA' }
      ),
      env
    );
    await worker.fetch(
      post('/api/artifacts/finalize', {
        projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      }),
      env
    );

    const listed = await worker.fetch(
      new Request(`https://example.com/api/projects/${projectId}/artifacts`),
      env
    );
    expect(await listed.json()).toMatchObject({
      artifacts: [{ artifactId: session.artifactId, bytes: 9 }]
    });
    const downloaded = await worker.fetch(
      new Request(
        `https://example.com/api/artifacts/${session.artifactId}/download`
      ),
      env
    );
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('STEP DATA');

    const metadata = await worker.fetch(
      new Request(`https://example.com/api/artifacts/${session.artifactId}`),
      env
    );
    expect(metadata.status).toBe(200);
    const hidden = await worker.fetch(
      new Request(`https://example.com/api/artifacts/${session.artifactId}`, {
        headers: { 'x-openzcad-development-user': 'user_artifact_intruder' }
      }),
      env
    );
    expect(hidden.status).toBe(404);
  });

  it('returns 404 rather than a null metadata envelope for unknown artifacts', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/artifacts/artifact_missing'),
      env
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Artifact not found.' });
  });

  it('rejects oversized request bodies with 413', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        body: '{}',
        headers: { 'content-length': String(30 * 1024 * 1024) }
      }),
      env
    );
    expect(response.status).toBe(413);
  });

  it('accepts a headerless streamed JSON body within the size limit', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ name: 'Streamed Project' }))
        );
        controller.close();
      }
    });
    const request = new Request('https://example.com/api/projects', {
      method: 'POST',
      body,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    expect(request.headers.has('content-length')).toBe(false);

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(201);
  });

  it.each([
    { description: 'without Content-Length', contentLength: undefined },
    { description: 'with underreported Content-Length', contentLength: '1' }
  ])(
    'rejects an oversized stream $description with 413',
    async ({ contentLength }) => {
      const chunk = new Uint8Array(1024 * 1024).fill(0x20);
      let chunksRemaining = 26;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksRemaining === 0) {
            controller.close();
            return;
          }
          chunksRemaining -= 1;
          controller.enqueue(chunk);
        }
      });
      const request = new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: contentLength
          ? { 'content-length': contentLength }
          : undefined,
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' });
      expect(request.headers.get('content-length')).toBe(contentLength ?? null);

      const response = await worker.fetch(request, env);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: 'Request body is too large.'
      });
    }
  );

  it('adopts a device-local document under its own project id', async () => {
    const local = createProjectDocument('Adopted', toUserId('user_local'));
    const response = await worker.fetch(
      post('/api/projects', { name: local.name, document: local }),
      env
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateProjectResponse;
    expect(created.document.projectId).toBe(local.projectId);

    const loaded = await worker.fetch(
      new Request(`https://example.com/api/projects/${local.projectId}`),
      env
    );
    expect(loaded.status).toBe(200);
    expect(((await loaded.json()) as ProjectDocument).name).toBe('Adopted');
  });

  it('answers a second adoption of the same project with 409 ALREADY_ADOPTED', async () => {
    const local = createProjectDocument('Twice', toUserId('user_local'));
    await worker.fetch(
      post('/api/projects', { name: local.name, document: local }),
      env
    );
    const again = await worker.fetch(
      post('/api/projects', { name: local.name, document: local }),
      env
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'ALREADY_ADOPTED' });
  });

  it('saves a document without adding a revision', async () => {
    const created = await createProject('Autosaved');
    const projectId = created.document.projectId;

    const response = await worker.fetch(
      put(`/api/projects/${projectId}/document`, {
        projectId,
        expectedVersion: created.document.version,
        document: created.document
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId,
      version: created.document.version
    });

    // The whole point of the split: continuous sync must not grow history.
    const loaded = (await (
      await worker.fetch(
        new Request(`https://example.com/api/projects/${projectId}`),
        env
      )
    ).json()) as ProjectDocument;
    expect(loaded.checkpoints).toHaveLength(
      created.document.checkpoints.length
    );
  });

  it('fences a document save against the version the account holds', async () => {
    const created = await createProject('Fenced');
    const projectId = created.document.projectId;

    const stale = await worker.fetch(
      put(`/api/projects/${projectId}/document`, {
        projectId,
        expectedVersion: created.document.version + 5,
        document: created.document
      }),
      env
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'REVISION_CONFLICT',
      currentVersion: created.document.version
    });
  });

  it('reports each project’s document version in the listing', async () => {
    // The pull side asks "am I behind?" from the listing it already fetches,
    // rather than pulling whole documents to find out.
    const created = await createProject('Versioned');
    await worker.fetch(
      post(`/api/projects/${created.document.projectId}/revisions`, {
        projectId: created.document.projectId,
        reason: 'Manual save',
        expectedVersion: created.document.version,
        document: created.document
      }),
      env
    );

    const listed = (await (
      await worker.fetch(new Request('https://example.com/api/projects'), env)
    ).json()) as { projects: ProjectSummary[] };
    const summary = listed.projects.find(
      (project) => project.projectId === created.document.projectId
    );
    expect(summary?.documentVersion).toBe(created.document.version);
  });

  it('reports personal device sync separately from sharing', async () => {
    // Turning on device sync must never read as permission to invite anyone.
    const { db } = storageAccountingDb();
    const health = (await (
      await worker.fetch(new Request('https://example.com/api/health'), {
        ...env,
        DB: db,
        ARTIFACTS: readyProjectStorageBucket,
        PROJECT_PERSONAL_SYNC_ENABLED: 'true'
      })
    ).json()) as {
      documentStorageAccountingReady: boolean;
      projectObjectStorageReady: boolean;
      projectPersonalSyncEnabled: boolean;
      projectMeasurementStorageReady: boolean;
      projectMeasurementSyncEnabled: boolean;
      projectSharingEnabled: boolean;
      projectEditLeasesEnforced: boolean;
    };
    expect(health.documentStorageAccountingReady).toBe(true);
    expect(health.projectObjectStorageReady).toBe(true);
    expect(health.projectPersonalSyncEnabled).toBe(true);
    expect(health.projectMeasurementStorageReady).toBe(true);
    expect(health.projectMeasurementSyncEnabled).toBe(true);
    expect(health.projectSharingEnabled).toBe(false);
    expect(health.projectEditLeasesEnforced).toBe(false);
  });

  it('stores measurements through gated read, write, and delete routes', async () => {
    const DB = projectMeasurementRouteDb();
    const routeEnv = {
      ...env,
      DB,
      ARTIFACTS: readyProjectStorageBucket,
      PROJECT_PERSONAL_SYNC_ENABLED: 'true'
    };
    const projectId = 'project_measurement_routes';
    const path = `/api/projects/${projectId}/measurements`;
    const empty = await worker.fetch(
      new Request(`https://example.com${path}`),
      routeEnv
    );
    expect(await empty.json()).toEqual({ revision: 0, record: null });

    const record = {
      projectId,
      version: 1,
      updatedAt: '2026-08-07T16:00:00.000Z',
      measurements: [],
      display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' }
    };
    const written = await worker.fetch(
      put(path, { expectedRevision: 0, record }),
      routeEnv
    );
    expect(written.status).toBe(200);
    await expect(written.json()).resolves.toEqual({ revision: 1, record });

    const deleted = await worker.fetch(
      new Request(`https://example.com${path}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: 1 })
      }),
      routeEnv
    );
    expect(deleted.status).toBe(204);
    const after = await worker.fetch(
      new Request(`https://example.com${path}`),
      routeEnv
    );
    await expect(after.json()).resolves.toEqual({ revision: 0, record: null });
  });

  it('keeps measurement routes local-only until migration 0015 is ready', async () => {
    const { db } = storageAccountingDb(
      READY_STORAGE_ACCOUNTING_SCHEMA,
      undefined,
      READY_PROJECT_OBJECT_STORAGE_SCHEMA,
      { ...READY_PROJECT_MEASUREMENT_SCHEMA, erasure_triggers: 1 }
    );
    const response = await worker.fetch(
      new Request(
        'https://example.com/api/projects/project_local/measurements'
      ),
      {
        ...env,
        DB: db,
        ARTIFACTS: readyProjectStorageBucket,
        PROJECT_PERSONAL_SYNC_ENABLED: 'true'
      }
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'MEASUREMENT_SYNC_UNAVAILABLE'
    });
  });

  it('fails project routes closed when the R2 schema is not ready', async () => {
    const { db } = storageAccountingDb(
      READY_STORAGE_ACCOUNTING_SCHEMA,
      undefined,
      {
        project_columns: 0,
        revision_pointer: 0,
        document_objects_table: 0,
        storage_assets_table: 0,
        document_objects_index: 0,
        storage_assets_index: 0,
        pointer_indexes: 0
      }
    );
    const response = await worker.fetch(
      new Request('https://example.com/api/projects'),
      {
        ...env,
        DB: db,
        ARTIFACTS: readyProjectStorageBucket
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        'Cloud project storage is temporarily unavailable. Projects remain saved on this device.',
      code: 'PROJECT_STORAGE_UNAVAILABLE'
    });
  });

  it('keeps sharing routes closed while personal sync is on', async () => {
    const created = await createProject('Still Private');
    const response = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.project.projectId}/sharing`
      ),
      { ...env, PROJECT_PERSONAL_SYNC_ENABLED: 'true' }
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('refuses a document save whose body disagrees with the url', async () => {
    const created = await createProject('Mismatched');
    const other = await createProject('Other');
    const response = await worker.fetch(
      put(`/api/projects/${created.document.projectId}/document`, {
        projectId: other.document.projectId,
        expectedVersion: created.document.version,
        document: other.document
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it('logs route context for unhandled API errors without exposing internals', async () => {
    const failure = new Error('D1 schema mismatch');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await worker.fetch(
        new Request('https://example.com/api/projects?status=active'),
        {
          ...env,
          ARTIFACTS: undefined,
          DB: {
            prepare() {
              throw failure;
            }
          }
        } as never
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal error' });
      expect(errorSpy).toHaveBeenCalledWith(
        'Unhandled API error.',
        'GET',
        '/api/projects',
        failure
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
