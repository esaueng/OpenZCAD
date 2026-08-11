import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError
} from '@openzcad/persistence';
import type { RevisionConflictError } from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import {
  projectOrganization,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  TRASH_RETENTION_MS
} from '@openzcad/shared';

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
    expect(loaded?.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
  });

  it('resolves owner, editor, and viewer access without changing ownership', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_owner');
    const editor = toUserId('user_editor');
    const viewer = toUserId('user_viewer');
    const unrelated = toUserId('user_unrelated');
    const created = await service.createProject(owner, { name: 'Shared' });
    const projectId = created.document.projectId;

    await service.setProjectMemberRole(owner, projectId, editor, 'editor');
    await service.setProjectMemberRole(owner, projectId, viewer, 'viewer');

    await expect(
      service.requireProjectOwner(owner, projectId)
    ).resolves.toEqual(
      expect.objectContaining({ ownerUserId: owner, role: 'owner' })
    );
    await expect(
      service.requireProjectEdit(editor, projectId)
    ).resolves.toEqual(
      expect.objectContaining({ ownerUserId: owner, role: 'editor' })
    );
    await expect(
      service.requireProjectRead(viewer, projectId)
    ).resolves.toEqual(
      expect.objectContaining({ ownerUserId: owner, role: 'viewer' })
    );

    const edited = await service.saveRevision(editor, {
      projectId,
      reason: 'Editor save',
      expectedVersion: created.document.version,
      document: { ...created.document, name: 'Edited by member' }
    });
    expect(edited.ownerUserId).toBe(owner);
    expect((await service.loadProject(owner, projectId))?.ownerUserId).toBe(
      owner
    );
    expect((await service.loadProject(viewer, projectId))?.name).toBe(
      'Edited by member'
    );

    await expect(
      service.saveRevision(viewer, {
        projectId,
        reason: 'Viewer save',
        expectedVersion: edited.version,
        document: edited
      })
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      service.createUploadSession(viewer, {
        projectId,
        fileName: 'viewer.stl',
        contentType: 'model/stl',
        kind: 'stl-import'
      })
    ).rejects.toThrow(ProjectNotFoundError);
    const { session } = await service.createUploadSession(owner, {
      projectId,
      fileName: 'shared.stl',
      contentType: 'model/stl',
      kind: 'stl-import'
    });
    const body = new TextEncoder().encode('solid shared').buffer;
    await expect(
      service.putUpload(viewer, session.uploadSessionId, body)
    ).rejects.toThrow(ProjectNotFoundError);
    await service.putUpload(owner, session.uploadSessionId, body);
    const finalizeRequest = {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    };
    await expect(
      service.finalizeArtifact(viewer, finalizeRequest)
    ).rejects.toThrow(ProjectNotFoundError);
    const artifact = await service.finalizeArtifact(owner, finalizeRequest);
    expect(artifact).not.toBeNull();
    await expect(service.listArtifacts(viewer, projectId)).resolves.toEqual({
      artifacts: [artifact]
    });
    await expect(
      service.getArtifactMetadata(viewer, session.artifactId)
    ).resolves.toEqual({ artifact });
    await expect(
      service.downloadArtifact(viewer, session.artifactId)
    ).resolves.toEqual({ artifact, body });
    await expect(
      service.requireProjectOwner(editor, projectId)
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      service.setProjectMemberRole(editor, projectId, unrelated, 'viewer')
    ).rejects.toThrow(ProjectNotFoundError);

    expect((await service.listProjects(editor)).projects).toHaveLength(1);
    expect((await service.listProjects(viewer)).projects).toHaveLength(1);
    expect(await service.loadProject(unrelated, projectId)).toBeNull();
    expect((await service.listProjects(unrelated)).projects).toHaveLength(0);
    await expect(
      service.requireProjectRead(unrelated, projectId)
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('rejects editor attempts to replace the authoritative document owner', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_owner_immutable');
    const editor = toUserId('user_editor_immutable');
    const created = await service.createProject(owner, { name: 'Owned' });
    await service.setProjectMemberRole(
      owner,
      created.document.projectId,
      editor,
      'editor'
    );

    await expect(
      service.saveRevision(editor, {
        projectId: created.document.projectId,
        reason: 'Ownership takeover',
        expectedVersion: created.document.version,
        document: { ...created.document, ownerUserId: editor }
      })
    ).rejects.toThrow(ProjectNotFoundError);
    expect(
      (await service.loadProject(owner, created.document.projectId))
        ?.ownerUserId
    ).toBe(owner);
  });

  it('rejects stale revision writes without replacing the newer document', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, {
      name: 'Guarded Save'
    });
    const newerDocument = {
      ...created.document,
      version: created.document.version + 1
    };

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

    expect(
      (await service.loadProject(userId, created.document.projectId))?.version
    ).toBe(newerDocument.version);
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
      artifactId: session.artifactId
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
    await expect(
      service.updateProject(intruder, {
        projectId: created.document.projectId,
        status: 'deleted'
      })
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      service.duplicateProject(intruder, {
        projectId: created.document.projectId
      })
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      service.deleteProject(intruder, created.document.projectId)
    ).rejects.toThrow(ProjectNotFoundError);
    await service.reorderProjects(intruder, {
      projectIds: [created.document.projectId]
    });
    expect(
      projectOrganization((await service.listProjects(owner)).projects[0]!)
        .sortOrder
    ).toBe(0);
  });
});

