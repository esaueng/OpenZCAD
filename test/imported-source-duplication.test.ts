import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  D1R2PersistenceService,
  projectCopyDocumentDigest
} from '@openzcad/cloudflare-adapters';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  duplicateProjectDocument,
  archiveHistorySources
} from '@openzcad/document-core';
import {
  InMemoryPersistenceService,
  ArtifactQuotaError,
  ArtifactStorageError,
  ProjectNotFoundError,
  RevisionConflictError,
  reconcileCopiedImportSources,
  type PersistenceService
} from '@openzcad/persistence';
import {
  encodeImportedMeshPayload,
  importedSourceReferenceOf,
  toArtifactId,
  toUserId,
  type ArtifactRecord,
  type ProjectDocument
} from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';
import {
  createRoomContext,
  createTestRoom
} from './collaboration-room-harness';

const owner = toUserId('user_copy_owner');
const mesh = encodeImportedMeshPayload({
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2]
});
const reference = (bytes: Uint8Array<ArrayBuffer>) => ({
  marker: 'openzcad-source-ref' as const,
  version: 1 as const,
  hashAlgorithm: 'sha256' as const,
  checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  logicalBytes: bytes.byteLength
});

function memoryR2() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const multipart = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array<ArrayBuffer>> }
  >();
  let ids = 0;
  const resumed = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: async (partNumber: number, body: ArrayBuffer) => {
      const state = multipart.get(uploadId);
      if (!state) throw new Error('NoSuchUpload');
      state.parts.set(partNumber, new Uint8Array(body.slice(0)));
      return { partNumber, etag: `part-${partNumber}` };
    },
    complete: async (parts: { partNumber: number }[]) => {
      const state = multipart.get(uploadId);
      if (!state) throw new Error('NoSuchUpload');
      const chunks = parts.map((part) => state.parts.get(part.partNumber)!);
      const bytes = new Uint8Array(
        chunks.reduce((n, chunk) => n + chunk.length, 0)
      );
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      objects.set(key, bytes);
      multipart.delete(uploadId);
      return { key, size: bytes.byteLength };
    },
    abort: async () => {
      multipart.delete(uploadId);
    }
  });
  const bucket = {
    put: async (key: string, body: BodyInit) => {
      objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
      return null;
    },
    get: async (key: string) => {
      const bytes = objects.get(key);
      return bytes
        ? {
            size: bytes.length,
            body: new Response(bytes).body,
            arrayBuffer: async () => bytes.slice().buffer
          }
        : null;
    },
    head: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    createMultipartUpload: async (key: string) => {
      const uploadId = `multipart-${++ids}`;
      multipart.set(uploadId, { key, parts: new Map() });
      return resumed(key, uploadId);
    },
    resumeMultipartUpload: resumed
  } as unknown as R2Bucket;
  return { bucket, objects };
}

function d1Service(artifactLimitBytes?: number) {
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    owner,
    'copy-owner@example.com',
    '2026-01-01T00:00:00Z'
  );
  const r2 = memoryR2();
  const env = {
    DB: sqliteD1(db),
    ARTIFACTS: r2.bucket,
    PROJECT_SHARING_ENABLED: 'true',
    ...(artifactLimitBytes
      ? {
          PREMIUM_USER_EMAILS: 'copy-owner@example.com',
          PREMIUM_ARTIFACT_LIMIT_BYTES: String(artifactLimitBytes)
        }
      : {})
  };
  return {
    service: new D1R2PersistenceService(env),
    env,
    db,
    ...r2
  };
}

function roomBackedService() {
  const fixture = d1Service();
  const rooms = new Map<
    string,
    ReturnType<typeof createRoomContext> & {
      room: ReturnType<typeof createTestRoom>;
    }
  >();
  const roomFor = (projectId: string) => {
    let entry = rooms.get(projectId);
    if (!entry) {
      const state = createRoomContext();
      entry = {
        ...state,
        room: createTestRoom(state.context, fixture.env)
      };
      rooms.set(projectId, entry);
    }
    return entry;
  };
  const namespace = {
    getByName: (projectId: string) => ({
      fetch: (request: Request) => roomFor(projectId).room.fetch(request)
    })
  } as unknown as DurableObjectNamespace<ReturnType<typeof createTestRoom>>;
  return {
    ...fixture,
    service: new D1R2PersistenceService({
      ...fixture.env,
      PROJECT_ROOM: namespace
    }),
    roomFor
  };
}

function roomSnapshotRequest(
  document: ProjectDocument,
  baseVersion: number | null
) {
  return new Request(`https://room.test/?projectId=${document.projectId}`, {
    method: 'POST',
    headers: {
      'x-openzcad-user-id': owner,
      'x-openzcad-display-name': 'Copy owner',
      'x-openzcad-project-role': 'owner'
    },
    body: JSON.stringify({
      clientId: 'copy_room',
      baseVersion,
      document
    })
  });
}

async function importedProject(service: PersistenceService) {
  const { document: base } = await service.createProject(owner, {
    name: 'Scan'
  });
  const { session } = await service.createUploadSession(owner, {
    projectId: base.projectId,
    fileName: 'scan.stl.ozmesh',
    kind: 'mesh-payload',
    contentType: 'application/vnd.openzcad.mesh-payload'
  });
  await service.putUpload(owner, session.uploadSessionId, mesh.buffer);
  const artifact = await service.finalizeArtifact(owner, {
    projectId: base.projectId,
    uploadSessionId: session.uploadSessionId,
    artifactId: session.artifactId
  });
  if (!artifact) throw new Error('Source upload did not finalize.');
  const manager = new CommandManager(base);
  manager.execute(
    commandFactories.importMesh({
      name: 'Scan',
      sourceName: 'scan.stl',
      triangleCount: 1,
      meshPayloadRef: reference(mesh),
      artifactId: artifact.artifactId
    })
  );
  await service.saveDocument(owner, {
    projectId: base.projectId,
    expectedVersion: base.version,
    document: manager.document
  });
  return { document: manager.document, artifact, manager };
}

