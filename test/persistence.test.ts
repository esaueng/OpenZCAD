import { describe, expect, it } from 'vitest';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError
} from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import { toProjectId, toUserId } from '@openzcad/shared';

const userId = toUserId('user_test');

describe('in-memory persistence', () => {
  it('rejects revisions for unknown projects', async () => {
    const service = new InMemoryPersistenceService();
    const document = createProjectDocument('Ghost', userId);
    await expect(
      service.saveRevision({
        projectId: document.projectId,
        reason: 'Save',
        document
      })
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('round-trips a created project through save and load', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Round Trip' });
    const saved = await service.saveRevision({
      projectId: created.document.projectId,
      reason: 'Save',
      document: created.document
    });
    expect(saved.projectId).toBe(created.document.projectId);
    expect(saved.checkpoints.at(-1)?.reason).toBe('Save');
    const loaded = await service.loadProject(created.document.projectId);
    expect(loaded?.name).toBe('Round Trip');
    expect(loaded?.schemaVersion).toBe(2);
  });

  it('sanitizes file names in upload object keys', async () => {
    const service = new InMemoryPersistenceService();
    const { session } = await service.createUploadSession(userId, {
      projectId: toProjectId('proj_x'),
      fileName: '../../etc/evil name.stl',
      contentType: 'model/stl'
    });
    expect(session.objectKey).toContain('evil-name.stl');
    expect(session.objectKey).not.toContain('..');
    expect(session.objectKey.startsWith('proj_x/uploads/')).toBe(true);
  });

  it('consumes upload sessions on finalize and rejects unknown or reused sessions', async () => {
    const service = new InMemoryPersistenceService();
    const projectId = toProjectId('proj_x');
    const { session } = await service.createUploadSession(userId, {
      projectId,
      fileName: 'part.stl',
      contentType: 'model/stl'
    });

    const request = {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId,
      fileName: 'part.stl',
      contentType: 'model/stl'
    };

    const artifact = await service.finalizeImport(userId, request);
    expect(artifact?.kind).toBe('stl-import');
    expect(artifact?.objectKey).toBe(session.objectKey);

    // The session was consumed; finalizing again must fail.
    expect(await service.finalizeImport(userId, request)).toBeNull();
  });
});
