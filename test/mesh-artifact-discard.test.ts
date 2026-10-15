import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  D1R2PersistenceService,
  projectCopyDocumentDigest
} from '@openzcad/cloudflare-adapters';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  archiveHistorySources,
  createProjectDocument
} from '@openzcad/document-core';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError,
  reconcileCopiedImportSources,
  type PersistenceService
} from '@openzcad/persistence';
import {
  encodeImportedMeshPayload,
  documentNodesWithHistory,
  importedSourceReferenceOf,
  toUserId,
  toAssetId,
  type ArtifactKind,
  type ProjectDocument
} from '@openzcad/shared';
import {
  HttpError,
  parseDiscardMeshPayloadRequest
} from '../apps/web/worker/validation';
import {
  archiveArtifact,
  type ArchiveArtifactTransport
} from '../apps/web/src/lib/archiveArtifact';
import { archiveImportedMesh } from '../apps/web/src/lib/importedMeshPayload';
import worker from '../apps/web/worker/index';
import {
  isArtifactUploadAccountingReady,
  isD1ProjectStorageReady,
  isProjectObjectStorageReady
} from '../apps/web/worker/readiness';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const CLEANUP_KINDS = ['mesh-payload', 'stl-import', 'mesh-import'] as const;

const owner = toUserId('user_discard_owner');
const outsider = toUserId('user_discard_outsider');
const bytes = encodeImportedMeshPayload({
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2]
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(inline = false) {
  const db = migratedDatabase();
  for (const user of [owner, outsider])
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.com`, '2026-01-01T00:00:00Z');
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const multipart = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  let id = 0;
  const hooks: {
    put?: () => Promise<void>;
    head?: () => Promise<void>;
    complete?: () => Promise<void>;
    delete?: () => Promise<void>;
    statement?: (sql: string) => void;
    afterFirst?: (sql: string) => Promise<void>;
  } = {};
  const resumed = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: async (partNumber: number, body: ArrayBuffer) => {
      const parts = multipart.get(uploadId);
      if (!parts) throw new Error('NoSuchUpload');
      parts.set(partNumber, new Uint8Array(body.slice(0)));
      return { partNumber, etag: `part-${partNumber}` };
    },
    complete: async (parts: { partNumber: number }[]) => {
      await hooks.complete?.();
      const stored = multipart.get(uploadId);
      if (!stored) throw new Error('NoSuchUpload');
      const chunks = parts.map((part) => stored.get(part.partNumber)!);
      const result = new Uint8Array(
        chunks.reduce((n, chunk) => n + chunk.length, 0)
      );
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      objects.set(key, result);
      multipart.delete(uploadId);
      return { key, size: result.length };
    },
    abort: async () => {
      multipart.delete(uploadId);
    }
  });
  const bucket = {
    ...(!inline
      ? {
          put: async (key: string, body: BodyInit) => {
            await hooks.put?.();
            objects.set(
              key,
              new Uint8Array(await new Response(body).arrayBuffer())
            );
            return null;
          }
        }
      : {}),
    get: async (key: string) => {
      const value = objects.get(key);
      return value
        ? {
            size: value.length,
            body: new Response(value).body,
            arrayBuffer: async () => value.slice().buffer
          }
        : null;
    },
    head: async (key: string) => {
      const value = objects.get(key);
      await hooks.head?.();
      return value ? { size: value.length } : null;
    },
    delete: async (key: string) => {
      await hooks.delete?.();
      objects.delete(key);
    },
    createMultipartUpload: async (key: string) => {
      const uploadId = `multipart-${++id}`;
      multipart.set(uploadId, new Map());
      return resumed(key, uploadId);
    },
    resumeMultipartUpload: resumed
  } as unknown as R2Bucket;
  const database = sqliteD1(db, {
    onStatement: (sql) => hooks.statement?.(sql)
  });
  const wrapStatement = (
    sql: string,
    statement: D1PreparedStatement
  ): D1PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) =>
      wrapStatement(sql, statement.bind(...values)),
    first: async <T>(): Promise<T | null> => {
      const row = await statement.first<T>();
      await hooks.afterFirst?.(sql);
      return row;
    }
  });
  const env = {
    DB: {
      ...database,
      prepare: (sql: string) => wrapStatement(sql, database.prepare(sql))
    },
    ARTIFACTS: bucket,
    PROJECT_SHARING_ENABLED: 'true'
  };
  const service = new D1R2PersistenceService(env);
  const usage = () =>
    db
      .prepare(
        `SELECT finalized_bytes, reserved_bytes, active_sessions
    FROM artifact_account_usage WHERE owner_user_id = ?`
      )
      .get(owner);
  return { service, db, objects, hooks, usage, env };
}

async function upload(
  service: PersistenceService,
  kind: ArtifactKind = 'mesh-payload'
) {
  const { document } = await service.createProject(owner, {
    name: 'Cancelled scan'
  });
  const { session } = await service.createUploadSession(owner, {
    projectId: document.projectId,
    fileName: 'scan.ozmesh',
    kind,
    contentType: 'application/vnd.openzcad.mesh-payload'
  });
  return { document, session };
}

async function finalized(
  service: PersistenceService,
  kind: ArtifactKind = 'mesh-payload'
) {
  const state = await upload(service, kind);
  await service.putUpload(owner, state.session.uploadSessionId, bytes.buffer);
  const artifact = await service.finalizeArtifact(owner, {
    projectId: state.document.projectId,
    uploadSessionId: state.session.uploadSessionId,
    artifactId: state.session.artifactId
  });
  if (!artifact) throw new Error('Fixture upload did not finalize.');
  return { ...state, artifact };
}

function imported(document: ProjectDocument, artifactId: string) {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.importMesh({
      name: 'Scan',
      sourceName: 'scan.stl',
      triangleCount: 1,
      artifactId,
      meshPayloadRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        logicalBytes: bytes.length
      }
    })
  );
  return manager;
}

describe.each(['memory', 'D1/R2'] as const)(
  '%s mesh payload discard',
  (backend) => {
    const serviceOf = () =>
      backend === 'memory'
        ? new InMemoryPersistenceService()
        : fixture().service;

    it('removes only an unreferenced mesh payload and retries idempotently', async () => {
      const service = serviceOf();
      const { document, artifact } = await finalized(service);
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: true });
      expect(
        (await service.listArtifacts(owner, document.projectId)).artifacts
      ).toEqual([]);
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).toBeNull();
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: true });
    });

    it('requires edit access and refuses another project or another artifact kind', async () => {
      const service = serviceOf();
      const { document, artifact } = await finalized(service);
      await expect(
        service.discardMeshPayload(
          outsider,
          document.projectId,
          artifact.artifactId
        )
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      const other = await service.createProject(owner, { name: 'Other' });
      expect(
        await service.discardMeshPayload(
          owner,
          other.document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: false });
      const source = await finalized(service, 'mesh-import');
      expect(
        await service.discardMeshPayload(
          owner,
          source.document.projectId,
          source.artifact.artifactId
        )
      ).toEqual({ deleted: false });
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
    });

    it.each(['stl-import', 'mesh-import'] as const)(
      'requires an explicit matching kind before removing an unreferenced %s original',
      async (kind) => {
        const service = serviceOf();
        const { document, artifact } = await finalized(service, kind);
        await expect(
          service.discardMeshPayload(
            outsider,
            document.projectId,
            artifact.artifactId,
            kind
          )
        ).rejects.toBeInstanceOf(ProjectNotFoundError);
        expect(
          await service.discardMeshPayload(
            owner,
            document.projectId,
            artifact.artifactId
          )
        ).toEqual({ deleted: false });
        expect(
          await service.discardMeshPayload(
            owner,
            document.projectId,
            artifact.artifactId,
            kind === 'stl-import' ? 'mesh-import' : 'stl-import'
          )
        ).toEqual({ deleted: false });
        const other = await service.createProject(owner, { name: 'Other' });
        expect(
          await service.discardMeshPayload(
            owner,
            other.document.projectId,
            artifact.artifactId,
            kind
          )
        ).toEqual({ deleted: false });
        expect(
          await service.downloadArtifact(owner, artifact.artifactId)
        ).not.toBeNull();
        expect(
          await service.discardMeshPayload(
            owner,
            document.projectId,
            artifact.artifactId,
            kind
          )
        ).toEqual({ deleted: true });
        expect(
          await service.downloadArtifact(owner, artifact.artifactId)
        ).toBeNull();
        expect(
          await service.discardMeshPayload(
            owner,
            document.projectId,
            artifact.artifactId,
            kind
          )
        ).toEqual({ deleted: true });
      }
    );

    it.each(['stl-import', 'mesh-import'] as const)(
      'reserves removal of an acknowledged %s original for its project owner',
      async (kind) => {
        const state = backend === 'D1/R2' ? fixture() : null;
        const service = state?.service ?? new InMemoryPersistenceService();
        const { document, artifact } = await finalized(service, kind);
        if (state) {
          state.db
            .prepare(
              'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
            )
            .run(document.projectId, outsider, 'editor', owner);
        } else {
          await (service as InMemoryPersistenceService).setProjectMemberRole(
            owner,
            document.projectId,
            outsider,
            'editor'
          );
        }
        expect(
          (await service.listArtifacts(outsider, document.projectId)).artifacts
        ).toContainEqual(artifact);
        await expect(
          service.discardMeshPayload(
            outsider,
            document.projectId,
            artifact.artifactId,
            kind
          )
        ).rejects.toBeInstanceOf(ProjectNotFoundError);
        expect(
          await service.downloadArtifact(owner, artifact.artifactId)
        ).not.toBeNull();

        // Finalized artifacts have no trusted uploader identity. An editor's
        // cancelled original is retained for the owner's explicit removal too.
        const { session } = await service.createUploadSession(outsider, {
          projectId: document.projectId,
          fileName: 'editor-original.stl',
          kind,
          contentType: 'application/octet-stream'
        });
        await service.putUpload(
          outsider,
          session.uploadSessionId,
          bytes.buffer
        );
        const editorOriginal = (await service.finalizeArtifact(outsider, {
          projectId: document.projectId,
          uploadSessionId: session.uploadSessionId,
          artifactId: session.artifactId
        }))!;
        expect(editorOriginal).not.toBeNull();
        await expect(
          service.discardMeshPayload(
            outsider,
            document.projectId,
            editorOriginal.artifactId,
            kind
          )
        ).rejects.toBeInstanceOf(ProjectNotFoundError);
        for (const original of [artifact, editorOriginal]) {
          expect(
            await service.discardMeshPayload(
              owner,
              document.projectId,
              original.artifactId,
              kind
            )
          ).toEqual({ deleted: true });
        }
      }
    );

    it.each(['current', 'undo', 'redo'] as const)(
      'preserves an original needed by a %s legacy mesh',
      async (state) => {
        const service = serviceOf();
        const { document, artifact } = await finalized(service, 'stl-import');
        const manager = new CommandManager(document);
        manager.execute(
          commandFactories.importMesh({
            name: 'Legacy scan',
            sourceName: 'scan.stl',
            artifactId: artifact.artifactId,
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            triangleCount: 1
          })
        );
        if (state === 'undo')
          manager.execute(
            commandFactories.deleteFeature({
              featureId: manager.document.featureOrder[0]!
            })
          );
        if (state === 'redo') manager.undo();
        if (state !== 'current')
          expect(manager.document.featureOrder).toEqual([]);
        await service.saveDocument(owner, {
          projectId: document.projectId,
          expectedVersion: document.version,
          document: manager.document
        });
        expect(
          await service.discardMeshPayload(
            owner,
            document.projectId,
            artifact.artifactId,
            'stl-import'
          )
        ).toEqual({ deleted: false });
        expect(
          await service.downloadArtifact(owner, artifact.artifactId)
        ).not.toBeNull();
      }
    );

    it.each(['current', 'undo'] as const)(
      'preserves an original referenced by a %s project asset',
      async (state) => {
        const service = serviceOf();
        const { document, artifact } = await finalized(service, 'mesh-import');
        const assetId = toAssetId('asset_mesh_source');
        const asset = {
          assetId,
          artifactId: artifact.artifactId,
          kind: 'stl-source' as const,
          name: 'scan.obj',
          contentType: 'text/plain',
          storage: 'remote' as const,
          createdAt: artifact.createdAt
        };
        const saved: ProjectDocument = {
          ...document,
          version: document.version + 1,
          assets: state === 'current' ? { [assetId]: asset } : {},
          ...(state === 'undo'
            ? {
                editHistory: {
                  schemaVersion: 1 as const,
                  projectId: document.projectId,
                  actorUserId: owner,
                  entries: [
                    {
                      id: 'removed_source_asset',
                      label: 'Remove source',
                      changes: [
                        {
                          kind: 'value' as const,
                          field: 'assets' as const,
                          key: assetId,
                          before: asset
                        }
                      ]
                    }
                  ],
                  cursor: 1,
                  trimmed: 0
                }
              }
            : {})
        };
        await service.saveDocument(owner, {
          projectId: document.projectId,
          expectedVersion: document.version,
          document: saved
        });
        expect(
          await service.discardMeshPayload(
            owner,
            document.projectId,
            artifact.artifactId,
            'mesh-import'
          )
        ).toEqual({ deleted: false });
        expect(
          await service.downloadArtifact(owner, artifact.artifactId)
        ).not.toBeNull();
      }
    );

    it('retains verified copy aliases even after the live model stops referring to them', async () => {
      const service = serviceOf();
      const source = await sourceProject(service);
      const copy = await service.duplicateProject(owner, {
        projectId: source.projectId
      });
      const artifactId = referenceIds(copy.document)[0]!;
      const empty = {
        ...createProjectDocument(copy.document.name, owner),
        projectId: copy.document.projectId,
        version: copy.document.version + 1
      };
      await service.saveDocument(owner, {
        projectId: copy.document.projectId,
        expectedVersion: copy.document.version,
        document: empty
      });
      expect(
        referenceIds(
          (await service.loadProject(owner, copy.document.projectId))!
        )
      ).toEqual([]);
      expect(
        await service.discardMeshPayload(
          owner,
          copy.document.projectId,
          artifactId
        )
      ).toEqual({ deleted: false });
      expect(await service.downloadArtifact(owner, artifactId)).not.toBeNull();
      await service.deleteProject(owner, copy.document.projectId);
      expect(await service.downloadArtifact(owner, artifactId)).toBeNull();
    });

    it('preserves a payload referenced by either the live model or durable redo', async () => {
      const service = serviceOf();
      const { document, artifact } = await finalized(service);
      const manager = imported(document, artifact.artifactId);
      await service.saveDocument(owner, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: manager.document
      });
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: false });
      const version = manager.document.version;
      manager.undo();
      expect(manager.document.featureOrder).toEqual([]);
      await service.saveDocument(owner, {
        projectId: document.projectId,
        expectedVersion: version,
        document: manager.document
      });
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: false });
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
    });

    it('preserves a payload held only by a stored checkpoint', async () => {
      const service = serviceOf();
      const { document, artifact } = await finalized(service);
      const manager = imported(document, artifact.artifactId);
      const checkpoint = await service.saveRevision(owner, {
        projectId: document.projectId,
        expectedVersion: document.version,
        reason: 'With scan',
        document: manager.document
      });
      const empty = structuredClone(document);
      empty.version = checkpoint.version + 1;
      empty.revisions = checkpoint.revisions;
      await service.saveDocument(owner, {
        projectId: document.projectId,
        expectedVersion: checkpoint.version,
        document: empty
      });
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: false });
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
    });

    it('blocks a cancelled artifact from a later autosave or checkpoint', async () => {
      const service = serviceOf();
      const { document, artifact } = await finalized(service);
      const manager = imported(document, artifact.artifactId);
      await service.discardMeshPayload(
        owner,
        document.projectId,
        artifact.artifactId
      );
      await expect(
        service.saveDocument(owner, {
          projectId: document.projectId,
          expectedVersion: document.version,
          document: manager.document
        })
      ).rejects.toThrow();
      await expect(
        service.saveRevision(owner, {
          projectId: document.projectId,
          expectedVersion: document.version,
          reason: 'Delayed commit',
          document: manager.document
        })
      ).rejects.toThrow();
      await expect(
        service.createProject(outsider, {
          name: 'Delayed adoption',
          document: manager.document,
          adoptionProtocolVersion: 1
        })
      ).rejects.toThrow();
      expect((await service.listProjects(outsider)).projects).toEqual([]);
      expect(
        (await service.loadProject(owner, document.projectId))?.featureOrder
      ).toEqual([]);
      expect(
        (await service.listRevisions(owner, document.projectId)).revisions
      ).toEqual([]);
    });
  }
);

describe('D1/R2 mesh discard races and accounting', () => {
  it('atomically fences a foreign source discarded while adoption stores its localized document', async () => {
    const { service, hooks, db } = fixture();
    const { document, artifact } = await finalized(service);
    const manager = imported(document, artifact.artifactId);
    let discardedDuringWrite = false;
    hooks.put = async () => {
      delete hooks.put;
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: true });
      discardedDuringWrite = true;
    };
    await expect(
      service.createProject(outsider, {
        name: 'Concurrent adoption',
        document: manager.document,
        adoptionProtocolVersion: 1
      })
    ).rejects.toThrow();
    expect(discardedDuringWrite).toBe(true);
    expect((await service.listProjects(outsider)).projects).toEqual([]);
    expect(
      db
        .prepare(
          'SELECT count(*) AS count FROM project_adoptions WHERE user_id = ?'
        )
        .get(outsider)
    ).toMatchObject({ count: 0 });
    expect(
      db.prepare('SELECT count(*) AS count FROM artifact_mesh_discards').get()
    ).toMatchObject({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM project_document_objects WHERE state = 'pending'"
        )
        .get()
    ).toMatchObject({ count: 0 });
  });

  it('does not mistake the pending-to-finalized transition for an absent artifact', async () => {
    const { service, hooks, usage, objects } = fixture();
    const { document, session } = await upload(service);
    await service.putUpload(owner, session.uploadSessionId, bytes.buffer);
    let finalizedDuringLookup = false;
    hooks.afterFirst = async (sql) => {
      if (!sql.startsWith('SELECT project_id, kind, object_key FROM artifacts'))
        return;
      delete hooks.afterFirst;
      expect(
        await service.finalizeArtifact(owner, {
          projectId: document.projectId,
          uploadSessionId: session.uploadSessionId,
          artifactId: session.artifactId
        })
      ).not.toBeNull();
      finalizedDuringLookup = true;
    };
    expect(
      await service.discardMeshPayload(
        owner,
        document.projectId,
        session.artifactId
      )
    ).toEqual({ deleted: true });
    expect(finalizedDuringLookup).toBe(true);
    expect(
      (await service.listArtifacts(owner, document.projectId)).artifacts
    ).toEqual([]);
    expect(objects.has(session.objectKey)).toBe(false);
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('fences upload admission validated before a project copy cleanup claim', async () => {
    const { service, db, hooks, usage } = fixture();
    const { document } = await service.createProject(owner, {
      name: 'Incomplete copy'
    });
    hooks.statement = (sql) => {
      if (!sql.includes('INSERT INTO upload_sessions')) return;
      delete hooks.statement;
      db.prepare(
        'INSERT INTO project_copy_cleanup_claims (project_id, claimed_at) VALUES (?, ?)'
      ).run(document.projectId, '2026-01-01T00:00:00Z');
    };
    await expect(
      service.createUploadSession(owner, {
        projectId: document.projectId,
        fileName: 'late.ozmesh',
        kind: 'mesh-payload',
        contentType: 'application/vnd.openzcad.mesh-payload'
      })
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(
      db.prepare('SELECT count(*) AS count FROM upload_sessions').get()
    ).toMatchObject({ count: 0 });
    expect(usage()).toBeUndefined();
  });

  it('blocks a finalizer past authorization when a copy cleanup claim wins', async () => {
    const { service, hooks, usage, objects, db } = fixture();
    const { document, session } = await upload(service);
    await service.putUpload(owner, session.uploadSessionId, bytes.buffer);
    const entered = deferred();
    const release = deferred();
    hooks.head = async () => {
      delete hooks.head;
      entered.resolve();
      await release.promise;
    };
    const finalizing = service.finalizeArtifact(owner, {
      projectId: document.projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    });
    await entered.promise;
    db.prepare(
      'INSERT INTO project_copy_cleanup_claims (project_id, claimed_at) VALUES (?, ?)'
    ).run(document.projectId, '2026-01-01T00:00:00Z');
    release.resolve();
    expect(await finalizing).toBeNull();
    expect(
      (await service.listArtifacts(owner, document.projectId)).artifacts
    ).toEqual([]);
    expect(await service.purgeExpiredUploadSessions()).toBe(1);
    expect(objects.has(session.objectKey)).toBe(false);
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it.each(CLEANUP_KINDS)('retries failed deletion (%s)', async (kind) => {
    const { service, objects, hooks, usage } = fixture();
    const { document, artifact, session } = await finalized(service, kind);
    hooks.delete = async () => {
      throw new Error('R2 interrupted');
    };
    await expect(
      service.discardMeshPayload(
        owner,
        document.projectId,
        artifact.artifactId,
        kind === 'mesh-payload' ? undefined : kind
      )
    ).rejects.toThrow('R2 interrupted');
    expect(objects.has(artifact.objectKey)).toBe(true);
    expect(usage()).toMatchObject({
      finalized_bytes: bytes.length,
      reserved_bytes: 0
    });
    expect(
      (await service.listArtifacts(owner, document.projectId)).artifacts
    ).toHaveLength(1);
    expect(
      await service.finalizeArtifact(owner, {
        projectId: document.projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: artifact.artifactId
      })
    ).toBeNull();
    delete hooks.delete;
    expect(
      await service.discardMeshPayload(
        owner,
        document.projectId,
        artifact.artifactId,
        kind === 'mesh-payload' ? undefined : kind
      )
    ).toEqual({ deleted: true });
    expect(objects.has(artifact.objectKey)).toBe(false);
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it.each(['saveDocument', 'saveRevision'] as const)(
    'fences an R2 %s already writing its snapshot',
    async (method) => {
      const { service, hooks, db } = fixture();
      const { document, artifact } = await finalized(service);
      const manager = imported(document, artifact.artifactId);
      const entered = deferred();
      const release = deferred();
      hooks.put = async () => {
        entered.resolve();
        await release.promise;
      };
      const saving = service[method](owner, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: manager.document,
        reason: 'Late commit'
      }).then(
        () => null,
        (error: unknown) => error
      );
      await entered.promise;
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: true });
      release.resolve();
      expect(await saving).toBeInstanceOf(Error);
      expect(
        (await service.loadProject(owner, document.projectId))?.featureOrder
      ).toEqual([]);
      expect(
        (await service.listRevisions(owner, document.projectId)).revisions
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM project_document_objects WHERE state = 'pending'"
          )
          .get()
      ).toMatchObject({ count: 0 });
    }
  );

  it('does not delete a payload when the editor loses access before the atomic claim', async () => {
    const { service, hooks, db, objects } = fixture(true);
    const { document, artifact } = await finalized(service);
    db.prepare(
      'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
    ).run(document.projectId, outsider, 'editor', owner);
    hooks.statement = (sql) => {
      if (!sql.includes('INSERT OR IGNORE INTO artifact_mesh_discards')) return;
      delete hooks.statement;
      db.prepare(
        'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?'
      ).run('viewer', document.projectId, outsider);
    };
    expect(
      await service.discardMeshPayload(
        outsider,
        document.projectId,
        artifact.artifactId
      )
    ).toEqual({ deleted: false });
    expect(objects.has(artifact.objectKey)).toBe(true);
    expect(
      db.prepare('SELECT count(*) AS count FROM artifact_mesh_discards').get()
    ).toMatchObject({ count: 0 });
  });

  it('refuses deletion when a concurrent save wins before its versioned claim', async () => {
    const { service, hooks, db, objects } = fixture(true);
    const { document, artifact } = await finalized(service);
    const manager = imported(document, artifact.artifactId);
    hooks.statement = (sql) => {
      if (!sql.includes('INSERT OR IGNORE INTO artifact_mesh_discards')) return;
      delete hooks.statement;
      db.prepare(
        'UPDATE projects SET document_json = ?, document_version = ? WHERE id = ?'
      ).run(
        JSON.stringify(manager.document),
        manager.document.version,
        document.projectId
      );
    };
    expect(
      await service.discardMeshPayload(
        owner,
        document.projectId,
        artifact.artifactId
      )
    ).toEqual({ deleted: false });
    expect(objects.has(artifact.objectKey)).toBe(true);
    expect(
      db.prepare('SELECT count(*) AS count FROM artifact_mesh_discards').get()
    ).toMatchObject({ count: 0 });
  });

  it.each(CLEANUP_KINDS)('claims active completion (%s)', async (kind) => {
    const { service, hooks, usage, objects, db } = fixture();
    const { document, session } = await upload(service, kind);
    const entered = deferred();
    const release = deferred();
    hooks.complete = async () => {
      entered.resolve();
      await release.promise;
    };
    const uploading = service.putUpload(
      owner,
      session.uploadSessionId,
      bytes.buffer
    );
    await entered.promise;
    expect(
      await service.discardMeshPayload(
        owner,
        document.projectId,
        session.artifactId,
        kind === 'mesh-payload' ? undefined : kind
      )
    ).toEqual({ deleted: false });
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: bytes.length,
      active_sessions: 1
    });
    expect(
      db.prepare('SELECT count(*) AS count FROM artifact_mesh_discards').get()
    ).toMatchObject({ count: 1 });
    release.resolve();
    await uploading;
    expect(objects.has(session.objectKey)).toBe(false);
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 0
    });
    await expect(
      service.finalizeArtifact(owner, {
        projectId: document.projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      })
    ).rejects.toThrow();
    expect(
      (await service.listArtifacts(owner, document.projectId)).artifacts
    ).toEqual([]);
  });

  it.each(CLEANUP_KINDS)('fences a late finalizer (%s)', async (kind) => {
    const { service, hooks, usage, objects } = fixture();
    const { document, session } = await upload(service, kind);
    await service.putUpload(owner, session.uploadSessionId, bytes.buffer);
    const entered = deferred();
    const release = deferred();
    hooks.head = async () => {
      delete hooks.head;
      entered.resolve();
      await release.promise;
    };
    const finalizing = service.finalizeArtifact(owner, {
      projectId: document.projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    });
    await entered.promise;
    expect(
      await service.discardMeshPayload(
        owner,
        document.projectId,
        session.artifactId,
        kind === 'mesh-payload' ? undefined : kind
      )
    ).toEqual({ deleted: true });
    release.resolve();
    expect(await finalizing).toBeNull();
    expect(objects.has(session.objectKey)).toBe(false);
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('cleans a claimed completed upload through the scheduled sweeper', async () => {
    const { service, db, objects, usage } = fixture();
    const { document, session } = await upload(service);
    await service.putUpload(owner, session.uploadSessionId, bytes.buffer);
    db.prepare(
      'INSERT INTO artifact_mesh_discards (artifact_id, project_id, object_key, claimed_at) VALUES (?, ?, ?, ?)'
    ).run(
      session.artifactId,
      document.projectId,
      session.objectKey,
      '2026-01-01T00:00:00Z'
    );
    expect(await service.purgeExpiredUploadSessions()).toBe(1);
    expect(objects.has(session.objectKey)).toBe(false);
    expect(usage()).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('accepts only an explicitly allowed original cleanup kind', () => {
    for (const kind of ['stl-import', 'mesh-import'] as const)
      expect(
        parseDiscardMeshPayloadRequest({ projectId: 'project_scan', kind })
      ).toEqual({ projectId: 'project_scan', kind });
    for (const kind of ['step-import', 'thumbnail', 'mesh-payload', '', null])
      expect(() =>
        parseDiscardMeshPayloadRequest({ projectId: 'project_scan', kind })
      ).toThrow(HttpError);
  });

  it('requires a bounded project id in the discard request', () => {
    expect(
      parseDiscardMeshPayloadRequest({ projectId: 'project_scan' })
    ).toEqual({ projectId: 'project_scan' });
    for (const body of [{}, { projectId: '' }, { projectId: 'x'.repeat(201) }])
      expect(() => parseDiscardMeshPayloadRequest(body)).toThrow(HttpError);
  });
});

describe('mesh discard HTTP and rollout boundary', () => {
  it.each(['stl-import', 'mesh-import'] as const)(
    'retains an editor-cancelled %s original for owner retry while compensating its payload',
    async (kind) => {
      const { service, db, usage } = fixture();
      const { document } = await service.createProject(owner, {
        name: 'Editor import cancelled'
      });
      db.prepare(
        'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
      ).run(document.projectId, outsider, 'editor', owner);
      const sessions = new Map<string, string>();
      const controller = new AbortController();
      const reason = new DOMException('Import cancelled', 'AbortError');
      const onCleanupFailure = vi.fn();
      const unexpectedMultipart = async (): Promise<never> => {
        throw new Error('Small import must use a single upload.');
      };
      const transport: ArchiveArtifactTransport = {
        createUploadSession: async (input) => {
          const result = await service.createUploadSession(outsider, input);
          sessions.set(
            result.session.uploadUrl!,
            result.session.uploadSessionId
          );
          return result;
        },
        uploadArtifact: async (url, body) => {
          await service.putUpload(
            outsider,
            sessions.get(url)!,
            await body.arrayBuffer()
          );
        },
        createMultipartUpload: unexpectedMultipart,
        uploadArtifactPart: unexpectedMultipart,
        completeMultipartUpload: unexpectedMultipart,
        abortMultipartUpload: unexpectedMultipart,
        finalizeArtifact: async (input) => ({
          artifactId:
            (await service.finalizeArtifact(outsider, input))?.artifactId ??
            null
        }),
        getArtifactMetadata: async (artifactId) => {
          const result = await service.getArtifactMetadata(
            outsider,
            artifactId
          );
          if (result.artifact?.kind === kind) controller.abort(reason);
          return result;
        },
        discardMeshPayload: (projectId, artifactId, originalKind) =>
          service.discardMeshPayload(
            outsider,
            projectId,
            artifactId,
            originalKind
          )
      };
      const originalBytes = new TextEncoder().encode('Original mesh file');
      await expect(
        archiveImportedMesh({
          hold: { bytes },
          sourceName: 'scan.stl',
          original: {
            fileName: 'scan.stl',
            kind,
            contentType: 'application/octet-stream',
            body: new Blob([originalBytes])
          },
          signal: controller.signal,
          onCleanupFailure,
          archive: (input) =>
            archiveArtifact(transport, document.projectId, input),
          discard: (artifactId) =>
            service.discardMeshPayload(outsider, document.projectId, artifactId)
        })
      ).rejects.toBe(reason);
      expect(onCleanupFailure).toHaveBeenCalledExactlyOnceWith(
        expect.any(ProjectNotFoundError)
      );
      const remaining = (await service.listArtifacts(owner, document.projectId))
        .artifacts;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.kind).toBe(kind);
      expect(usage()).toMatchObject({
        finalized_bytes: originalBytes.length,
        reserved_bytes: 0,
        active_sessions: 0
      });
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          remaining[0]!.artifactId,
          kind
        )
      ).toEqual({ deleted: true });
      expect(usage()).toMatchObject({
        finalized_bytes: 0,
        reserved_bytes: 0,
        active_sessions: 0
      });
    }
  );

  it.each(CLEANUP_KINDS)('authenticates cleanup POST (%s)', async (kind) => {
    const state = fixture();
    const { document, artifact } = await finalized(state.service, kind);
    const token = 'discard_test_session';
    state.db
      .prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      )
      .run(
        createHash('sha256').update(token).digest('hex'),
        owner,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000) + 3600
      );
    const env = {
      ...state.env,
      ENVIRONMENT: 'development' as const,
      AUTH_MODE: 'email-code' as const
    };
    const request = (headers: HeadersInit = {}) =>
      new Request(
        `https://example.com/api/artifacts/${artifact.artifactId}/discard-unreferenced`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            projectId: document.projectId,
            kind: kind === 'mesh-payload' ? undefined : kind
          })
        }
      );
    expect((await worker.fetch(request(), env)).status).toBe(401);
    expect(
      (
        await worker.fetch(
          request({
            cookie: `__Host-openzcad_session=${token}`,
            origin: 'https://other.example.com'
          }),
          env
        )
      ).status
    ).toBe(403);
    expect(state.objects.has(artifact.objectKey)).toBe(true);
    const response = await worker.fetch(
      request({
        cookie: `__Host-openzcad_session=${token}`,
        origin: 'https://example.com'
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(state.objects.has(artifact.objectKey)).toBe(false);
  });

  it.each(CLEANUP_KINDS)('requires the cleanup role for %s', async (kind) => {
    const { service, db } = fixture();
    const { document, artifact } = await finalized(service, kind);
    db.prepare(
      'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
    ).run(document.projectId, outsider, 'viewer', owner);
    await expect(
      service.discardMeshPayload(
        outsider,
        document.projectId,
        artifact.artifactId,
        kind === 'mesh-payload' ? undefined : kind
      )
    ).rejects.toThrow();
    db.prepare(
      'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?'
    ).run('editor', document.projectId, outsider);
    const cleanup = service.discardMeshPayload(
      outsider,
      document.projectId,
      artifact.artifactId,
      kind === 'mesh-payload' ? undefined : kind
    );
    if (kind === 'mesh-payload') {
      expect(await cleanup).toEqual({ deleted: true });
    } else {
      await expect(cleanup).rejects.toBeInstanceOf(ProjectNotFoundError);
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
    }
  });

  it.each(CLEANUP_KINDS)(
    'enforces original ownership on the authenticated cleanup route (%s)',
    async (kind) => {
      const { service, db, env, objects, usage } = fixture();
      const { document, artifact } = await finalized(service, kind);
      db.prepare(
        'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
      ).run(document.projectId, outsider, 'editor', owner);
      const token = 'discard_editor_test_session';
      db.prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      ).run(
        createHash('sha256').update(token).digest('hex'),
        outsider,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000) + 3600
      );
      const workerEnv = {
        ...env,
        ENVIRONMENT: 'development' as const,
        AUTH_MODE: 'email-code' as const
      };
      const headers = {
        cookie: `__Host-openzcad_session=${token}`,
        origin: 'https://example.com'
      };
      const listing = await worker.fetch(
        new Request(
          `https://example.com/api/projects/${document.projectId}/artifacts`,
          { headers }
        ),
        workerEnv
      );
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({
        artifacts: [
          expect.objectContaining({ artifactId: artifact.artifactId })
        ]
      });
      const response = await worker.fetch(
        new Request(
          `https://example.com/api/artifacts/${artifact.artifactId}/discard-unreferenced`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              projectId: document.projectId,
              kind: kind === 'mesh-payload' ? undefined : kind
            })
          }
        ),
        workerEnv
      );
      if (kind === 'mesh-payload') {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ deleted: true });
        expect(objects.has(artifact.objectKey)).toBe(false);
        expect(usage()).toMatchObject({ finalized_bytes: 0 });
      } else {
        expect(response.status).toBe(404);
        expect(objects.has(artifact.objectKey)).toBe(true);
        expect(usage()).toMatchObject({ finalized_bytes: bytes.length });
        expect(
          db
            .prepare('SELECT count(*) AS count FROM artifact_mesh_discards')
            .get()
        ).toMatchObject({ count: 0 });
      }
    }
  );

  it.each([
    'artifact_mesh_discards',
    'project_copy_cleanup_claims',
    'project_copy_source_archives'
  ])('fails readiness and health without %s', async (table) => {
    const { db, env } = fixture();
    expect(await isArtifactUploadAccountingReady(env.DB)).toBe(true);
    expect(await isD1ProjectStorageReady(env.DB)).toBe(true);
    expect(await isProjectObjectStorageReady(env.DB, env.ARTIFACTS)).toBe(true);
    db.exec(`DROP TABLE ${table}`);
    expect(await isArtifactUploadAccountingReady(env.DB)).toBe(false);
    expect(await isD1ProjectStorageReady(env.DB)).toBe(false);
    expect(await isProjectObjectStorageReady(env.DB, env.ARTIFACTS)).toBe(
      false
    );
    const response = await worker.fetch(
      new Request('https://example.com/api/health'),
      {
        ...env,
        ENVIRONMENT: 'development',
        AUTH_MODE: 'development'
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      artifactUploadAccountingReady: false,
      projectObjectStorageReady: false
    });
  });
});