function importArtifactId(document: ProjectDocument) {
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature' && importedSourceReferenceOf(node.data)
  );
  if (!feature || feature.kind !== 'feature') throw new Error('No import.');
  return (feature.data as { artifactId: ArtifactRecord['artifactId'] })
    .artifactId;
}

async function independentlyArchiveMesh(
  service: PersistenceService,
  pending: ProjectDocument
) {
  const { session } = await service.createUploadSession(owner, {
    projectId: pending.projectId,
    fileName: 'independent.ozmesh',
    kind: 'mesh-payload',
    contentType: 'application/vnd.openzcad.mesh-payload'
  });
  await service.putUpload(owner, session.uploadSessionId, mesh.buffer);
  const artifact = (await service.finalizeArtifact(owner, {
    projectId: pending.projectId,
    uploadSessionId: session.uploadSessionId,
    artifactId: session.artifactId
  }))!;
  const feature = Object.values(pending.nodes).find(
    (node) => node.kind === 'feature' && importedSourceReferenceOf(node.data)
  )!;
  if (feature.kind !== 'feature') throw new Error('Expected import.');
  const archived = archiveHistorySources(pending, {
    featureId: feature.featureId,
    artifactId: artifact.artifactId
  });
  expect(archived.version).toBe(pending.version);
  await service.saveDocument(owner, {
    projectId: pending.projectId,
    expectedVersion: pending.version,
    document: archived
  });
  return { archived, artifact };
}

async function cleanupIdentity(
  db: ReturnType<typeof migratedDatabase>,
  document: ProjectDocument
) {
  const head = db
    .prepare(
      'SELECT document_json, document_object_id FROM projects WHERE id = ?'
    )
    .get(document.projectId) as {
    document_json: string;
    document_object_id: string | null;
  };
  return {
    documentDigest: await projectCopyDocumentDigest(document),
    documentJsonDigest: createHash('sha256')
      .update(head.document_json)
      .digest('hex'),
    documentObjectId: head.document_object_id
  };
}

describe.each(['memory', 'D1/R2'] as const)(
  '%s import duplication',
  (backend) => {
    it('owns shareable payload bytes that survive purging the original project', async () => {
      const service: PersistenceService =
        backend === 'memory'
          ? new InMemoryPersistenceService()
          : d1Service().service;
      const { document: source, artifact: original } =
        await importedProject(service);
      const copy = await service.duplicateProject(owner, {
        projectId: source.projectId
      });
      expect(copy.project.name).toBe(copy.document.name);
      expect(copy.project.documentVersion).toBe(copy.document.version);
      expect(copy.project.updatedAt).toBe(copy.document.derived.updatedAt);
      const artifactId = importArtifactId(copy.document);
      expect(artifactId).not.toBe(original.artifactId);
      const download = await service.downloadArtifact(owner, artifactId);
      expect(download?.artifact.projectId).toBe(copy.document.projectId);
      expect(download?.artifact.objectKey).not.toBe(original.objectKey);
      await service.createProjectShareLink(owner, copy.document.projectId, {
        shareLinkId: 'copy_share',
        tokenHash: 'copy_share_hash',
        mode: 'view',
        createdAt: Date.now()
      });
      await service.deleteProject(owner, source.projectId);
      const shared = await service.loadSharedProjectImportSource(
        'copy_share_hash',
        artifactId
      );
      expect(shared).not.toBeNull();
      expect(
        new Uint8Array(await new Response(shared!.body).arrayBuffer())
      ).toEqual(mesh);
      expect(
        await service.loadProject(owner, copy.document.projectId)
      ).not.toBeNull();
    });
  }
);

