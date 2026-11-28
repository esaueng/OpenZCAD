import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { parseStl } from '@openzcad/io-stl';
import {
  ARTIFACT_UPLOAD_PART_BYTES,
  decodeImportedMeshPayload,
  documentStructureError,
  toArtifactId,
  toProjectId,
  toUploadSessionId,
  toUserId,
  type ArtifactKind,
  type ProjectDocument
} from '@openzcad/shared';
import {
  archiveLocalOnlyImportSources,
  createInFlightImportChecksums,
  listLocalOnlyImportSources
} from './importArchival';
import {
  importedMeshCommand,
  meshInDocumentUnits
} from './importedMeshCommand';
import {
  archiveImportedMesh as archiveImportedMeshImplementation,
  holdImportedMeshPayload,
  meshImportRunResult,
  type MeshPayloadStore
} from './importedMeshPayload';
import {
  hasSourceBlob,
  loadSourceBlob,
  saveImportedProject,
  saveLocalProject
} from './localProjectStore';
import { createProjectBackup } from './projectBackupTransfer';
import { parseProjectBackup } from './projectBackup';
import {
  archiveArtifact,
  type ArchiveArtifactTransport
} from './archiveArtifact';
import { ApiError, encryptedLocalOnly } from './api';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const user = toUserId('user_mesh_payload');

/** A binary STL of facets on a 0.1 mm grid, like any scanned part. */
function binaryStl(triangles: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  for (let i = 0; i < triangles; i += 1) {
    const base = 84 + i * 50 + 12;
    const x = (i % 1000) * 0.1;
    const y = Math.floor(i / 1000) * 0.1;
    [x, y, 0, x + 0.1, y, 0, x, y + 0.1, 0.5].forEach((value, k) =>
      view.setFloat32(base + k * 4, value, true)
    );
  }
  return buffer;
}

function marks() {
  return {
    inFlight: createInFlightImportChecksums(),
    abandoned: new Set<string>()
  };
}

let ids = 0;
const newId = () => `id_${(ids += 1)}`;

function archiveImportedMesh(
  input: Omit<
    Parameters<typeof archiveImportedMeshImplementation>[0],
    'discard'
  > & {
    discard?: Parameters<
      typeof archiveImportedMeshImplementation
    >[0]['discard'];
  }
) {
  return archiveImportedMeshImplementation({
    discard: async () => ({ deleted: true }),
    ...input
  });
}

describe('holding a mesh import payload', () => {
  const triangles = {
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2]
  };

  it('stores one payload and hands the command a reference', async () => {
    const held = marks();
    const hold = await holdImportedMeshPayload({
      triangles,
      marks: held,
      newId
    });
    expect('meshPayloadRef' in hold.form).toBe(true);
    const ref = (hold.form as { meshPayloadRef: { checksumSha256: string } })
      .meshPayloadRef;
    expect(held.inFlight.has(ref.checksumSha256)).toBe(true);
    const stored = await loadSourceBlob(ref.checksumSha256);
    expect(stored).toEqual(hold.bytes);
    expect(Array.from(decodeImportedMeshPayload(stored!).vertices)).toEqual(
      triangles.vertices
    );

    // A refused import that wrote the bytes takes them away again.
    expect(await hold.settle('refused', null)).toBe(true);
    expect(held.inFlight.has(ref.checksumSha256)).toBe(false);
    expect(await hasSourceBlob(ref.checksumSha256)).toBe(false);
    // Settling twice is a no-op, never a second deletion attempt.
    expect(await hold.settle('refused', null)).toBe(false);
  });

  it('keeps the payload of a committed import', async () => {
    const hold = await holdImportedMeshPayload({
      triangles,
      marks: marks(),
      newId
    });
    const manager = new CommandManager(createProjectDocument('Kept', user));
    manager.execute(
      importedMeshCommand(
        { name: 'tri.stl', triangleCount: 1 },
        hold.form,
        'artifact_local_tri'
      )
    );
    await saveLocalProject(manager.document);
    const ref = (hold.form as { meshPayloadRef: { checksumSha256: string } })
      .meshPayloadRef;
    expect(await hold.settle('committed', manager.document)).toBe(false);
    expect(await hasSourceBlob(ref.checksumSha256)).toBe(true);
  });

  it('embeds the triangles when this browser has no usable blob storage', async () => {
    const store: MeshPayloadStore = {
      ensureLocalProjectStorage: async () => 'unavailable',
      putSourceBlobIfAbsent: () => {
        throw new Error('must not write');
      },
      deleteSourceBlobIfUnreferenced: () => {
        throw new Error('must not delete');
      },
      releaseSourceBlobClaim: async () => undefined
    };
    const hold = await holdImportedMeshPayload({
      triangles,
      marks: marks(),
      newId,
      store
    });
    expect(hold.form).toBe(triangles);
    expect(hold.bytes).toBeNull();
    expect(await hold.settle('refused', null)).toBe(false);
  });

  it('maps a validated run onto what becomes of the bytes', () => {
    expect(meshImportRunResult('committed', false)).toBe('committed');
    expect(meshImportRunResult('committed', true)).toBe('committed');
    expect(meshImportRunResult('failed', true)).toBe('cancelled');
    expect(meshImportRunResult('cancelled', false)).toBe('cancelled');
    expect(meshImportRunResult('busy', false)).toBe('no-verdict');
    expect(meshImportRunResult('superseded', false)).toBe('no-verdict');
    expect(meshImportRunResult('rejected', false)).toBe('refused');
    expect(meshImportRunResult('failed', false)).toBe('refused');
  });

  it.each(['unavailable', 'ready'] as const)(
    'refuses a required reference if storage is %s and the payload cannot be written',
    async (readiness) => {
      const store: MeshPayloadStore = {
        ensureLocalProjectStorage: async () => readiness,
        putSourceBlobIfAbsent: vi
          .fn()
          .mockRejectedValue(new Error('Quota exceeded')),
        deleteSourceBlobIfUnreferenced: vi.fn(),
        releaseSourceBlobClaim: vi.fn()
      };
      await expect(
        holdImportedMeshPayload({
          triangles,
          marks: marks(),
          newId,
          store,
          requireReference: true
        })
      ).rejects.toThrow('Large STL imports require browser storage');
      expect(store.putSourceBlobIfAbsent).toHaveBeenCalledTimes(
        readiness === 'ready' ? 1 : 0
      );
    }
  );
});