function roomSubmission(
  document: ProjectDocument,
  baseVersion: number | null = null
) {
  return new Request(`https://room.test/?projectId=${document.projectId}`, {
    method: 'POST',
    headers: {
      'x-openzcad-user-id': owner,
      'x-openzcad-display-name': 'Owner',
      'x-openzcad-project-role': 'owner'
    },
    body: JSON.stringify({ clientId: 'client_discard', baseVersion, document })
  });
}

function roomFixture() {
  const state = fixture();
  const storage = createRoomContext();
  const room = createTestRoom(storage.context, state.env);
  const persistenceEnv = (
    state.service as unknown as { env: { PROJECT_ROOM?: unknown } }
  ).env;
  persistenceEnv.PROJECT_ROOM = {
    getByName: () => ({ fetch: (request: Request) => room.fetch(request) })
  };
  return { ...state, ...storage, room };
}

function roomsFixture() {
  const state = fixture();
  const rooms = new Map<
    string,
    ReturnType<typeof createRoomContext> & {
      room: ReturnType<typeof createTestRoom>;
    }
  >();
  const roomFor = (projectId: string) => {
    let entry = rooms.get(projectId);
    if (!entry) {
      const storage = createRoomContext();
      entry = { ...storage, room: createTestRoom(storage.context, state.env) };
      rooms.set(projectId, entry);
    }
    return entry;
  };
  (
    state.service as unknown as { env: { PROJECT_ROOM: unknown } }
  ).env.PROJECT_ROOM = {
    getByName: (projectId: string) => ({
      fetch: (request: Request) => roomFor(projectId).room.fetch(request)
    })
  };
  return { ...state, roomFor };
}

