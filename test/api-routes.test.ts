import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';

const env = {
  ENVIRONMENT: 'beta' as const,
  EXPORT_WORKFLOW: {
    create: vi.fn(async () => undefined)
  },
  PROJECT_ROOM: {
    getByName: vi.fn()
  }
};

describe('worker api routes', () => {
  it('creates and lists projects', async () => {
    const createResponse = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Worker Test' })
      }),
      env as never
    );
    const created = (await createResponse.json()) as { project: { projectId: string } };
    expect(createResponse.status).toBe(201);

    const listResponse = await worker.fetch(
      new Request('https://example.com/api/projects'),
      env as never
    );
    const listed = (await listResponse.json()) as { projects: Array<{ projectId: string }> };
    expect(listed.projects[0]?.projectId).toBe(created.project.projectId);
  });

  it('returns health', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      env as never
    );
    expect(response.status).toBe(200);
  });
});