describe('archiving a mesh import', () => {
  const original = {
    fileName: 'scan.stl',
    contentType: 'model/stl',
    kind: 'stl-import' as const,
    body: new NodeBlob(['solid']) as unknown as Blob
  };

  it('points a referenced mesh at its uploaded payload, and stores the original beside it', async () => {
    const uploads: string[] = [];
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        uploads.push(`${input.kind}:${input.fileName}`);
        return `artifact_${input.kind}`;
      },
      newId
    });
    expect(uploads).toEqual([
      'mesh-payload:scan.stl.ozmesh',
      'stl-import:scan.stl'
    ]);
    expect(archived).toEqual({
      artifactId: 'artifact_mesh-payload',
      payloadArchived: true,
      originalArchived: true,
      note: '.'
    });
  });

  it('lands a referenced mesh locally when its payload upload fails', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        if (input.kind === 'mesh-payload') throw new Error('offline');
        return 'artifact_original';
      },
      newId
    });
    expect(archived.artifactId).toMatch(/^artifact_local_/);
    expect(archived.payloadArchived).toBe(false);
    expect(archived.originalArchived).toBe(true);
    // The status line says what other devices are missing.
    expect(archived.note).toBe(
      ' (cloud archive unavailable; mesh saved locally).'
    );
  });

  // #1637: an encrypted project refuses the original by design, so the note
  // says so instead of reporting an upload that could be retried.
  it('says an encrypted project keeps the mesh, not the original file', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'plate.3mf',
      original: {
        ...original,
        fileName: 'plate.3mf',
        contentType: 'model/3mf',
        kind: 'mesh-import'
      },
      archive: async (input) => {
        if (input.kind === 'mesh-payload') return 'blob_payload';
        throw encryptedLocalOnly('Stored files');
      },
      newId
    });
    expect(archived).toEqual({
      artifactId: 'blob_payload',
      payloadArchived: true,
      originalArchived: false,
      note: ' (original file not stored: an encrypted project keeps the imported mesh, not the original file).'
    });
  });

  // #1637, the whole path in an encrypted project (as an encrypted revision
  // branch is one). The encrypted route is the only one asked: it takes the
  // mesh the feature names and refuses the picked file by kind, before it
  // reads a byte. A payload that cannot upload leaves the import listed as
  // local-only, and each retry offers that payload alone until one stores
  // it, once, with the geometry untouched.
  it('keeps a failed encrypted mesh archive pending until a retry stores the payload once', async () => {
    const { contentBlobKindFor } = await import('./e2ee/encryptedContentBlobs');
    let reachable = false;
    const stored: string[] = [];
    const refusedByKind: string[] = [];
    /** `archiveEncryptedArtifact`, as far as kinds and reachability go. */
    const archiveEncrypted = async (input: {
      kind: ArtifactKind;
      fileName: string;
    }) => {
      let blobKind: string;
      try {
        blobKind = contentBlobKindFor(input.kind).kind;
      } catch (error) {
        refusedByKind.push(input.kind);
        throw error;
      }
      if (!reachable) throw new ApiError(503, 'Storage is unavailable.');
      stored.push(`${blobKind}:${input.fileName}`);
      return `${stored.length}`.padStart(32, '0');
    };
    const plate = {
      ...original,
      fileName: 'plate.3mf',
      contentType: 'model/3mf',
      kind: 'mesh-import' as const
    };
    const payload = new Uint8Array([1, 2, 3]);

    const landed = await archiveImportedMesh({
      hold: { bytes: payload },
      sourceName: 'plate.3mf',
      original: plate,
      archive: archiveEncrypted,
      newId
    });
    expect(landed.artifactId).toMatch(/^artifact_local_/);
    expect(landed.note).toBe(
      ' (cloud archive unavailable; mesh saved locally).'
    );
    expect(stored).toEqual([]);
    expect(refusedByKind).toEqual(['mesh-import']);

    const manager = new CommandManager(
      createProjectDocument('Encrypted branch', user)
    );
    manager.execute(
      commandFactories.importMesh({
        name: 'plate',
        artifactId: landed.artifactId,
        sourceName: 'plate.3mf',
        triangleCount: 1,
        meshPayloadRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: 'ab'.repeat(32),
          logicalBytes: payload.byteLength
        }
      })
    );
    const pending = () =>
      listLocalOnlyImportSources(manager.document).map(
        (source) => `${source.kind}:${source.sourceName}`
      );
    const retry = () =>
      archiveLocalOnlyImportSources({
        document: manager.document,
        loadSourceBytes: async () => payload,
        archive: archiveEncrypted,
        applyArtifactId: (featureId, artifactId, source) => {
          manager.archiveSource(featureId, artifactId, source);
          return true;
        }
      });
    expect(pending()).toEqual(['mesh-payload:plate.3mf']);

    // Still unreachable: nothing is lost and the import stays listed.
    expect(await retry()).toEqual({
      archived: [],
      missing: [],
      failed: ['plate.3mf']
    });
    expect(pending()).toEqual(['mesh-payload:plate.3mf']);

    reachable = true;
    expect(await retry()).toEqual({
      archived: ['plate.3mf'],
      missing: [],
      failed: []
    });
    expect(pending()).toEqual([]);
    // A second retry has nothing left to send.
    expect(await retry()).toEqual({ archived: [], missing: [], failed: [] });
    expect(stored).toEqual(['mesh-payload:plate.3mf.ozmesh']);
    // The retries never offered the picked file, and added no feature.
    expect(refusedByKind).toEqual(['mesh-import']);
    expect(manager.document.featureOrder).toHaveLength(1);

    // With the account reachable the import archives at once, and the
    // picked file's absence is the project's rule, not a failed upload.
    const direct = await archiveImportedMesh({
      hold: { bytes: payload },
      sourceName: 'plate.3mf',
      original: plate,
      archive: archiveEncrypted,
      newId
    });
    expect(direct).toEqual({
      artifactId: '2'.padStart(32, '0'),
      payloadArchived: true,
      originalArchived: false,
      note: ' (original file not stored: an encrypted project keeps the imported mesh, not the original file).'
    });
  });

  it('still reports a failed original upload as unavailable', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        if (input.kind === 'mesh-payload') return 'artifact_payload';
        throw new Error('offline');
      },
      newId
    });
    expect(archived.originalArchived).toBe(false);
    expect(archived.note).toBe(
      ' (original file not archived: upload unavailable).'
    );
  });

  it('points an embedded mesh at the original, as before references', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: null },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => `artifact_${input.kind}`,
      newId
    });
    expect(archived).toEqual({
      artifactId: 'artifact_stl-import',
      payloadArchived: null,
      originalArchived: true,
      note: '.'
    });
  });

  it('uses the remaining quota for the required payload before the optional original', async () => {
    const uploaded: string[] = [];
    let remainingBytes = 8;
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array(8) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        if (input.body.size > remainingBytes) throw new Error('Quota exceeded');
        remainingBytes -= input.body.size;
        uploaded.push(input.kind);
        return `artifact_${input.kind}`;
      },
      newId
    });
    expect(uploaded).toEqual(['mesh-payload']);
    expect(archived.artifactId).toBe('artifact_mesh-payload');
    expect(archived.payloadArchived).toBe(true);
    expect(archived.originalArchived).toBe(false);
  });

  it('rethrows a cancelled upload instead of landing local-only', async () => {
    const abort = new AbortController();
    await expect(
      archiveImportedMesh({
        hold: { bytes: new Uint8Array([1]) },
        sourceName: 'scan.stl',
        original,
        archive: async () => {
          abort.abort();
          throw new DOMException('stopped', 'AbortError');
        },
        newId,
        signal: abort.signal
      })
    ).rejects.toThrow('stopped');
  });

  it('discards the finalized payload when the optional original upload is cancelled', async () => {
    const controller = new AbortController();
    const reason = new DOMException('original upload stopped', 'AbortError');
    const finalizedPayloads: string[] = [];
    const archive = vi.fn(async (input: { kind: string }) => {
      if (input.kind === 'mesh-payload') {
        finalizedPayloads.push('artifact_payload');
        return 'artifact_payload';
      }
      controller.abort(reason);
      throw reason;
    });
    const discard = vi.fn(async (artifactId: string) => {
      finalizedPayloads.splice(finalizedPayloads.indexOf(artifactId), 1);
      return { deleted: true };
    });
    await expect(
      archiveImportedMesh({
        hold: { bytes: new Uint8Array([1, 2, 3]) },
        sourceName: 'scan.stl',
        original,
        archive,
        discard,
        signal: controller.signal
      })
    ).rejects.toBe(reason);
    expect(finalizedPayloads).toEqual([]);
    expect(discard).toHaveBeenCalledExactlyOnceWith('artifact_payload');
    expect(archive).toHaveBeenCalledTimes(2);
  });

  it('checks cancellation between the payload and original even when the upload returns an id', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stopped before original', 'AbortError');
    const archive = vi.fn(async () => {
      controller.abort(reason);
      return 'artifact_payload';
    });
    const discard = vi.fn(async () => ({ deleted: true }));
    await expect(
      archiveImportedMesh({
        hold: { bytes: new Uint8Array([1, 2, 3]) },
        sourceName: 'scan.stl',
        original,
        archive,
        discard,
        signal: controller.signal
      })
    ).rejects.toBe(reason);
    expect(archive).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledExactlyOnceWith('artifact_payload');
  });

  it('archives a usable payload when the courtesy original cannot upload', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        if (input.kind === 'stl-import')
          throw new Error('original unavailable');
        return 'artifact_payload';
      }
    });
    expect(archived.artifactId).toBe('artifact_payload');
    expect(archived.payloadArchived).toBe(true);
    expect(archived.originalArchived).toBe(false);
  });

  it('does not return a committable archive when cancellation reaches a finalized payload', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stopped at finalization', 'AbortError');
    await expect(
      archiveImportedMesh({
        hold: { bytes: new Uint8Array([1, 2, 3]) },
        sourceName: 'scan.stl',
        original,
        archive: async (input) => {
          if (input.kind === 'mesh-payload') controller.abort(reason);
          return `artifact_${input.kind}`;
        },
        signal: controller.signal
      })
    ).rejects.toBe(reason);
  });

  it.each([false, true])(
    'reports failed cleanup and preserves cancellation (throw=%s)',
    async (throws) => {
      const controller = new AbortController();
      const reason = new DOMException('original cancelled', 'AbortError');
      const onCleanupFailure = vi.fn();
      const discard = vi.fn(async () => {
        if (throws) throw new Error('cleanup offline');
        return { deleted: false };
      });
      await expect(
        archiveImportedMesh({
          hold: { bytes: new Uint8Array([1]) },
          sourceName: 'scan.stl',
          original,
          archive: async (input) => {
            if (input.kind === 'mesh-payload') return 'artifact_payload';
            controller.abort(reason);
            throw reason;
          },
          discard,
          signal: controller.signal,
          onCleanupFailure
        })
      ).rejects.toBe(reason);
      expect(discard).toHaveBeenCalledExactlyOnceWith('artifact_payload');
      expect(onCleanupFailure).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error)
      );
    }
  );

  it('aborts the payload multipart session without finalizing a hidden artifact', async () => {
    const controller = new AbortController();
    const reason = new DOMException('payload upload stopped', 'AbortError');
    const transport: ArchiveArtifactTransport = {
      createUploadSession: vi.fn<
        ArchiveArtifactTransport['createUploadSession']
      >(async (input) => ({
        session: {
          uploadSessionId: toUploadSessionId(`upload_${input.kind}`),
          artifactId: toArtifactId(`artifact_${input.kind}`),
          projectId: input.projectId,
          objectKey: `objects/${input.kind}`,
          uploadUrl: `/api/uploads/upload_${input.kind}/content`,
          expiresAt: '2026-01-01T00:00:00.000Z',
          fileName: input.fileName,
          contentType: input.contentType,
          kind: input.kind,
          metadata: input.metadata ?? {}
        }
      })),
      uploadArtifact: vi.fn(async () => undefined),
      createMultipartUpload: vi.fn(async () => ({
        uploadId: 'multipart_mesh'
      })),
      uploadArtifactPart: vi.fn<ArchiveArtifactTransport['uploadArtifactPart']>(
        async (_session, _uploadId, partNumber) => {
          controller.abort(reason);
          return { partNumber, etag: `etag_${partNumber}` };
        }
      ),
      completeMultipartUpload: vi.fn(async () => undefined),
      abortMultipartUpload: vi.fn(async () => undefined),
      finalizeArtifact: vi.fn<ArchiveArtifactTransport['finalizeArtifact']>(
        async (input) => ({
          artifactId: input.artifactId
        })
      ),
      getArtifactMetadata: vi.fn(async () => ({ artifact: null }))
    };
    await expect(
      archiveImportedMesh({
        hold: { bytes: new Uint8Array(ARTIFACT_UPLOAD_PART_BYTES + 1) },
        sourceName: 'scan.stl',
        original,
        signal: controller.signal,
        archive: (input) =>
          archiveArtifact(transport, toProjectId('proj_mesh_upload'), input)
      })
    ).rejects.toBe(reason);
    expect(transport.uploadArtifactPart).toHaveBeenCalledOnce();
    expect(transport.abortMultipartUpload).toHaveBeenCalledWith(
      'upload_mesh-payload',
      'multipart_mesh',
      { projectId: 'proj_mesh_upload', payload: 'plaintext' }
    );
    expect(transport.completeMultipartUpload).not.toHaveBeenCalled();
    expect(transport.finalizeArtifact).not.toHaveBeenCalled();
    expect(transport.createUploadSession).toHaveBeenCalledOnce();
  });
});