describe.each(['memory', 'D1/R2'] as const)(
  '%s import branch and rollback',
  (backend) => {
    it('branches referenced sources from the selected revision after they leave the current model', async () => {
      const service: PersistenceService =
        backend === 'memory'
          ? new InMemoryPersistenceService()
          : d1Service().service;
      const { document: source, artifact: original } =
        await importedProject(service);
      const saved = await service.saveRevision(owner, {
        projectId: source.projectId,
        expectedVersion: source.version,
        reason: 'With scan',
        document: source
      });
      const manager = new CommandManager(saved);
      manager.undo();
      expect(manager.document.featureOrder).toEqual([]);
      await service.saveDocument(owner, {
        projectId: source.projectId,
        expectedVersion: saved.version,
        document: manager.document
      });
      const branch = await service.duplicateProject(owner, {
        projectId: source.projectId,
        revisionId: saved.revisions.at(-1)!.revisionId
      });
      expect(branch.document.featureOrder).toHaveLength(1);
      expect(branch.document.branchedFrom?.checkpointReason).toBe('With scan');
      expect(importArtifactId(branch.document)).not.toBe(original.artifactId);
      await service.deleteProject(owner, source.projectId);
      const download = await service.downloadArtifact(
        owner,
        importArtifactId(branch.document)
      );
      expect(
        new Uint8Array(await new Response(download!.body).arrayBuffer())
      ).toEqual(mesh);
    });

    it('charges copied bytes to quota and removes the incomplete destination on refusal', async () => {
      const limit = mesh.byteLength * 2 - 1;
      const service: PersistenceService =
        backend === 'memory'
          ? new InMemoryPersistenceService(limit)
          : d1Service(limit).service;
      const { document: source, artifact } = await importedProject(service);
      const before = await service.getStorageUsage(owner);
      await expect(
        service.duplicateProject(owner, { projectId: source.projectId })
      ).rejects.toBeInstanceOf(ArtifactQuotaError);
      const after = await service.getStorageUsage(owner);
      expect(after.projectCount).toBe(before.projectCount);
      expect(after.artifactBytes).toBe(before.artifactBytes);
      expect(after.artifactCount).toBe(before.artifactCount);
      expect(await service.loadProject(owner, source.projectId)).toEqual(
        source
      );
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
    });

    it('publishes owned sources without replacing concurrent destination edits', async () => {
      const service: PersistenceService =
        backend === 'memory'
          ? new InMemoryPersistenceService()
          : d1Service().service;
      const { document: source } = await importedProject(service);
      const complete = service.completeMultipartUpload.bind(service);
      let editedId = '';
      vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
        async (...args) => {
          await complete(...args);
          const list = await service.listProjects(owner);
          const target = list.projects.find(
            (project) => project.projectId !== source.projectId
          )!;
          editedId = target.projectId;
          const pending = (await service.loadProject(owner, editedId))!;
          const editor = new CommandManager(pending);
          editor.execute(
            commandFactories.addPrimitive({
              name: 'Concurrent work',
              primitiveKind: 'box',
              dimensions: { width: 1, height: 2, depth: 3 }
            })
          );
          await service.saveDocument(owner, {
            projectId: pending.projectId,
            expectedVersion: pending.version,
            document: editor.document
          });
        }
      );
      const completed = await service.duplicateProject(owner, {
        projectId: source.projectId
      });
      const kept = await service.loadProject(owner, editedId);
      expect(kept?.featureOrder).toHaveLength(2);
      expect(
        Object.values(kept!.nodes).some(
          (node) => node.name === 'Concurrent work'
        )
      ).toBe(true);
      expect(completed.document.featureOrder).toHaveLength(2);
      expect(importArtifactId(completed.document)).not.toMatch(
        /^artifact_local_/
      );
      expect((await service.listProjects(owner)).projects).toHaveLength(2);
    });

    it('keeps independently acknowledged archival whose document version is unchanged', async () => {
      const service: PersistenceService =
        backend === 'memory'
          ? new InMemoryPersistenceService()
          : d1Service().service;
      const { document: source } = await importedProject(service);
      const complete = service.completeMultipartUpload.bind(service);
      let kept: ProjectDocument | null = null;
      vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
        async (...args) => {
          await complete(...args);
          const target = (await service.listProjects(owner)).projects.find(
            (project) => project.projectId !== source.projectId
          )!;
          const pending = (await service.loadProject(owner, target.projectId))!;
          kept = (await independentlyArchiveMesh(service, pending)).archived;
          throw new ArtifactStorageError('Original copy transport failed');
        }
      );
      await expect(
        service.duplicateProject(owner, { projectId: source.projectId })
      ).rejects.toBeInstanceOf(RevisionConflictError);
      expect((await service.listProjects(owner)).projects).toHaveLength(2);
      expect(await service.loadProject(owner, kept!.projectId)).toEqual(kept);
      const download = await service.downloadArtifact(
        owner,
        importArtifactId(kept!)
      );
      expect(
        new Uint8Array(await new Response(download!.body).arrayBuffer())
      ).toEqual(mesh);
    });

    it('prefers independently archived owned sources when completing a same-version head', async () => {
      const service: PersistenceService =
        backend === 'memory'
          ? new InMemoryPersistenceService()
          : d1Service().service;
      const { document: source } = await importedProject(service);
      const complete = service.completeMultipartUpload.bind(service);
      let preferred = '';
      vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
        async (...args) => {
          await complete(...args);
          const target = (await service.listProjects(owner)).projects.find(
            (project) => project.projectId !== source.projectId
          )!;
          const pending = (await service.loadProject(owner, target.projectId))!;
          preferred = (await independentlyArchiveMesh(service, pending))
            .artifact.artifactId;
        }
      );
      const completed = await service.duplicateProject(owner, {
        projectId: source.projectId
      });
      expect(importArtifactId(completed.document)).toBe(preferred);
      await service.deleteProject(owner, source.projectId);
      const download = await service.downloadArtifact(
        owner,
        importArtifactId(completed.document)
      );
      expect(
        new Uint8Array(await new Response(download!.body).arrayBuffer())
      ).toEqual(mesh);
    });

    it.each(['autosave', 'checkpoint'] as const)(
      'keeps copied source aliases portable through a late %s',
      async (kind) => {
        const service: PersistenceService =
          backend === 'memory'
            ? new InMemoryPersistenceService()
            : d1Service().service;
        const { document: source } = await importedProject(service);
        const completed = await service.duplicateProject(owner, {
          projectId: source.projectId
        });
        const archivedId = importArtifactId(completed.document);
        const stale = JSON.parse(
          JSON.stringify(completed.document, (key, value: unknown) =>
            key === 'artifactId' && value === archivedId
              ? `artifact_local_${reference(mesh).checksumSha256}`
              : value
          )
        ) as ProjectDocument;
        const request = {
          projectId: completed.document.projectId,
          expectedVersion: completed.document.version,
          document: stale
        };
        if (kind === 'autosave') await service.saveDocument(owner, request);
        else
          await service.saveRevision(owner, {
            ...request,
            reason: 'Late checkpoint'
          });
        const saved = (await service.loadProject(
          owner,
          completed.document.projectId
        ))!;
        expect(importArtifactId(saved)).toBe(archivedId);
        expect(JSON.stringify(saved.commandLog)).not.toContain(
          'artifact_local_'
        );
        await service.deleteProject(owner, source.projectId);
        const download = await service.downloadArtifact(
          owner,
          importArtifactId(saved)
        );
        expect(
          new Uint8Array(await new Response(download!.body).arrayBuffer())
        ).toEqual(mesh);
      }
    );

    it('refuses damaged source bytes without retaining a destination or new artifacts', async () => {
      const fixture =
        backend === 'memory'
          ? { service: new InMemoryPersistenceService() }
          : d1Service();
      const service: PersistenceService = fixture.service;
      const { document: source, artifact } = await importedProject(service);
      const before = await service.getStorageUsage(owner);
      const load = service.downloadArtifact.bind(service);
      const beforeObjects =
        'objects' in fixture ? [...fixture.objects.keys()].sort() : null;
      const damaged = mesh.slice();
      damaged[0] = damaged[0]! ^ 0xff;
      vi.spyOn(service, 'downloadArtifact').mockImplementationOnce(
        async (...args) => ({ ...(await load(...args))!, body: damaged.buffer })
      );
      await expect(
        service.duplicateProject(owner, { projectId: source.projectId })
      ).rejects.toBeInstanceOf(ArtifactStorageError);
      const after = await service.getStorageUsage(owner);
      expect(after.projectCount).toBe(before.projectCount);
      expect(after.artifactBytes).toBe(before.artifactBytes);
      expect(after.artifactCount).toBe(before.artifactCount);
      const unchanged = await service.downloadArtifact(
        owner,
        artifact.artifactId
      );
      expect(
        new Uint8Array(await new Response(unchanged!.body).arrayBuffer())
      ).toEqual(mesh);
      if ('db' in fixture) {
        expect(
          fixture.db
            .prepare('SELECT COUNT(*) AS count FROM upload_sessions')
            .get()
        ).toEqual({ count: 0 });
        expect([...fixture.objects.keys()].sort()).toEqual(beforeObjects);
      }
    });
  }
);