function referenceIds(document: ProjectDocument) {
  return [
    ...new Set(
      [...documentNodesWithHistory(document)].flatMap((node) =>
        node.kind === 'feature' && importedSourceReferenceOf(node.data)
          ? [(node.data as { artifactId: string }).artifactId]
          : []
      )
    )
  ];
}

async function sourceProject(service: PersistenceService) {
  const { document, artifact } = await finalized(service);
  const manager = imported(document, artifact.artifactId);
  await service.saveDocument(owner, {
    projectId: document.projectId,
    expectedVersion: document.version,
    document: manager.document
  });
  return manager.document;
}

describe('room copy completion', () => {
  it('copies a cloud-sized document without writing oversized room values', async () => {
    const state = roomsFixture();
    const imported = await sourceProject(state.service);
    const editor = new CommandManager(imported);
    editor.execute(
      commandFactories.importStep({
        name: 'Legacy embedded STEP',
        artifactId: 'artifact_local_legacy_step',
        sourceName: 'legacy.step',
        stepText:
          'ISO-10303-21;\nDATA;\n/*' +
          'P'.repeat(2_100_000) +
          '*/\nENDSEC;\nEND-ISO-10303-21;'
      })
    );
    await state.service.saveDocument(owner, {
      projectId: imported.projectId,
      expectedVersion: imported.version,
      document: editor.document
    });
    const complete = state.service.completeMultipartUpload.bind(state.service);
    vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        const target = (await state.service.listProjects(owner)).projects.find(
          (project) => project.projectId !== imported.projectId
        )!;
        const entry = state.roomFor(target.projectId);
        const put = entry.context.storage.put.bind(entry.context.storage);
        vi.spyOn(entry.context.storage, 'put').mockImplementation(
          async (keyOrEntries, value) => {
            const entries =
              typeof keyOrEntries === 'string'
                ? [[keyOrEntries, value]]
                : Object.entries(keyOrEntries as object);
            for (const [, stored] of entries)
              if (
                new TextEncoder().encode(JSON.stringify(stored)).byteLength >
                2_097_152
              )
                throw new Error('Room value exceeds SQLite 2MiB ceiling');
            await put(keyOrEntries, value);
          }
        );
      }
    );
    const copy = await state.service.duplicateProject(owner, {
      projectId: imported.projectId
    });
    expect(copy.document.featureOrder).toHaveLength(2);
    const entry = state.roomFor(copy.document.projectId);
    expect(entry.values.has('room:source-archives')).toBe(true);
    expect(entry.values.has('room:latest')).toBe(false);
    expect(
      (await state.service.loadProject(owner, copy.document.projectId))!
        .featureOrder
    ).toHaveLength(2);
  });

  it('keeps an acknowledged room graph when newer cloud state exceeds the room limit', async () => {
    const state = roomsFixture();
    const source = await sourceProject(state.service);
    const complete = state.service.completeMultipartUpload.bind(state.service);
    let targetId = source.projectId;
    let acknowledged!: ProjectDocument;
    vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        const target = (await state.service.listProjects(owner)).projects.find(
          (project) => project.projectId !== source.projectId
        )!;
        targetId = target.projectId;
        acknowledged = (await state.service.loadProject(owner, targetId))!;
        expect(
          (
            await state
              .roomFor(targetId)
              .room.fetch(roomSubmission(acknowledged))
          ).status
        ).toBe(200);
        const editor = new CommandManager(acknowledged);
        editor.execute(
          commandFactories.importStep({
            name: 'Cloud-only legacy STEP',
            artifactId: 'artifact_local_legacy_step',
            sourceName: 'legacy.step',
            stepText:
              'ISO-10303-21;\nDATA;\n/*' +
              'P'.repeat(2_100_000) +
              '*/\nENDSEC;\nEND-ISO-10303-21;'
          })
        );
        await state.service.saveDocument(owner, {
          projectId: targetId,
          expectedVersion: acknowledged.version,
          document: editor.document
        });
      }
    );
    await expect(
      state.service.duplicateProject(owner, { projectId: source.projectId })
    ).rejects.toThrow();
    const target = state.roomFor(targetId);
    expect((target.values.get('room:latest') as ProjectDocument).nodes).toEqual(
      acknowledged.nodes
    );
    expect(
      (await state.service.loadProject(owner, targetId))!.featureOrder
    ).toHaveLength(2);
    expect(
      (await state.service.listArtifacts(owner, targetId)).artifacts
    ).toHaveLength(1);
    await state.service.deleteProject(owner, source.projectId);
    target.room = createTestRoom(target.context, state.env);
    const response = await target.room.fetch(roomSubmission(acknowledged));
    expect(response.status).toBe(200);
    const restored = (await response.json()) as { document: ProjectDocument };
    expect(restored.document.featureOrder).toHaveLength(1);
    for (const artifactId of referenceIds(restored.document))
      expect(
        await state.service.downloadArtifact(owner, artifactId)
      ).not.toBeNull();
  });

  it.each([false, true])(
    'selects D1-only edits with an initial room snapshot: %s',
    async (initialRoom) => {
      const state = roomsFixture();
      const source = await sourceProject(state.service);
      const complete = state.service.completeMultipartUpload.bind(
        state.service
      );
      vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
        async (...args) => {
          await complete(...args);
          const target = (
            await state.service.listProjects(owner)
          ).projects.find((project) => project.projectId !== source.projectId)!;
          const pending = (await state.service.loadProject(
            owner,
            target.projectId
          ))!;
          if (initialRoom)
            expect(
              (
                await state
                  .roomFor(target.projectId)
                  .room.fetch(roomSubmission(pending))
              ).status
            ).toBe(200);
          const editor = new CommandManager(pending);
          editor.execute(
            commandFactories.addPrimitive({
              name: 'D1 owner edit',
              primitiveKind: 'box',
              dimensions: { width: 1, height: 2, depth: 3 }
            })
          );
          await state.service.saveDocument(owner, {
            projectId: target.projectId,
            expectedVersion: pending.version,
            document: editor.document
          });
        }
      );
      const copy = await state.service.duplicateProject(owner, {
        projectId: source.projectId
      });
      expect(copy.document.featureOrder).toHaveLength(2);
      expect(
        Object.values(copy.document.nodes).some(
          (node) => node.name === 'D1 owner edit'
        )
      ).toBe(true);
      expect(
        referenceIds(copy.document).every(
          (id) => !id.startsWith('artifact_local_')
        )
      ).toBe(true);
      expect(
        (
          state
            .roomFor(copy.document.projectId)
            .values.get('room:latest') as ProjectDocument
        ).nodes
      ).toEqual(copy.document.nodes);
    }
  );

  it('refuses unproven divergent room and D1 branches while keeping both graphs and bytes', async () => {
    const state = roomsFixture();
    const source = await sourceProject(state.service);
    const complete = state.service.completeMultipartUpload.bind(state.service);
    let targetId = source.projectId;
    let roomDocument!: ProjectDocument;
    let d1Document!: ProjectDocument;
    vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        const target = (await state.service.listProjects(owner)).projects.find(
          (project) => project.projectId !== source.projectId
        )!;
        targetId = target.projectId;
        const pending = (await state.service.loadProject(owner, targetId))!;
        const roomEditor = new CommandManager(pending);
        roomEditor.execute(
          commandFactories.addPrimitive({
            name: 'Room branch',
            primitiveKind: 'box',
            dimensions: { width: 1, height: 2, depth: 3 }
          })
        );
        roomDocument = roomEditor.document;
        expect(
          (
            await state
              .roomFor(targetId)
              .room.fetch(roomSubmission(roomDocument))
          ).status
        ).toBe(200);
        const d1Editor = new CommandManager(pending);
        d1Editor.execute(
          commandFactories.addPrimitive({
            name: 'D1 branch',
            primitiveKind: 'box',
            dimensions: { width: 3, height: 2, depth: 1 }
          })
        );
        d1Document = d1Editor.document;
        await state.service.saveDocument(owner, {
          projectId: targetId,
          expectedVersion: pending.version,
          document: d1Document
        });
      }
    );
    await expect(
      state.service.duplicateProject(owner, { projectId: source.projectId })
    ).rejects.toThrow();
    expect((await state.service.loadProject(owner, targetId))!.nodes).toEqual(
      reconcileCopiedImportSources(
        d1Document,
        await state.service.loadCopiedImportArchives(owner, targetId)
      ).nodes
    );
    expect(
      (state.roomFor(targetId).values.get('room:latest') as ProjectDocument)
        .nodes
    ).toEqual(roomDocument.nodes);
    const archives = (await state.service.listArtifacts(owner, targetId))
      .artifacts;
    expect(archives).toHaveLength(1);
    expect(
      await state.service.downloadArtifact(owner, archives[0]!.artifactId)
    ).not.toBeNull();
    expect(
      state.db
        .prepare('SELECT count(*) AS count FROM project_copy_cleanup_claims')
        .get()
    ).toMatchObject({ count: 0 });
  });

  it('keeps the acknowledged graph and journal when the D1 canonical write fails', async () => {
    const state = roomsFixture();
    const source = await sourceProject(state.service);
    const complete = state.service.completeMultipartUpload.bind(state.service);
    let targetId = source.projectId;
    let acknowledged!: ProjectDocument;
    vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        const target = (await state.service.listProjects(owner)).projects.find(
          (project) => project.projectId !== source.projectId
        )!;
        targetId = target.projectId;
        const pending = (await state.service.loadProject(owner, targetId))!;
        const editor = new CommandManager(pending);
        editor.execute(
          commandFactories.addPrimitive({
            name: 'Room edit before failed D1 write',
            primitiveKind: 'box',
            dimensions: { width: 1, height: 2, depth: 3 }
          })
        );
        acknowledged = editor.document;
        expect(
          (
            await state
              .roomFor(targetId)
              .room.fetch(roomSubmission(acknowledged))
          ).status
        ).toBe(200);
        state.hooks.put = async () => {
          throw new Error('D1 snapshot upload interrupted');
        };
      }
    );
    await expect(
      state.service.duplicateProject(owner, { projectId: source.projectId })
    ).rejects.toThrow();
    const entry = state.roomFor(targetId);
    expect(entry.values.has('room:source-archives')).toBe(true);
    expect(
      (await state.service.loadProject(owner, targetId))!.featureOrder
    ).toHaveLength(1);
    const archives = (await state.service.listArtifacts(owner, targetId))
      .artifacts;
    expect(archives).toHaveLength(1);
    delete state.hooks.put;
    await state.service.deleteProject(owner, source.projectId);
    entry.room = createTestRoom(entry.context, state.env);
    const response = await entry.room.fetch(roomSubmission(acknowledged));
    expect(response.status).toBe(200);
    const ack = (await response.json()) as {
      type: string;
      document: ProjectDocument;
    };
    expect(ack.document.featureOrder).toHaveLength(2);
    expect(referenceIds(ack.document)).toEqual(
      archives.map((artifact) => artifact.artifactId)
    );
    expect(
      await state.service.downloadArtifact(owner, archives[0]!.artifactId)
    ).not.toBeNull();
  });

  it('keeps acknowledged edits and resolves retained and late sources after deleting the original', async () => {
    const state = roomsFixture();
    const source = await sourceProject(state.service);
    const complete = state.service.completeMultipartUpload.bind(state.service);
    let acknowledged!: ProjectDocument;
    vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        const target = (await state.service.listProjects(owner)).projects.find(
          (project) => project.projectId !== source.projectId
        )!;
        const pending = (await state.service.loadProject(
          owner,
          target.projectId
        ))!;
        const editor = new CommandManager(pending);
        editor.execute(
          commandFactories.addPrimitive({
            name: 'Owner edit during copy',
            primitiveKind: 'box',
            dimensions: { width: 1, height: 2, depth: 3 }
          })
        );
        acknowledged = editor.document;
        const response = await state
          .roomFor(target.projectId)
          .room.fetch(roomSubmission(acknowledged));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ type: 'ack' });
      }
    );
    const copy = await state.service.duplicateProject(owner, {
      projectId: source.projectId
    });
    expect(copy.document.featureOrder).toHaveLength(2);
    expect(
      referenceIds(copy.document).every(
        (id) => !id.startsWith('artifact_local_')
      )
    ).toBe(true);
    const target = state.roomFor(copy.document.projectId);
    expect(
      referenceIds(target.values.get('room:latest') as ProjectDocument)
    ).toEqual(referenceIds(copy.document));
    for (const [key, document] of target.values) {
      if (key.startsWith('room:history:'))
        expect(
          referenceIds(document as ProjectDocument).every(
            (id) => !id.startsWith('artifact_local_')
          )
        ).toBe(true);
    }
    await state.service.deleteProject(owner, source.projectId);
    target.room = createTestRoom(target.context, state.env);
    const late = new CommandManager(acknowledged);
    late.execute(
      commandFactories.addPrimitive({
        name: 'Late edit after completion',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      })
    );
    const response = await target.room.fetch(
      roomSubmission(late.document, acknowledged.version)
    );
    expect(response.status).toBe(200);
    const ack = (await response.json()) as {
      type: string;
      document: ProjectDocument;
    };
    expect(ack.type).toBe('ack');
    expect(ack.document.featureOrder).toHaveLength(3);
    const published = target.values.get('room:latest') as ProjectDocument;
    expect(
      referenceIds(published).every((id) => !id.startsWith('artifact_local_'))
    ).toBe(true);
    for (const id of referenceIds(published))
      expect(await state.service.downloadArtifact(owner, id)).not.toBeNull();
  });

  it.each(['journal', 'canonical'] as const)(
    'preserves graph and owned bytes across failed DO %s publication and restart',
    async (failure) => {
      const state = roomsFixture();
      const source = await sourceProject(state.service);
      const complete = state.service.completeMultipartUpload.bind(
        state.service
      );
      let targetId = source.projectId;
      let acknowledged!: ProjectDocument;
      vi.spyOn(state.service, 'completeMultipartUpload').mockImplementationOnce(
        async (...args) => {
          await complete(...args);
          const target = (
            await state.service.listProjects(owner)
          ).projects.find((project) => project.projectId !== source.projectId)!;
          targetId = target.projectId;
          const pending = (await state.service.loadProject(owner, targetId))!;
          const editor = new CommandManager(pending);
          editor.execute(
            commandFactories.addPrimitive({
              name: 'Acknowledged graph',
              primitiveKind: 'box',
              dimensions: { width: 1, height: 2, depth: 3 }
            })
          );
          acknowledged = editor.document;
          const entry = state.roomFor(targetId);
          expect(
            (await entry.room.fetch(roomSubmission(acknowledged))).status
          ).toBe(200);
          const put = entry.context.storage.put.bind(entry.context.storage);
          vi.spyOn(entry.context.storage, 'put').mockImplementation(
            async (keyOrEntries, value) => {
              if (
                (failure === 'journal' &&
                  keyOrEntries === 'room:source-archives') ||
                (failure === 'canonical' &&
                  typeof keyOrEntries === 'object' &&
                  keyOrEntries !== null &&
                  'room:latest' in keyOrEntries)
              )
                throw new Error('DO publication interrupted');
              await put(keyOrEntries, value);
            }
          );
        }
      );
      await expect(
        state.service.duplicateProject(owner, { projectId: source.projectId })
      ).rejects.toThrow();
      const entry = state.roomFor(targetId);
      expect(entry.values.has('room:source-archives')).toBe(
        failure === 'canonical'
      );
      expect(
        (await state.service.loadProject(owner, targetId))!.featureOrder
      ).toHaveLength(failure === 'canonical' ? 2 : 1);
      const archives = (await state.service.listArtifacts(owner, targetId))
        .artifacts;
      expect(archives).toHaveLength(1);
      vi.restoreAllMocks();
      await state.service.deleteProject(owner, source.projectId);
      entry.room = createTestRoom(entry.context, state.env);
      const response = await entry.room.fetch(roomSubmission(acknowledged));
      expect(response.status).toBe(200);
      const ack = (await response.json()) as {
        type: string;
        document: ProjectDocument;
      };
      expect(ack.type).toBe('ack');
      expect(ack.document.featureOrder).toHaveLength(2);
      expect(referenceIds(ack.document)).toEqual(
        archives.map((artifact) => artifact.artifactId)
      );
      expect(
        await state.service.downloadArtifact(owner, archives[0]!.artifactId)
      ).not.toBeNull();
    }
  );
});

