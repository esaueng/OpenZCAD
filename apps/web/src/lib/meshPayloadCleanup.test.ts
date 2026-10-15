import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  toArtifactId,
  toProjectId,
  toUploadSessionId,
  type ArtifactMetadataResponse,
  type ArtifactRecord,
  type UploadSessionRecord
} from '@openzcad/shared';
import {
  archiveArtifact,
  type ArchiveArtifactTransport
} from './archiveArtifact';
import {
  archiveImportedMesh,
  cleanupUncommittedMeshArchive
} from './importedMeshPayload';

const PROJECT = toProjectId('proj_mesh_origin');
const OTHER_PROJECT = toProjectId('proj_mesh_other');
const PAYLOAD_ID = toArtifactId('artifact_payload');
const ORIGINAL_ID = toArtifactId('artifact_original');

beforeEach(() => vi.stubGlobal('Blob', NodeBlob));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real archive helpers, with only the remote transport replaced. */
function fixture() {
  const sessions = new Map<string, UploadSessionRecord>();
  const finalized = new Map<string, ArtifactRecord>();
  const discard = vi.fn(
    async (
      projectId: string,
      artifactId: string,
      originalKind?: 'stl-import' | 'mesh-import'
    ) => {
      const stored = finalized.get(artifactId);
      if (
        stored?.projectId !== projectId ||
        stored.kind !== (originalKind ?? 'mesh-payload')
      ) {
        return { deleted: false };
      }
      finalized.delete(artifactId);
      return { deleted: true };
    }
  );
  const metadata = vi.fn<ArchiveArtifactTransport['getArtifactMetadata']>(
    async (artifactId) => ({ artifact: finalized.get(artifactId) ?? null })
  );
  const transport: ArchiveArtifactTransport = {
    createUploadSession: vi.fn<ArchiveArtifactTransport['createUploadSession']>(
      async (input) => {
        const artifactId =
          input.kind === 'mesh-payload' ? PAYLOAD_ID : ORIGINAL_ID;
        const session: UploadSessionRecord = {
          uploadSessionId: toUploadSessionId(`upload_${artifactId}`),
          artifactId,
          projectId: input.projectId,
          objectKey: `objects/${artifactId}`,
          uploadUrl: '/api/uploads/body',
          expiresAt: '2026-01-01T00:00:00.000Z',
          fileName: input.fileName,
          contentType: input.contentType,
          kind: input.kind,
          metadata: input.metadata ?? {}
        };
        sessions.set(session.uploadSessionId, session);
        return { session };
      }
    ),
    uploadArtifact: vi.fn(async () => undefined),
    createMultipartUpload: vi.fn(async () => ({ uploadId: 'multipart' })),
    uploadArtifactPart: vi.fn<ArchiveArtifactTransport['uploadArtifactPart']>(
      async (_session, _upload, partNumber) => ({
        partNumber,
        etag: `etag_${partNumber}`
      })
    ),
    completeMultipartUpload: vi.fn(async () => undefined),
    abortMultipartUpload: vi.fn(async () => undefined),
    finalizeArtifact: vi.fn<ArchiveArtifactTransport['finalizeArtifact']>(
      async (input) => {
        const session = sessions.get(input.uploadSessionId)!;
        finalized.set(input.artifactId, {
          artifactId: input.artifactId,
          projectId: input.projectId,
          kind: session.kind,
          name: session.fileName,
          objectKey: session.objectKey,
          contentType: session.contentType,
          bytes: 3,
          createdAt: '2026-01-01T00:00:00.000Z',
          metadata: session.metadata
        });
        return { artifactId: input.artifactId };
      }
    ),
    getArtifactMetadata: metadata,
    discardMeshPayload: discard
  };
  return { transport, metadata, discard, finalized };
}

const payloadInput = () => ({
  fileName: 'scan.stl.ozmesh',
  contentType: 'application/vnd.openzcad.mesh-payload',
  kind: 'mesh-payload' as const,
  body: new Blob([new Uint8Array([1, 2, 3])])
});