it('reconciles distinct sources of one feature across undo/redo by content identity', () => {
  const second = encodeImportedMeshPayload({
    vertices: [0, 0, 0, 2, 0, 0, 0, 2, 0],
    indices: [0, 1, 2]
  });
  const a = reference(mesh);
  const b = reference(second);
  const manager = new CommandManager(
    createProjectDocument('Source history', owner)
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Scan',
      sourceName: 'first.stl',
      triangleCount: 1,
      artifactId: `artifact_local_${a.checksumSha256}`,
      meshPayloadRef: a
    })
  );
  const feature = Object.values(manager.document.nodes).find(
    (node) => node.kind === 'feature'
  )!;
  if (feature.kind !== 'feature') throw new Error('Expected import.');
  manager.execute(
    commandFactories.updateFeature({
      featureId: feature.featureId,
      data: {
        artifactId: toArtifactId(`artifact_local_${b.checksumSha256}`),
        meshPayloadRef: b
      }
    })
  );
  const original = manager.document;
  const rewritten = reconcileCopiedImportSources(original, [
    {
      projectId: original.projectId,
      kind: 'mesh-payload',
      checksumSha256: a.checksumSha256,
      logicalBytes: a.logicalBytes,
      artifactId: toArtifactId('artifact_owned_first')
    },
    {
      projectId: original.projectId,
      kind: 'mesh-payload',
      checksumSha256: b.checksumSha256,
      logicalBytes: b.logicalBytes,
      artifactId: toArtifactId('artifact_owned_second')
    }
  ]);
  expect(rewritten.derived).toBe(original.derived);
  const replay = new CommandManager(rewritten);
  expect(importArtifactId(replay.document)).toBe('artifact_owned_second');
  replay.undo();
  expect(importArtifactId(replay.document)).toBe('artifact_owned_first');
  replay.redo();
  expect(importArtifactId(replay.document)).toBe('artifact_owned_second');
  expect(importArtifactId(original)).toBe(`artifact_local_${b.checksumSha256}`);
});

it('a viewer receives independently owned STEP and mesh bytes and can share them after access is removed', async () => {
  const { service, db } = d1Service();
  const viewer = toUserId('user_copy_viewer');
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    viewer,
    'copy-viewer@example.com',
    '2026-01-01T00:00:00Z'
  );
  const { document: source, manager } = await importedProject(service);
  const step = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;');
  const { session } = await service.createUploadSession(owner, {
    projectId: source.projectId,
    fileName: 'part.step',
    contentType: 'model/step',
    kind: 'step-import'
  });
  await service.putUpload(owner, session.uploadSessionId, step.buffer);
  const artifact = await service.finalizeArtifact(owner, {
    projectId: source.projectId,
    artifactId: session.artifactId,
    uploadSessionId: session.uploadSessionId
  });
  manager.execute(
    commandFactories.importStep({
      name: 'Exact source',
      sourceName: 'part.step',
      artifactId: artifact!.artifactId,
      stepSourceRef: reference(step)
    })
  );
  await service.saveDocument(owner, {
    projectId: source.projectId,
    expectedVersion: source.version,
    document: manager.document
  });
  db.prepare(
    'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(source.projectId, viewer, 'viewer', owner, 1, 1);
  const copy = await service.duplicateProject(viewer, {
    projectId: source.projectId
  });
  const copiedArtifacts = await service.listArtifacts(
    viewer,
    copy.document.projectId
  );
  expect(copiedArtifacts.artifacts.map((entry) => entry.kind).sort()).toEqual([
    'mesh-payload',
    'step-import'
  ]);
  expect((await service.getStorageUsage(viewer)).artifactBytes).toBe(
    mesh.byteLength + step.byteLength
  );
  await service.createProjectShareLink(viewer, copy.document.projectId, {
    shareLinkId: 'viewer_share',
    tokenHash: 'viewer_hash',
    mode: 'view',
    createdAt: Date.now()
  });
  await service.deleteProject(owner, source.projectId);
  for (const archived of copiedArtifacts.artifacts) {
    const shared = await service.loadSharedProjectImportSource(
      'viewer_hash',
      archived.artifactId
    );
    expect(shared).not.toBeNull();
    const bytes = new Uint8Array(
      await new Response(shared!.body).arrayBuffer()
    );
    expect(bytes).toEqual(archived.kind === 'mesh-payload' ? mesh : step);
  }
});

