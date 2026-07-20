import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import type { CreateProjectResponse, ProjectDocument } from '@openzcad/shared';

const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  PROJECT_ROOM: {
    getByName: vi.fn()
  }
};

function post(path: string, body: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function createProject(name: string): Promise<CreateProjectResponse> {
  const response = await worker.fetch(
    post('/api/projects', { name }),
    env
  );
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

  it('returns health', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      env
    );
    expect(response.status).toBe(200);
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

  it('reports assistant configuration without exposing secrets', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/assistant/status'),
      {
        ...env,
        AI_API_KEY: 'secret-test-value',
        AI_MODEL: 'model-test'
      }
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

  it('requires Cloudflare Access identity when configured', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/projects'),
      { ...env, AUTH_MODE: 'cloudflare-access' } as never
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
    const response = await worker.fetch(
      post('/api/projects', {}),
      env
    );
    expect(response.status).toBe(400);

    const blankResponse = await worker.fetch(
      post('/api/projects', { name: '   ' }),
      env
    );
    expect(blankResponse.status).toBe(400);
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
});
