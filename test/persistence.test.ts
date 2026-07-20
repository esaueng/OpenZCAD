import { describe, expect, it } from 'vitest';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError
} from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

const userId = toUserId('user_test');

describe('in-memory persistence', () => {
  it('rejects revisions for unknown projects', async () => {
    const service = new InMemoryPersistenceService();
    const document = createProjectDocument('Ghost', userId);
    await expect(
      service.saveRevision(userId, {
        projectId: document.projectId,
        reason: 'Save',
        document
      })
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('round-trips a created project through save and load', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Round Trip' });
    const saved = await service.saveRevision(userId, {
      projectId: created.document.projectId,
      reason: 'Save',
      document: created.document
    });
    expect(saved.projectId).toBe(created.document.projectId);
    expect(saved.checkpoints.at(-1)?.reason).toBe('Save');
    const loaded = await service.loadProject(
      userId,
      created.document.projectId
    );
    expect(loaded?.name).toBe('Round Trip');
    expect(loaded?.schemaVersion).toBe(3);
  });

  it('sanitizes file names in upload object keys', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Uploads' });
    const { session } = await service.createUploadSession(userId, {
      projectId: created.document.projectId,
      fileName: '../../etc/evil name.stl',
      contentType: 'model/stl'
    });
    expect(session.objectKey).toContain('evil-name.stl');
    expect(session.objectKey).not.toContain('..');
    expect(
      session.objectKey.startsWith(`${created.document.projectId}/uploads/`)
    ).toBe(true);
  });

  it('consumes upload sessions on finalize and rejects unknown or reused sessions', async () => {
    const service = new InMemoryPersistenceService();
    const projectId = (await service.createProject(userId, { name: 'Imports' }))
      .document.projectId;
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

  it("does not reveal or mutate another user's projects", async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_owner');
    const intruder = toUserId('user_intruder');
    const created = await service.createProject(owner, { name: 'Private' });

    expect(
      await service.loadProject(intruder, created.document.projectId)
    ).toBeNull();
    expect((await service.listProjects(intruder)).projects).toHaveLength(0);
    await expect(
      service.saveRevision(intruder, {
        projectId: created.document.projectId,
        reason: 'Unauthorized',
        document: created.document
      })
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