it('streams a STEP source larger than one upload part into independently owned bytes', async () => {
  const { service } = d1Service();
  const { document: base } = await service.createProject(owner, {
    name: 'Large source'
  });
  const bytes = new Uint8Array(18 * 1024 * 1024 + 3).fill(32);
  bytes.set(new TextEncoder().encode('ISO-10303-21;'));
  const { session } = await service.createUploadSession(owner, {
    projectId: base.projectId,
    fileName: 'large.step',
    contentType: 'model/step',
    kind: 'step-import'
  });
  await service.putUpload(owner, session.uploadSessionId, bytes.buffer);
  await service.finalizeArtifact(owner, {
    projectId: base.projectId,
    uploadSessionId: session.uploadSessionId,
    artifactId: session.artifactId
  });
  const manager = new CommandManager(base);
  manager.execute(
    commandFactories.importStep({
      name: 'Large source',
      sourceName: 'large.step',
      artifactId: session.artifactId,
      stepSourceRef: reference(bytes)
    })
  );
  await service.saveDocument(owner, {
    projectId: base.projectId,
    expectedVersion: base.version,
    document: manager.document
  });
  const parts = vi.spyOn(service, 'putUploadPart');
  const copy = await service.duplicateProject(owner, {
    projectId: base.projectId
  });
  expect(parts.mock.calls.map((args) => args[4].byteLength)).toEqual([
    16 * 1024 * 1024,
    2 * 1024 * 1024 + 3
  ]);
  await service.deleteProject(owner, base.projectId);
  const download = await service.downloadArtifact(
    owner,
    importArtifactId(copy.document)
  );
  expect(
    reference(new Uint8Array(await new Response(download!.body).arrayBuffer()))
  ).toEqual(reference(bytes));
});

it('local duplicate and branch references can be archived independently of their source', () => {
  const manager = new CommandManager(
    createProjectDocument('Local scan', owner)
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Scan',
      sourceName: 'scan.stl',
      triangleCount: 1,
      artifactId: 'artifact_original',
      meshPayloadRef: reference(mesh)
    })
  );
  const original = structuredClone(manager.document);
  const copy = duplicateProjectDocument(manager.document, 'Local copy', owner);
  expect(importArtifactId(copy)).toBe(
    `artifact_local_${reference(mesh).checksumSha256}`
  );
  expect(manager.document).toEqual(original);
  expect(JSON.stringify(copy.commandLog)).not.toContain('artifact_original');
});

it('fences repair saves, checkpoints and restores after rollback claims the destination', async () => {
  const { service, bucket, db } = d1Service();
  const { document: source } = await importedProject(service);
  const download = service.downloadArtifact.bind(service);
  let targetId = source.projectId;
  let local: ProjectDocument | null = null;
  vi.spyOn(service, 'downloadArtifact').mockImplementationOnce(
    async (...args) => {
      const target = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!;
      targetId = target.projectId;
      const editor = new CommandManager(
        (await service.loadProject(owner, targetId))!
      );
      editor.execute(
        commandFactories.addPrimitive({
          name: 'Unpublished recovery edits',
          primitiveKind: 'box',
          dimensions: { width: 1, height: 2, depth: 3 }
        })
      );
      local = editor.document;
      const damaged = mesh.slice();
      damaged[0] = damaged[0]! ^ 0xff;
      return { ...(await download(...args))!, body: damaged.buffer };
    }
  );
  const erase = bucket.delete.bind(bucket);
  let checked = false;
  vi.spyOn(bucket, 'delete').mockImplementation(async (key) => {
    if (
      typeof key === 'string' &&
      key.includes(`/${targetId}/documents/`) &&
      !checked
    ) {
      checked = true;
      const loaded = (await service.loadProject(owner, targetId))!;
      const summary = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId === targetId
      )!;
      expect(summary.organization?.status).toBe('deleted');
      expect(summary.documentVersion).toBe(loaded.version + 1);
      expect(
        db
          .prepare(
            'SELECT project_id FROM project_copy_cleanup_claims WHERE project_id = ?'
          )
          .get(targetId)
      ).toEqual({ project_id: targetId });
      await expect(
        service.updateProject(owner, { projectId: targetId, status: 'active' })
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      await erase(key);
      // Account recovery writes against the shelf version even when the
      // stored document is unavailable. The durable claim still fences it.
      await expect(
        service.saveDocument(owner, {
          projectId: targetId,
          expectedVersion: summary.documentVersion!,
          document: local!
        })
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(
        service.saveRevision(owner, {
          projectId: targetId,
          expectedVersion: summary.documentVersion!,
          document: local!,
          reason: 'Recovery checkpoint'
        })
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      return;
    }
    await erase(key);
  });
  await expect(
    service.duplicateProject(owner, { projectId: source.projectId })
  ).rejects.toBeInstanceOf(ArtifactStorageError);
  expect(checked).toBe(true);
  expect(await service.loadProject(owner, targetId)).toBeNull();
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
      .get()
  ).toEqual({ count: 0 });
});

it('keeps a failed rollback fenced and visible until its owner retries deletion', async () => {
  const { service, bucket, db } = d1Service();
  const { document: source } = await importedProject(service);
  const download = service.downloadArtifact.bind(service);
  const damaged = mesh.slice();
  damaged[0] = damaged[0]! ^ 0xff;
  vi.spyOn(service, 'downloadArtifact').mockImplementationOnce(
    async (...args) => ({ ...(await download(...args))!, body: damaged.buffer })
  );
  const erase = bucket.delete.bind(bucket);
  let failedId: ProjectDocument['projectId'] | undefined;
  vi.spyOn(bucket, 'delete').mockImplementation(async (key) => {
    if (
      typeof key === 'string' &&
      key.includes('/documents/') &&
      !key.includes(`/${source.projectId}/`) &&
      !failedId
    ) {
      failedId = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!.projectId;
      throw new Error('Temporary storage erase failure');
    }
    await erase(key);
  });
  const failure = await service
    .duplicateProject(owner, { projectId: source.projectId })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBeInstanceOf(
    ArtifactStorageError
  );
  expect((failure as AggregateError).errors[1]).toEqual(
    new Error('Temporary storage erase failure')
  );
  expect(
    (await service.listProjects(owner)).projects.find(
      (project) => project.projectId === failedId
    )?.organization?.status
  ).toBe('deleted');
  await expect(
    service.updateProject(owner, { projectId: failedId!, status: 'active' })
  ).rejects.toBeInstanceOf(ProjectNotFoundError);
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
      .get()
  ).toEqual({ count: 1 });
  expect(await service.loadProject(owner, source.projectId)).toEqual(source);
  await service.deleteProject(owner, failedId!);
  expect(await service.loadProject(owner, failedId!)).toBeNull();
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
      .get()
  ).toEqual({ count: 0 });
});

