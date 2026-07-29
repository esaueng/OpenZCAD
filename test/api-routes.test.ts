import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import {
  DEFAULT_APP_SETTINGS,
  MAX_PROJECT_NAME_LENGTH,
  type CreateProjectResponse,
  type ProjectDocument
} from '@openzcad/shared';

const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_ROOM: {
    getByName: vi.fn()
  }
};

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

  it('allows development authentication only in an unguarded development environment', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      env
    );
    expect(response.status).toBe(200);
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

  it('reports assistant configuration without exposing secrets', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status'),
      withEnabledDeploymentAssistant({
        AI_API_KEY: 'secret-test-value',
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

  it('exposes assistant status without an email-code session', async () => {
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
      configured: true,
      provider: 'openrouter'
    });
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
        displayName: request.headers.get('x-openzcad-display-name')
      })
    );
    env.PROJECT_ROOM.getByName.mockReturnValueOnce({ fetch: roomFetch });

    const response = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${created.project.projectId}/collaboration`,
        { headers: { upgrade: 'websocket' } }
      ),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: 'user_beta_dev',
      displayName: 'Beta developer'
    });
    expect(roomFetch).toHaveBeenCalledOnce();
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

  it('does not limit repeated public assistant requests', async () => {
    const providerFetch = vi.fn(
      async () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', providerFetch);
    const publicEnv = withEnabledDeploymentAssistant({
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://models.example.test/v1/responses',
      // Old deployments may retain these vars. They must no longer cap turns.
      AI_RATE_LIMIT_REQUESTS: '1',
      AI_RATE_LIMIT_WINDOW_SECONDS: '3600'
    });
    const request = () =>
      new Request('https://example.com/api/assistant/proposals', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.42' },
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
      });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await worker.fetch(request(), publicEnv);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    expect(providerFetch).toHaveBeenCalledTimes(3);
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
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://models.example.test/v1/responses',
      AI_RATE_LIMIT_REQUESTS: '1',
      AI_RATE_LIMIT_WINDOW_SECONDS: '3600'
    });
    const request = () =>
      new Request('https://example.com/api/assistant/proposals', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.42' },
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
});
