import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError,
  RevisionNotFoundError,
  ArtifactQuotaError
} from '@openzcad/persistence';
import type { RevisionConflictError } from '@openzcad/persistence';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  MAX_PROJECT_REVISIONS,
  MAX_THUMBNAIL_BYTES,
  projectOrganization,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toRevisionId,
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

  it('refuses to finalize an oversized thumbnail', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Previewed' });
    const projectId = created.document.projectId;
    const { session } = await service.createUploadSession(userId, {
      projectId,
      fileName: 'thumbnail.webp',
      contentType: 'image/webp',
      kind: 'thumbnail'
    });
    await expect(
      service.createMultipartUpload(userId, session.uploadSessionId)
    ).rejects.toThrow('must use single uploads');
    await service.putUpload(
      userId,
      session.uploadSessionId,
      new Uint8Array(MAX_THUMBNAIL_BYTES + 1).buffer
    );

    await expect(
      service.finalizeArtifact(userId, {
        projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      })
    ).rejects.toThrow('invalid or too large');
    expect(
      (await service.listProjects(userId)).projects[0]?.thumbnailArtifactId
    ).toBeUndefined();
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

  it('refuses uploads beyond the account artifact byte ceiling', async () => {
    // Injected tiny limit: the production ceiling is gigabytes, and the test
    // only needs the arithmetic, not the allocation.
    const service = new InMemoryPersistenceService(24);
    const created = await service.createProject(userId, { name: 'Quota' });
    const projectId = created.document.projectId;

    const first = await service.createUploadSession(userId, {
      projectId,
      fileName: 'a.stl',
      contentType: 'model/stl',
      kind: 'stl-import'
    });
    const sixteenBytes = new ArrayBuffer(16);
    await service.putUpload(userId, first.session.uploadSessionId, sixteenBytes);
    await service.finalizeArtifact(userId, {
      projectId,
      uploadSessionId: first.session.uploadSessionId,
      artifactId: first.session.artifactId
    });

    const usage = await service.getStorageUsage(userId);
    expect(usage.artifactBytes).toBe(16);
    expect(usage.artifactCount).toBe(1);
    expect(usage.artifactLimitBytes).toBe(24);

    // A second 16-byte upload would land at 32 > 24: the single-shot PUT is
    // refused up front, and a body that slips to finalize is refused there
    // with the staged object discarded.
    const second = await service.createUploadSession(userId, {
      projectId,
      fileName: 'b.stl',
      contentType: 'model/stl',
      kind: 'stl-import'
    });
    await expect(
      service.putUpload(userId, second.session.uploadSessionId, sixteenBytes)
    ).rejects.toThrow(ArtifactQuotaError);

    // Within the remaining 8 bytes, uploads still work.
    await service.putUpload(
      userId,
      second.session.uploadSessionId,
      new ArrayBuffer(8)
    );
    const finalized = await service.finalizeArtifact(userId, {
      projectId,
      uploadSessionId: second.session.uploadSessionId,
      artifactId: second.session.artifactId
    });
    expect(finalized?.bytes).toBe(8);

    // At the ceiling, even opening a new session is refused.
    await expect(
      service.createUploadSession(userId, {
        projectId,
        fileName: 'c.stl',
        contentType: 'model/stl',
        kind: 'stl-import'
      })
    ).rejects.toThrow(ArtifactQuotaError);
  });
});