it.each(['autosave', 'checkpoint'] as const)(
  'refuses a %s whose authorization preceded the cleanup claim',
  async (writeKind) => {
    const { service, bucket, db } = d1Service();
    const { document: base } = await service.createProject(owner, {
      name: 'Pending copy'
    });
    const editor = new CommandManager(base);
    editor.execute(
      commandFactories.addPrimitive({
        name: 'Concurrent write',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 2, depth: 3 }
      })
    );
    const put = bucket.put.bind(bucket);
    let claimed = false;
    vi.spyOn(bucket, 'put').mockImplementation(async (key, body, options) => {
      const result = await put(key, body, options);
      if (key.includes(`/${base.projectId}/documents/`) && !claimed) {
        // The write already passed authorization and awaited R2. A rollback
        // can claim the project here, before the canonical SQL commit.
        db.prepare(
          'INSERT INTO project_copy_cleanup_claims (project_id, claimed_at) VALUES (?, ?)'
        ).run(base.projectId, '2026-01-01T00:00:00Z');
        claimed = true;
      }
      return result;
    });
    const request = {
      projectId: base.projectId,
      expectedVersion: base.version,
      document: editor.document
    };
    await expect(
      writeKind === 'autosave'
        ? service.saveDocument(owner, request)
        : service.saveRevision(owner, { ...request, reason: 'Copy checkpoint' })
    ).rejects.toBeInstanceOf(RevisionConflictError);
    expect(claimed).toBe(true);
    expect(await service.loadProject(owner, base.projectId)).toEqual(base);
    await service.deleteProject(owner, base.projectId);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
        .get()
    ).toEqual({ count: 0 });
  }
);

it('preserves a room edit acknowledged before failed-copy cleanup claims the destination', async () => {
  const { service, roomFor, db } = roomBackedService();
  const { document: source } = await importedProject(service);
  const download = service.downloadArtifact.bind(service);
  let targetId = source.projectId;
  let edited: ProjectDocument | null = null;
  vi.spyOn(service, 'downloadArtifact').mockImplementationOnce(
    async (...args) => {
      targetId = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!.projectId;
      const pending = (await service.loadProject(owner, targetId))!;
      const { room } = roomFor(targetId);
      expect(
        (await room.fetch(roomSnapshotRequest(pending, null))).status
      ).toBe(200);
      const editor = new CommandManager(pending);
      editor.execute(
        commandFactories.addPrimitive({
          name: 'Acknowledged room edit',
          primitiveKind: 'box',
          dimensions: { width: 1, height: 2, depth: 3 }
        })
      );
      edited = editor.document;
      expect(
        (await room.fetch(roomSnapshotRequest(edited, pending.version))).status
      ).toBe(200);
      const damaged = mesh.slice();
      damaged[0] = damaged[0]! ^ 0xff;
      return { ...(await download(...args))!, body: damaged.buffer };
    }
  );
  await expect(
    service.duplicateProject(owner, { projectId: source.projectId })
  ).rejects.toBeInstanceOf(RevisionConflictError);
  expect(roomFor(targetId).values.get('room:latest')).toEqual(edited);
  expect(
    (await service.loadProject(owner, targetId))?.featureOrder
  ).toHaveLength(1);
  expect((await service.listProjects(owner)).projects).toHaveLength(2);
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
      .get()
  ).toEqual({ count: 0 });
  expect(await service.loadProject(owner, source.projectId)).toEqual(source);
});

