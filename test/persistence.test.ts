import { describe, expect, it } from 'vitest';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError
} from '@openzcad/persistence';
import type { RevisionConflictError } from '@openzcad/persistence';
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
      expectedVersion: document.version,
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
      expectedVersion: created.document.version,
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

  it('rejects stale revision writes without replacing the newer document', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Guarded Save' });
    const newerDocument = { ...created.document, version: created.document.version + 1 };

    await service.saveRevision(userId, {
      projectId: created.document.projectId,
      reason: 'Newer save',
      expectedVersion: created.document.version,
      document: newerDocument
    });

    await expect(
      service.saveRevision(userId, {
        projectId: created.document.projectId,
        reason: 'Stale save',
        expectedVersion: created.document.version,
        document: { ...newerDocument, version: newerDocument.version + 1 }
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<RevisionConflictError>>({
        currentVersion: newerDocument.version
      })
    );

    expect((await service.loadProject(userId, created.document.projectId))?.version).toBe(
      newerDocument.version
    );
  });

  it('sanitizes file names in upload object keys', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Uploads' });
    const { session } = await service.createUploadSession(userId, {
      projectId: created.document.projectId,
      fileName: '../../etc/evil name.stl',
      contentType: 'model/stl',
      kind: 'stl-import'
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
      contentType: 'model/stl',
      kind: 'stl-import'
    });

    const request = {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId,
    };

    await service.putUpload(
      userId,
      session.uploadSessionId,
      new TextEncoder().encode('solid part').buffer
    );
    const artifact = await service.finalizeArtifact(userId, request);
    expect(artifact?.kind).toBe('stl-import');
    expect(artifact?.objectKey).toBe(session.objectKey);

    // The session was consumed; finalizing again must fail.
    expect(await service.finalizeArtifact(userId, request)).toBeNull();
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
        expectedVersion: created.document.version,
        document: created.document
      })
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
