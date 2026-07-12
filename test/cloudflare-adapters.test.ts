import { describe, expect, it } from 'vitest';
import { createPersistenceService } from '@openzcad/cloudflare-adapters';
import { toUserId } from '@openzcad/shared';

describe('cloudflare adapters', () => {
  it('falls back to in-memory persistence when D1 is absent', async () => {
    const service = createPersistenceService({ ENVIRONMENT: 'beta' });
    const created = await service.createProject(toUserId('user_test'), {
      name: 'CF Test'
    });
    const listed = await service.listProjects(toUserId('user_test'));

    expect(created.project.name).toBe('CF Test');
    expect(
      listed.projects.some(
        (project) => project.projectId === created.project.projectId
      )
    ).toBe(true);
  });
});