it('refuses a room write queued behind a claimed copy rollback without recreating erased state', async () => {
  const { service, roomFor, db } = roomBackedService();
  const { document: source } = await importedProject(service);
  const copy = await service.createProject(owner, { name: 'Pending copy' });
  const { room, context, values } = roomFor(copy.document.projectId);
  expect(
    (await room.fetch(roomSnapshotRequest(copy.document, null))).status
  ).toBe(200);
  const editor = new CommandManager(copy.document);
  editor.execute(
    commandFactories.addPrimitive({
      name: 'Late room edit',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    })
  );
  const payload = new TextEncoder().encode(
    JSON.stringify({
      clientId: 'copy_room',
      baseVersion: copy.document.version,
      document: editor.document
    })
  );
  let releaseBody!: () => void;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      releaseBody = () => {
        controller.enqueue(payload);
        controller.close();
      };
    }
  });
  const snapshot = roomSnapshotRequest(editor.document, copy.document.version);
  const pendingRequest = new Request(snapshot.url, {
    method: 'POST',
    headers: snapshot.headers,
    body,
    duplex: 'half'
  } as RequestInit);
  let bodyRead!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyRead = resolve;
  });
  vi.spyOn(pendingRequest, 'body', 'get').mockImplementation(() => {
    bodyRead();
    return body;
  });
  let settled = false;
  const pending = room.fetch(pendingRequest).then((response) => {
    settled = true;
    return response;
  });
  await started;
  const erase = context.storage.deleteAll.bind(context.storage);
  let releaseErasure!: () => void;
  let eraseStarted!: () => void;
  const erasing = new Promise<void>((resolve) => {
    eraseStarted = resolve;
  });
  vi.spyOn(context.storage, 'deleteAll').mockImplementation(async () => {
    eraseStarted();
    await new Promise<void>((resolve) => {
      releaseErasure = resolve;
    });
    await erase();
  });
  const identity = await cleanupIdentity(db, copy.document);
  const cleanup = service.discardUnmodifiedProjectCopy(
    owner,
    copy.document,
    identity
  );
  await erasing;
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
      .get()
  ).toEqual({ count: 1 });
  releaseBody();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The body completes after the claim, but its operation waits behind the
  // rollback in the same lease queue until both room and cloud erasure finish.
  expect(settled).toBe(false);
  releaseErasure();
  await cleanup;
  expect((await pending).status).toBe(410);
  expect(values.size).toBe(0);
  expect(await service.loadProject(owner, copy.document.projectId)).toBeNull();
  expect(await service.loadProject(owner, source.projectId)).toEqual(source);
});

it('preserves acknowledged same-version source archival in both the room and cloud head', async () => {
  const { service, roomFor, db } = roomBackedService();
  const { document: source } = await importedProject(service);
  const complete = service.completeMultipartUpload.bind(service);
  let kept: ProjectDocument | null = null;
  vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
    async (...args) => {
      await complete(...args);
      const target = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!;
      const pending = (await service.loadProject(owner, target.projectId))!;
      kept = (await independentlyArchiveMesh(service, pending)).archived;
      const response = await roomFor(target.projectId).room.fetch(
        roomSnapshotRequest(kept, null)
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: 'ack' });
      throw new ArtifactStorageError('Original copy transport failed');
    }
  );
  await expect(
    service.duplicateProject(owner, { projectId: source.projectId })
  ).rejects.toBeInstanceOf(RevisionConflictError);
  expect(await service.loadProject(owner, kept!.projectId)).toEqual(kept);
  expect(roomFor(kept!.projectId).values.get('room:latest')).toEqual(kept);
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM project_copy_cleanup_claims')
      .get()
  ).toEqual({ count: 0 });
});

it('completes a room edit with portable sources and preserves its undo/redo history', async () => {
  const { service, roomFor } = roomBackedService();
  const { document: source } = await importedProject(service);
  const complete = service.completeMultipartUpload.bind(service);
  let targetId = source.projectId;
  vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
    async (...args) => {
      await complete(...args);
      targetId = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!.projectId;
      const pending = (await service.loadProject(owner, targetId))!;
      const editor = new CommandManager(pending);
      editor.execute(
        commandFactories.addPrimitive({
          name: 'Acknowledged room box',
          primitiveKind: 'box',
          dimensions: { width: 1, height: 2, depth: 3 }
        })
      );
      const response = await roomFor(targetId).room.fetch(
        roomSnapshotRequest(editor.document, null)
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: 'ack' });
    }
  );
  const completed = await service.duplicateProject(owner, {
    projectId: source.projectId
  });
  expect(completed.document.featureOrder).toHaveLength(2);
  const latest = roomFor(targetId).values.get('room:latest') as ProjectDocument;
  expect(latest.featureOrder).toHaveLength(2);
  expect(importArtifactId(latest)).not.toMatch(/^artifact_local_/);
  expect(importArtifactId(latest)).toBe(importArtifactId(completed.document));
  const editor = new CommandManager(latest);
  editor.undo();
  expect(editor.document.featureOrder).toHaveLength(1);
  expect(importArtifactId(editor.document)).toBe(importArtifactId(latest));
  editor.redo();
  expect(editor.document.featureOrder).toHaveLength(2);
  await service.deleteProject(owner, source.projectId);
  const download = await service.downloadArtifact(
    owner,
    importArtifactId(latest)
  );
  expect(
    new Uint8Array(await new Response(download!.body).arrayBuffer())
  ).toEqual(mesh);
});

