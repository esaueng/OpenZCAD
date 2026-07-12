import { describe, expect, it } from 'vitest';
import {
  createPersistenceService,
  resolveCollaborationDocument
} from '@openzcad/cloudflare-adapters';
import { toUserId } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';

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

  it('accepts newer collaboration documents and rejects divergent peers', () => {
    const base = createProjectDocument('Room', toUserId('user_room'));
    const first = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const divergent = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const newer = addPrimitiveFeature(first, {
      name: 'C',
      primitiveKind: 'cylinder',
      dimensions: { radius: 1, height: 2 }
    });

    expect(resolveCollaborationDocument(null, first).kind).toBe('accept');
    expect(resolveCollaborationDocument(first, newer).kind).toBe('accept');
    expect(resolveCollaborationDocument(first, first).kind).toBe('same');
    expect(resolveCollaborationDocument(first, divergent).kind).toBe(
      'conflict'
    );
  });
});