describe('save-state history', () => {
  /**
   * A project with two explicit saves, the second holding a box the first did
   * not.
   */
  async function projectWithTwoSaves(service: InMemoryPersistenceService) {
    const created = await service.createProject(userId, { name: 'Bracket' });
    const first = await service.saveRevision(userId, {
      projectId: created.document.projectId,
      reason: 'First save',
      expectedVersion: created.document.version,
      document: created.document
    });
    const boxed = addPrimitiveFeature(first, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 10 }
    });
    const second = await service.saveRevision(userId, {
      projectId: boxed.projectId,
      reason: 'Second save',
      expectedVersion: first.version,
      document: boxed
    });
    return { projectId: created.document.projectId, first, second };
  }

  it('lists explicit saves newest first, with their authors', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId } = await projectWithTwoSaves(service);

    const listed = await service.listRevisions(userId, projectId);
    expect(listed.revisions.map((revision) => revision.reason)).toEqual([
      'Second save',
      'First save'
    ]);
    expect(listed.revisions[0]?.authorUserId).toBe(userId);
    expect(listed.revisions[0]?.documentBytes).toBeGreaterThan(0);
  });

  it('gives back the model a save held, not the current one', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId, first, second } = await projectWithTwoSaves(service);

    const restored = await service.loadRevision(
      userId,
      projectId,
      first.revisions.at(-1)!.revisionId
    );
    expect(restored?.featureOrder).toEqual([]);
    expect(second.featureOrder).toHaveLength(1);
  });

  it('reports a save it no longer stores rather than failing', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId } = await projectWithTwoSaves(service);

    // Retention prunes stored documents while the checkpoints naming them stay
    // inside the project, so callers must be able to ask about one that is
    // gone.
    await expect(
      service.loadRevision(userId, projectId, 'rev_never_stored')
    ).resolves.toBeNull();
  });

  it('refuses history to somebody with no access to the project', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId } = await projectWithTwoSaves(service);

    await expect(
      service.listRevisions(toUserId('user_intruder'), projectId)
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('branches a save state into a project of its own', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId, first } = await projectWithTwoSaves(service);
    const revisionId = first.revisions.at(-1)!.revisionId;

    const branch = await service.duplicateProject(userId, {
      projectId,
      revisionId
    });

    // The copy holds the older model...
    expect(branch.document.featureOrder).toEqual([]);
    expect(branch.document.projectId).not.toBe(projectId);
    expect(branch.document.branchedFrom?.revisionId).toBe(revisionId);
    expect(branch.document.branchedFrom?.checkpointReason).toBe('First save');
    // ...and the project it came from is untouched by the branching.
    const source = await service.loadProject(userId, projectId);
    expect(source?.featureOrder).toHaveLength(1);
  });

  it('copies the current document when no save state is named', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId } = await projectWithTwoSaves(service);

    const copy = await service.duplicateProject(userId, { projectId });
    expect(copy.document.featureOrder).toHaveLength(1);
    expect(copy.document.branchedFrom).toBeUndefined();
  });

  it('refuses to branch a save state it no longer stores', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId } = await projectWithTwoSaves(service);

    // Silently copying the current model instead would hand back a project
    // that is not the one the user picked, and looks right until they open it.
    await expect(
      service.duplicateProject(userId, {
        projectId,
        revisionId: toRevisionId('rev_never_stored')
      })
    ).rejects.toThrow(RevisionNotFoundError);
  });

  it('drops the oldest saves once a project passes the retention bound', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(userId, { name: 'Busy' });
    let document = created.document;
    for (let save = 0; save < MAX_PROJECT_REVISIONS + 5; save += 1) {
      document = await service.saveRevision(userId, {
        projectId: document.projectId,
        reason: `Save ${save}`,
        expectedVersion: document.version,
        document: addPrimitiveFeature(document, {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 1, depth: 1, height: 1 }
        })
      });
    }

    const listed = await service.listRevisions(userId, document.projectId);
    expect(listed.revisions).toHaveLength(MAX_PROJECT_REVISIONS);
    expect(listed.maxRevisions).toBe(MAX_PROJECT_REVISIONS);
    expect(listed.revisions.at(0)?.reason).toBe(
      `Save ${MAX_PROJECT_REVISIONS + 4}`
    );
    expect(listed.revisions.at(-1)?.reason).toBe('Save 5');
  });

  it('forgets a deleted project’s history with the project', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId } = await projectWithTwoSaves(service);
    await service.deleteProject(userId, projectId);

    await expect(service.listRevisions(userId, projectId)).rejects.toThrow(
      ProjectNotFoundError
    );
  });
});