describe('room-serialized mesh cleanup', () => {
  it('preserves owner archival acknowledged at the original document version', async () => {
    const { service, room, db, values } = roomFixture();
    const { document } = await finalized(service);
    const manager = imported(document, 'artifact_local_pending_source');
    await service.saveDocument(owner, {
      projectId: document.projectId,
      expectedVersion: document.version,
      document: manager.document
    });
    const initial = db
      .prepare(
        'SELECT document_json, document_object_id FROM projects WHERE id = ?'
      )
      .get(document.projectId) as {
      document_json: string;
      document_object_id: string | null;
    };
    const expectedDocumentDigest = await projectCopyDocumentDigest(
      manager.document
    );
    const { session } = await service.createUploadSession(owner, {
      projectId: document.projectId,
      fileName: 'owner-archive.ozmesh',
      kind: 'mesh-payload',
      contentType: 'application/vnd.openzcad.mesh-payload'
    });
    await service.putUpload(owner, session.uploadSessionId, bytes.buffer);
    const archivedArtifact = (await service.finalizeArtifact(owner, {
      projectId: document.projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    }))!;
    const archived = archiveHistorySources(manager.document, {
      featureId: manager.document.featureOrder[0]!,
      artifactId: archivedArtifact.artifactId
    });
    expect(archived.version).toBe(manager.document.version);
    expect(await projectCopyDocumentDigest(archived)).not.toBe(
      expectedDocumentDigest
    );
    const acknowledgement = await room.fetch(roomSubmission(archived));
    expect(acknowledgement.status).toBe(200);
    expect(await acknowledgement.json()).toMatchObject({ type: 'ack' });
    // Its original D1 version/content has not advanced; only the room owns this change.
    const cleanup = await room.fetch(
      new Request(
        `https://room.test/_internal/source-cleanup?projectId=${document.projectId}`,
        {
          method: 'POST',
          headers: { 'x-openzcad-internal-source-cleanup': 'v1' },
          body: JSON.stringify({
            action: 'rollback-copy',
            userId: owner,
            expectedVersion: manager.document.version,
            expectedDocumentDigest,
            expectedDocumentJsonDigest: createHash('sha256')
              .update(initial.document_json)
              .digest('hex'),
            expectedDocumentObjectId: initial.document_object_id
          })
        }
      )
    );
    expect(cleanup.status).toBe(409);
    expect(await cleanup.json()).toMatchObject({
      code: 'REVISION_CONFLICT',
      currentVersion: manager.document.version
    });
    expect((values.get('room:latest') as ProjectDocument).nodes).toEqual(
      archived.nodes
    );
    expect(await service.loadProject(owner, document.projectId)).not.toBeNull();
    expect(
      await service.downloadArtifact(owner, archivedArtifact.artifactId)
    ).not.toBeNull();
    expect(
      db
        .prepare('SELECT count(*) AS count FROM project_copy_cleanup_claims')
        .get()
    ).toMatchObject({ count: 0 });
  });

  it('compares canonical metadata while ignoring derived presentation and record order', async () => {
    const { document } = await fixture().service.createProject(owner, {
      name: 'Identity'
    });
    const reordered = {
      ...document,
      nodes: Object.fromEntries(Object.entries(document.nodes).reverse()),
      derived: {
        ...document.derived,
        warnings: ['Disposable warning'],
        updatedAt: '2040-01-01T00:00:00Z'
      }
    };
    expect(await projectCopyDocumentDigest(reordered)).toBe(
      await projectCopyDocumentDigest(document)
    );
    expect(
      await projectCopyDocumentDigest({
        ...document,
        name: 'Owner changed metadata'
      })
    ).not.toBe(await projectCopyDocumentDigest(document));
  });

  it.each(CLEANUP_KINDS)(
    'protects room acknowledgements (%s)',
    async (kind) => {
      const { service, room, values } = roomFixture();
      const { document, artifact } = await finalized(service, kind);
      const manager = imported(document, artifact.artifactId);
      const response = await room.fetch(roomSubmission(manager.document));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: 'ack' });
      expect(
        (await service.loadProject(owner, document.projectId))?.featureOrder
      ).toEqual([]);
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId,
          kind === 'mesh-payload' ? undefined : kind
        )
      ).toEqual({ deleted: false });
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
      expect(
        (values.get('room:latest') as ProjectDocument).featureOrder
      ).toHaveLength(1);
    }
  );

  it.each(['retained', 'missing'] as const)(
    'keeps sources held by %s room history after hibernation',
    async (historyState) => {
      const { service, room, context, values, env } = roomFixture();
      const { document, artifact } = await finalized(service);
      const manager = imported(document, artifact.artifactId);
      expect((await room.fetch(roomSubmission(manager.document))).status).toBe(
        200
      );
      const empty = structuredClone(document);
      empty.version = manager.document.version + 1;
      empty.revisions = manager.document.revisions;
      empty.checkpoints = manager.document.checkpoints;
      expect(
        (await room.fetch(roomSubmission(empty, manager.document.version)))
          .status
      ).toBe(200);
      expect(
        (values.get('room:latest') as ProjectDocument).featureOrder
      ).toEqual([]);
      if (historyState === 'missing')
        values.delete(`room:history:${manager.document.version}`);
      const restored = createTestRoom(context, {
        ...env,
        PROJECT_ROOM: undefined
      });
      (
        service as unknown as { env: { PROJECT_ROOM: unknown } }
      ).env.PROJECT_ROOM = {
        getByName: () => ({
          fetch: (request: Request) => restored.fetch(request)
        })
      };
      expect(
        await service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId
        )
      ).toEqual({ deleted: false });
      expect(
        await service.downloadArtifact(owner, artifact.artifactId)
      ).not.toBeNull();
    }
  );

  it.each(CLEANUP_KINDS)('rejects late HTTP publication (%s)', async (kind) => {
    const { service, room, hooks, values } = roomFixture();
    const { document, artifact } = await finalized(service, kind);
    const manager = imported(document, artifact.artifactId);
    const entered = deferred();
    const release = deferred();
    hooks.delete = async () => {
      entered.resolve();
      await release.promise;
    };
    const discarding = service.discardMeshPayload(
      owner,
      document.projectId,
      artifact.artifactId,
      kind === 'mesh-payload' ? undefined : kind
    );
    await entered.promise;
    const submission = room.fetch(roomSubmission(manager.document));
    release.resolve();
    expect(await discarding).toEqual({ deleted: true });
    const response = await submission;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: 'error',
      code: 'document-invalid'
    });
    expect(values.has('room:latest')).toBe(false);
    expect(
      await service.downloadArtifact(owner, artifact.artifactId)
    ).toBeNull();
  });

  it.each(CLEANUP_KINDS)(
    'refuses missing-source WS ACKs (%s)',
    async (kind) => {
      const globals = installWorkerSocketGlobals();
      try {
        const { service, room, values, hooks } = roomFixture();
        const { document, artifact } = await finalized(service, kind);
        const manager = imported(document, artifact.artifactId);
        const upgrade = await room.fetch(
          new Request(`https://room.test/?projectId=${document.projectId}`, {
            headers: {
              upgrade: 'websocket',
              'x-openzcad-user-id': owner,
              'x-openzcad-display-name': 'Owner',
              'x-openzcad-project-role': 'owner'
            }
          })
        );
        expect(upgrade.status).toBe(101);
        const socket = globals.serverSockets.at(-1)!;
        await socket.receive(
          JSON.stringify({
            type: 'hello',
            clientId: 'client_discard',
            displayName: 'Owner',
            baseVersion: null,
            document
          })
        );
        const before = socket
          .frames()
          .filter((frame) => frame.type === 'ack').length;
        const entered = deferred();
        const release = deferred();
        hooks.delete = async () => {
          entered.resolve();
          await release.promise;
        };
        const discarding = service.discardMeshPayload(
          owner,
          document.projectId,
          artifact.artifactId,
          kind === 'mesh-payload' ? undefined : kind
        );
        await entered.promise;
        const incoming = socket.receive(
          JSON.stringify({
            type: 'document',
            clientId: 'client_discard',
            baseVersion: document.version,
            document: manager.document
          })
        );
        release.resolve();
        expect(await discarding).toEqual({ deleted: true });
        await incoming;
        expect(
          socket.frames().filter((frame) => frame.type === 'ack')
        ).toHaveLength(before);
        expect(socket.frames()).toContainEqual(
          expect.objectContaining({ type: 'error', code: 'document-invalid' })
        );
        expect(
          (values.get('room:latest') as ProjectDocument).featureOrder
        ).toEqual([]);
        expect(socket.closed).toBeNull();
      } finally {
        globals.restore();
      }
    }
  );

  it('requires the private pathname, header and an authorized editor', async () => {
    const { service, room, objects } = roomFixture();
    const { document, artifact } = await finalized(service);
    const internal = (pathname: string, header: boolean, userId = owner) =>
      new Request(
        `https://room.test${pathname}?projectId=${document.projectId}`,
        {
          method: 'POST',
          headers: header ? { 'x-openzcad-internal-source-cleanup': 'v1' } : {},
          body: JSON.stringify({
            action: 'discard-mesh',
            userId,
            artifactId: artifact.artifactId
          })
        }
      );
    expect(
      (await room.fetch(internal('/_internal/source-cleanup', false))).status
    ).toBe(403);
    expect((await room.fetch(internal('/', true))).status).toBe(400);
    await expect(
      room.fetch(internal('/_internal/source-cleanup', true, outsider))
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(objects.has(artifact.objectKey)).toBe(true);
  });

  it.each(CLEANUP_KINDS)(
    'enforces original ownership inside the serialized room cleanup (%s)',
    async (kind) => {
      const { service, room, objects, usage, db } = roomFixture();
      const { document, artifact } = await finalized(service, kind);
      db.prepare(
        'INSERT INTO project_members (project_id, user_id, role, added_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
      ).run(document.projectId, outsider, 'editor', owner);
      const request = (userId: string) =>
        new Request(
          `https://room.test/_internal/source-cleanup?projectId=${document.projectId}`,
          {
            method: 'POST',
            headers: { 'x-openzcad-internal-source-cleanup': 'v1' },
            body: JSON.stringify({
              action: 'discard-mesh',
              userId,
              artifactId: artifact.artifactId,
              kind: kind === 'mesh-payload' ? undefined : kind
            })
          }
        );
      if (kind === 'mesh-payload') {
        const response = await room.fetch(request(outsider));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ deleted: true });
        expect(objects.has(artifact.objectKey)).toBe(false);
      } else {
        await expect(room.fetch(request(outsider))).rejects.toBeInstanceOf(
          ProjectNotFoundError
        );
        expect(objects.has(artifact.objectKey)).toBe(true);
        expect(usage()).toMatchObject({ finalized_bytes: bytes.length });
        expect(
          db
            .prepare('SELECT count(*) AS count FROM artifact_mesh_discards')
            .get()
        ).toMatchObject({ count: 0 });
        const response = await room.fetch(request(owner));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ deleted: true });
        expect(objects.has(artifact.objectKey)).toBe(false);
        expect(usage()).toMatchObject({ finalized_bytes: 0 });
      }
    }
  );
});