describe('project shelves', () => {
  it('copies a project with its feature history under a new id', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Bracket' });
    const copy = await service.duplicateProject(userId, {
      projectId: created.document.projectId
    });

    expect(copy.document.projectId).not.toBe(created.document.projectId);
    expect(copy.document.name).toBe('Bracket (copy)');
    expect(copy.document.ownerUserId).toBe(userId);
    expect(Object.keys(copy.document.nodes)).toEqual(
      Object.keys(created.document.nodes)
    );
    expect(copy.document.checkpoints.at(-1)?.reason).toBe(
      'Duplicated from Bracket'
    );

    // The copy is independent: editing it leaves the original alone.
    await service.saveRevision(userId, {
      projectId: copy.document.projectId,
      reason: 'Diverge',
      expectedVersion: copy.document.version,
      document: { ...copy.document, name: 'Diverged' }
    });
    expect(
      (await service.loadProject(userId, created.document.projectId))?.name
    ).toBe('Bracket');
  });

  it('moves a project to the bin and back without destroying it', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, {
      name: 'Recoverable'
    });

    const binned = await service.updateProject(userId, {
      projectId: created.document.projectId,
      status: 'deleted'
    });
    expect(projectOrganization(binned).status).toBe('deleted');
    expect(projectOrganization(binned).deletedAt).toBeTruthy();
    // Still fully loadable — the bin hides projects, it does not shred them.
    expect(
      await service.loadProject(userId, created.document.projectId)
    ).not.toBeNull();

    const restored = await service.updateProject(userId, {
      projectId: created.document.projectId,
      status: 'active'
    });
    expect(projectOrganization(restored).status).toBe('active');
    expect(projectOrganization(restored).deletedAt).toBeUndefined();
  });

  it('purges only the binned projects whose window has closed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const service = new InMemoryPersistenceService();
      const expired = await service.createProject(userId, { name: 'Expired' });
      const recent = await service.createProject(userId, { name: 'Recent' });
      const active = await service.createProject(userId, { name: 'Active' });

      await service.updateProject(userId, {
        projectId: expired.document.projectId,
        status: 'deleted'
      });

      // One full retention window later, a second project goes in the bin. The
      // first is now due; the second has its whole window ahead of it.
      vi.setSystemTime(new Date(Date.now() + TRASH_RETENTION_MS));
      await service.updateProject(userId, {
        projectId: recent.document.projectId,
        status: 'deleted'
      });

      const purged = await service.purgeExpiredProjects(userId);
      expect(purged).toEqual([expired.document.projectId]);
      expect(
        await service.loadProject(userId, expired.document.projectId)
      ).toBeNull();
      expect(
        await service.loadProject(userId, recent.document.projectId)
      ).not.toBeNull();
      expect(
        await service.loadProject(userId, active.document.projectId)
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a project and its artifacts on a permanent delete', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Doomed' });
    const projectId = created.document.projectId;
    const { session } = await service.createUploadSession(userId, {
      projectId,
      fileName: 'part.stl',
      contentType: 'model/stl',
      kind: 'stl-import'
    });
    await service.putUpload(
      userId,
      session.uploadSessionId,
      new TextEncoder().encode('solid part').buffer
    );
    const artifact = await service.finalizeArtifact(userId, {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    });

    await service.deleteProject(userId, projectId);
    expect(await service.loadProject(userId, projectId)).toBeNull();
    expect(
      (await service.getArtifactMetadata(userId, artifact!.artifactId)).artifact
    ).toBeNull();
    await expect(service.deleteProject(userId, projectId)).rejects.toThrow(
      ProjectNotFoundError
    );
  });

  it('lists only the latest thumbnail and exposes it on the project summary', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Previewed' });
    const projectId = created.document.projectId;
    const artifactIds: string[] = [];

    for (const bytes of ['first', 'second']) {
      const { session } = await service.createUploadSession(userId, {
        projectId,
        fileName: 'thumbnail.webp',
        contentType: 'image/webp',
        kind: 'thumbnail'
      });
      await service.putUpload(
        userId,
        session.uploadSessionId,
        new TextEncoder().encode(bytes).buffer
      );
      await service.finalizeArtifact(userId, {
        projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      });
      artifactIds.push(session.artifactId);
    }

    const artifacts = await service.listArtifacts(userId, projectId);
    expect(artifacts.artifacts.map(({ artifactId }) => artifactId)).toEqual([
      artifactIds[1]
    ]);
    expect((await service.listProjects(userId)).projects[0]).toMatchObject({
      thumbnailArtifactId: artifactIds[1]
    });
    await expect(
      service.getArtifactMetadata(userId, artifactIds[0]!)
    ).resolves.toEqual({ artifact: null });
  });

  it('orders pinned projects first and honours a manual reorder', async () => {
    const service = new InMemoryPersistenceService();
    const first = await service.createProject(userId, { name: 'First' });
    const second = await service.createProject(userId, { name: 'Second' });
    const third = await service.createProject(userId, { name: 'Third' });

    const listed = await service.reorderProjects(userId, {
      projectIds: [
        third.document.projectId,
        first.document.projectId,
        second.document.projectId
      ]
    });
    expect(listed.projects.map((project) => project.name)).toEqual([
      'Third',
      'First',
      'Second'
    ]);

    await service.updateProject(userId, {
      projectId: second.document.projectId,
      pinned: true
    });
    expect(
      (await service.listProjects(userId)).projects.map(
        (project) => project.name
      )
    ).toEqual(['Second', 'Third', 'First']);
  });
});