function importArchive(transport: ArchiveArtifactTransport) {
  return archiveImportedMesh({
    hold: { bytes: new Uint8Array([1, 2, 3]) },
    sourceName: 'scan.stl',
    original: {
      fileName: 'scan.stl',
      contentType: 'model/stl',
      kind: 'stl-import',
      body: new Blob(['solid scan'])
    },
    archive: (input) => archiveArtifact(transport, PROJECT, input),
    discard: (artifactId) => transport.discardMeshPayload!(PROJECT, artifactId)
  });
}

describe('a finalized mesh payload whose import cannot commit', () => {
  it('never commits an archive location whose finalized metadata is missing', async () => {
    const { transport, metadata, discard, finalized } = fixture();
    metadata.mockResolvedValueOnce({ artifact: null });
    await expect(
      archiveArtifact(transport, PROJECT, payloadInput())
    ).rejects.toThrow('The mesh archive could not be verified.');
    expect(discard).toHaveBeenCalledWith(PROJECT, PAYLOAD_ID);
    expect(finalized.has(PAYLOAD_ID)).toBe(false);
  });

  it('discards the captured project payload when cancellation lands during metadata lookup', async () => {
    const { transport, metadata, discard, finalized } = fixture();
    const pending = deferred<ArtifactMetadataResponse>();
    metadata.mockImplementationOnce(() => pending.promise);
    const controller = new AbortController();
    const reason = new DOMException('Import cancelled', 'AbortError');
    const stored = vi.fn();
    let openProject = PROJECT;
    const work = archiveArtifact(
      transport,
      openProject,
      { ...payloadInput(), signal: controller.signal },
      stored
    );
    const rejected = expect(work).rejects.toBe(reason);
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledOnce());
    expect(finalized.has(PAYLOAD_ID)).toBe(true);
    openProject = OTHER_PROJECT;
    controller.abort(reason);
    pending.resolve({ artifact: finalized.get(PAYLOAD_ID)! });
    await rejected;
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(PROJECT, PAYLOAD_ID);
    expect(discard).not.toHaveBeenCalledWith(openProject, PAYLOAD_ID);
    expect(finalized.has(PAYLOAD_ID)).toBe(false);
    expect(stored).not.toHaveBeenCalled();
  });

  it.each([
    ['stl-import', 'finalize'],
    ['stl-import', 'metadata'],
    ['mesh-import', 'finalize'],
    ['mesh-import', 'metadata']
  ] as const)(
    'removes both archives when the optional %s original is cancelled during %s',
    async (kind, stage) => {
      const { transport, metadata, discard, finalized } = fixture();
      const controller = new AbortController();
      const reason = new DOMException('Import cancelled', 'AbortError');
      const originalMetadata = deferred<ArtifactMetadataResponse>();
      const finalizedNormally = vi
        .mocked(transport.finalizeArtifact)
        .getMockImplementation()!;
      vi.mocked(transport.finalizeArtifact).mockImplementation(
        async (input) => {
          const result = await finalizedNormally(input);
          if (stage === 'finalize' && input.artifactId === ORIGINAL_ID)
            controller.abort(reason);
          return result;
        }
      );
      metadata.mockImplementation(async (artifactId) =>
        artifactId === ORIGINAL_ID && stage === 'metadata'
          ? originalMetadata.promise
          : { artifact: finalized.get(artifactId) ?? null }
      );
      const acknowledged = vi.fn();
      const work = archiveImportedMesh({
        hold: { bytes: new Uint8Array([1, 2, 3]) },
        sourceName: kind === 'stl-import' ? 'scan.stl' : 'scan.obj',
        original: {
          fileName: kind === 'stl-import' ? 'scan.stl' : 'scan.obj',
          contentType: 'text/plain',
          kind,
          body: new Blob(['mesh original'])
        },
        signal: controller.signal,
        archive: (input) =>
          archiveArtifact(transport, PROJECT, input, acknowledged),
        discard: (artifactId) =>
          transport.discardMeshPayload!(PROJECT, artifactId)
      });
      const rejected = expect(work).rejects.toBe(reason);
      if (stage === 'metadata') {
        await vi.waitFor(() =>
          expect(metadata).toHaveBeenCalledWith(ORIGINAL_ID)
        );
        expect(finalized.has(ORIGINAL_ID)).toBe(true);
        controller.abort(reason);
        originalMetadata.resolve({ artifact: finalized.get(ORIGINAL_ID)! });
      }
      await rejected;
      expect(finalized.has(PAYLOAD_ID)).toBe(false);
      expect(finalized.has(ORIGINAL_ID)).toBe(false);
      expect(discard).toHaveBeenCalledWith(PROJECT, PAYLOAD_ID);
      expect(discard).toHaveBeenCalledWith(PROJECT, ORIGINAL_ID, kind);
      expect(
        discard.mock.calls.every(([projectId]) => projectId === PROJECT)
      ).toBe(true);
      expect(acknowledged).not.toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: ORIGINAL_ID })
      );
    }
  );

  it.each([false, true])(
    'reports failed original compensation without replacing cancellation (throw=%s)',
    async (throws) => {
      const { transport, metadata, discard, finalized } = fixture();
      const normalDiscard = discard.getMockImplementation()!;
      discard.mockImplementation(
        async (projectId, artifactId, originalKind) => {
          if (artifactId === ORIGINAL_ID) {
            if (throws) throw new Error('Original cleanup unavailable');
            return { deleted: false };
          }
          return normalDiscard(projectId, artifactId, originalKind);
        }
      );
      const controller = new AbortController();
      const reason = new DOMException('Import cancelled', 'AbortError');
      metadata.mockImplementation(async (artifactId) => {
        if (artifactId === ORIGINAL_ID) controller.abort(reason);
        return { artifact: finalized.get(artifactId) ?? null };
      });
      const onCleanupFailure = vi.fn();
      await expect(
        archiveImportedMesh({
          hold: { bytes: new Uint8Array([1, 2, 3]) },
          sourceName: 'scan.stl',
          original: {
            fileName: 'scan.stl',
            contentType: 'model/stl',
            kind: 'stl-import',
            body: new Blob(['solid scan'])
          },
          signal: controller.signal,
          onCleanupFailure,
          archive: (input) => archiveArtifact(transport, PROJECT, input),
          discard: (artifactId) =>
            transport.discardMeshPayload!(PROJECT, artifactId)
        })
      ).rejects.toBe(reason);
      expect(discard).toHaveBeenCalledWith(PROJECT, ORIGINAL_ID, 'stl-import');
      expect(onCleanupFailure).toHaveBeenCalledOnce();
      expect(finalized.has(PAYLOAD_ID)).toBe(false);
      expect(finalized.has(ORIGINAL_ID)).toBe(true);
    }
  );

  it('retains an acknowledged original if its stored-file observer later throws', async () => {
    const { transport, discard, finalized } = fixture();
    await expect(
      archiveArtifact(
        transport,
        PROJECT,
        {
          fileName: 'scan.stl',
          contentType: 'model/stl',
          kind: 'stl-import',
          body: new Blob(['solid scan'])
        },
        () => {
          throw new Error('Stored-file observer failed');
        }
      )
    ).rejects.toThrow('Stored-file observer failed');
    expect(discard).not.toHaveBeenCalled();
    expect(finalized.has(ORIGINAL_ID)).toBe(true);
  });

  it('cleans a payload when a delayed commit refuses while keeping the original file', async () => {
    const { transport, discard, finalized } = fixture();
    const archived = await importArchive(transport);
    expect(
      vi
        .mocked(transport.finalizeArtifact)
        .mock.calls.map(([input]) => input.artifactId)
    ).toEqual([PAYLOAD_ID, ORIGINAL_ID]);
    const decision = deferred<boolean>();
    const cleanup = decision.promise.then((committed) =>
      cleanupUncommittedMeshArchive(archived, committed, (artifactId) =>
        discard(PROJECT, artifactId)
      )
    );
    expect(finalized.has(PAYLOAD_ID)).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    decision.resolve(false);
    await expect(cleanup).resolves.toBeNull();
    expect(discard).toHaveBeenCalledWith(PROJECT, PAYLOAD_ID);
    expect(finalized.has(PAYLOAD_ID)).toBe(false);
    expect(finalized.has(ORIGINAL_ID)).toBe(true);
  });

  it('never discards the payload of a committed import', async () => {
    const { transport, discard, finalized } = fixture();
    const archived = await importArchive(transport);
    await expect(
      cleanupUncommittedMeshArchive(archived, true, (artifactId) =>
        discard(PROJECT, artifactId)
      )
    ).resolves.toBeNull();
    expect(discard).not.toHaveBeenCalled();
    expect(finalized.has(PAYLOAD_ID)).toBe(true);
    expect(finalized.has(ORIGINAL_ID)).toBe(true);
  });

  it('preserves the primary archive error and reports a failed cleanup separately', async () => {
    const { transport, metadata, discard } = fixture();
    const primary = new Error('Payload metadata unavailable');
    const cleanupError = new Error('Cleanup unavailable');
    const onCleanupFailure = vi.fn();
    metadata.mockRejectedValueOnce(primary);
    discard.mockRejectedValueOnce(cleanupError);
    await expect(
      archiveArtifact(transport, PROJECT, {
        ...payloadInput(),
        onCleanupFailure
      })
    ).rejects.toBe(primary);
    expect(discard).toHaveBeenCalledWith(PROJECT, PAYLOAD_ID);
    expect(onCleanupFailure).toHaveBeenCalledWith(cleanupError);
  });

  it('preserves AbortError when cleanup fails after cancellation during metadata', async () => {
    const { transport, metadata, discard } = fixture();
    const pending = deferred<ArtifactMetadataResponse>();
    metadata.mockImplementationOnce(() => pending.promise);
    const controller = new AbortController();
    const reason = new DOMException('Import cancelled', 'AbortError');
    const cleanupError = new Error('Cleanup unavailable');
    const onCleanupFailure = vi.fn();
    discard.mockRejectedValueOnce(cleanupError);
    const work = archiveArtifact(transport, PROJECT, {
      ...payloadInput(),
      signal: controller.signal,
      onCleanupFailure
    });
    const rejected = expect(work).rejects.toBe(reason);
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledOnce());
    controller.abort(reason);
    pending.resolve({ artifact: null });
    await rejected;
    expect(onCleanupFailure).toHaveBeenCalledWith(cleanupError);
  });

  it('returns a cleanup failure without replacing the refused commit outcome', async () => {
    const { transport, discard, finalized } = fixture();
    const archived = await importArchive(transport);
    const cleanupError = new Error('Cleanup unavailable');
    discard.mockRejectedValueOnce(cleanupError);
    await expect(
      cleanupUncommittedMeshArchive(archived, false, (artifactId) =>
        discard(PROJECT, artifactId)
      )
    ).resolves.toBe(cleanupError);
    expect(finalized.has(PAYLOAD_ID)).toBe(true);
    expect(finalized.has(ORIGINAL_ID)).toBe(true);
  });

  it('reports a server refusal to discard as a cleanup failure', async () => {
    const { transport, discard } = fixture();
    const archived = await importArchive(transport);
    discard.mockResolvedValueOnce({ deleted: false });
    const result = await cleanupUncommittedMeshArchive(
      archived,
      false,
      (artifactId) => discard(PROJECT, artifactId)
    );
    expect(result).toBeInstanceOf(Error);
  });
});