it('retains acknowledged room edits and owned bytes when D1 publication fails', async () => {
  const { service, roomFor, db, env } = roomBackedService();
  const { document: source } = await importedProject(service);
  const complete = service.completeMultipartUpload.bind(service);
  let targetId = source.projectId;
  let acknowledged: ProjectDocument | null = null;
  let failPublication = false;
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (failPublication && /UPDATE projects\s+SET document_json/.test(sql)) {
      failPublication = false;
      throw new Error('Temporary canonical publication failure');
    }
    return prepare(sql);
  });
  vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
    async (...args) => {
      await complete(...args);
      targetId = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!.projectId;
      const pending = (await service.loadProject(owner, targetId))!;
      const editor = new CommandManager(pending);
      editor.execute(
        commandFactories.addPrimitive({
          name: 'Retained acknowledged box',
          primitiveKind: 'box',
          dimensions: { width: 1, height: 2, depth: 3 }
        })
      );
      acknowledged = editor.document;
      const response = await roomFor(targetId).room.fetch(
        roomSnapshotRequest(acknowledged, null)
      );
      expect(response.status).toBe(200);
      failPublication = true;
    }
  );
  await expect(
    service.duplicateProject(owner, { projectId: source.projectId })
  ).rejects.toThrow('Temporary canonical publication failure');
  expect(failPublication).toBe(false);
  expect(await service.loadProject(owner, targetId)).not.toBeNull();
  const roomState = roomFor(targetId);
  expect(
    (roomState.values.get('room:latest') as ProjectDocument).featureOrder
  ).toHaveLength(2);
  expect(roomState.values.has('room:source-archives')).toBe(true);
  await service.deleteProject(owner, source.projectId);
  const restarted = createTestRoom(roomState.context, env);
  const response = await restarted.fetch(
    roomSnapshotRequest(acknowledged!, acknowledged!.version)
  );
  expect(response.status).toBe(200);
  const recovery = (await response.json()) as { document: ProjectDocument };
  expect(recovery.document.featureOrder).toHaveLength(2);
  expect(importArtifactId(recovery.document)).not.toMatch(/^artifact_local_/);
  const download = await service.downloadArtifact(
    owner,
    importArtifactId(recovery.document)
  );
  expect(
    new Uint8Array(await new Response(download!.body).arrayBuffer())
  ).toEqual(mesh);
});

it.each(['autosave', 'checkpoint'] as const)(
  'fences a %s already writing before copied alias registration',
  async (kind) => {
    const { service, bucket } = d1Service();
    const { document: source } = await importedProject(service);
    const complete = service.completeMultipartUpload.bind(service);
    let blocked!: () => void;
    const held = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staleSave: Promise<unknown> | undefined;
    let preferred = '';
    vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        const target = (await service.listProjects(owner)).projects.find(
          (project) => project.projectId !== source.projectId
        )!;
        const pending = (await service.loadProject(owner, target.projectId))!;
        const put = bucket.put.bind(bucket);
        vi.spyOn(bucket, 'put').mockImplementationOnce(async (...putArgs) => {
          blocked();
          await gate;
          return put(...putArgs);
        });
        const request = {
          projectId: pending.projectId,
          expectedVersion: pending.version,
          document: pending
        };
        staleSave =
          kind === 'autosave'
            ? service.saveDocument(owner, request)
            : service.saveRevision(owner, {
                ...request,
                reason: 'Early checkpoint'
              });
        void staleSave.catch(() => undefined);
        await held;
        preferred = (await independentlyArchiveMesh(service, pending)).artifact
          .artifactId;
      }
    );
    const completed = await service.duplicateProject(owner, {
      projectId: source.projectId
    });
    expect(importArtifactId(completed.document)).toBe(preferred);
    release();
    await expect(staleSave).rejects.toBeInstanceOf(RevisionConflictError);
    expect(
      importArtifactId(
        (await service.loadProject(owner, completed.document.projectId))!
      )
    ).toBe(preferred);
  }
);

it('hydrates a failed cloud publication from verified aliases on fresh project and revision loads', async () => {
  const { service, db } = d1Service();
  const { document: source } = await importedProject(service);
  const complete = service.completeMultipartUpload.bind(service);
  let targetId = source.projectId;
  let revisionId = source.revisions.at(-1)!.revisionId;
  let failPublication = false;
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (failPublication && /UPDATE projects\s+SET document_json/.test(sql)) {
      failPublication = false;
      throw new Error('Temporary cloud publication failure');
    }
    return prepare(sql);
  });
  vi.spyOn(service, 'completeMultipartUpload').mockImplementationOnce(
    async (...args) => {
      await complete(...args);
      targetId = (await service.listProjects(owner)).projects.find(
        (project) => project.projectId !== source.projectId
      )!.projectId;
      const pending = (await service.loadProject(owner, targetId))!;
      const saved = await service.saveRevision(owner, {
        projectId: targetId,
        expectedVersion: pending.version,
        document: pending,
        reason: 'Acknowledged checkpoint'
      });
      revisionId = saved.revisions.at(-1)!.revisionId;
      failPublication = true;
    }
  );
  await expect(
    service.duplicateProject(owner, { projectId: source.projectId })
  ).rejects.toThrow('Temporary cloud publication failure');
  expect(failPublication).toBe(false);
  await service.deleteProject(owner, source.projectId);
  const fresh = (await service.loadProject(owner, targetId))!;
  const revision = (await service.loadRevision(owner, targetId, revisionId))!;
  for (const document of [fresh, revision]) {
    expect(importArtifactId(document)).not.toMatch(/^artifact_local_/);
    const download = await service.downloadArtifact(
      owner,
      importArtifactId(document)
    );
    expect(
      new Uint8Array(await new Response(download!.body).arrayBuffer())
    ).toEqual(mesh);
  }
});