describe(
  'backups of a project holding an imported mesh',
  { timeout: 60_000 },
  () => {
    it.each([25_000, 500_000])(
      'restores a backup with %i STL triangles',
      async (count) => {
        const parsed = parseStl(binaryStl(count), 'download.stl', true);
        const hold = await holdImportedMeshPayload({
          triangles: meshInDocumentUnits(parsed, 'mm'),
          marks: marks(),
          newId
        });
        const manager = new CommandManager(
          createProjectDocument('Mesh backup', user)
        );
        manager.execute(
          importedMeshCommand(parsed, hold.form, 'artifact_local_mesh')
        );
        const document: ProjectDocument = manager.document;
        await saveLocalProject(document);
        await hold.settle('committed', document);
        expect(documentStructureError(document)).toBeNull();

        const exported = await createProjectBackup(document, false);
        // Before references: "Project document holds more than 500000 values."
        const backup = await parseProjectBackup(exported);
        expect(backup.sources).toHaveLength(1);

        // The restored copy carries the payload into a fresh device's blob store,
        // and its triangles are the ones imported.
        globalThis.indexedDB = new IDBFactory();
        await saveImportedProject(backup);
        const ref = (
          hold.form as { meshPayloadRef: { checksumSha256: string } }
        ).meshPayloadRef;
        const restored = await loadSourceBlob(ref.checksumSha256);
        expect(restored).not.toBeNull();
        const decoded = decodeImportedMeshPayload(restored!);
        expect(decoded.vertices.length).toBe(parsed.vertices.length);
        expect(decoded.vertices[12_345]).toBe(parsed.vertices[12_345]);
        expect(decoded.indices.slice(0, 6)).toEqual(parsed.indices.slice(0, 6));
      }
    );

    it('refuses a backup whose mesh payload is missing', async () => {
      const hold = await holdImportedMeshPayload({
        triangles: {
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2]
        },
        marks: marks(),
        newId
      });
      const manager = new CommandManager(createProjectDocument('Torn', user));
      manager.execute(
        importedMeshCommand(
          { name: 'tri.stl', triangleCount: 1 },
          hold.form,
          'artifact_local_tri'
        )
      );
      await saveLocalProject(manager.document);
      const text = await createProjectBackup(manager.document, false);
      const torn = JSON.parse(text) as { sources: unknown[] };
      torn.sources = [];
      await expect(parseProjectBackup(JSON.stringify(torn))).rejects.toThrow(
        'Missing mesh data: tri.stl'
      );
    });
  }
);
