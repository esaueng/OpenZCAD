import {
  encodeImportedMeshPayload,
  type ProjectDocument
} from '@openzcad/shared';

import {
  meshPayloadArchive,
  settleImportSource,
  type ImportRunResult,
  type InFlightImportChecksums
} from './importArchival';
import {
  meshInDocumentUnits,
  type DocumentUnitTriangles,
  type ImportedMeshPayloadForm,
  type MillimetreMesh
} from './importedMeshCommand';
import {
  deleteSourceBlobIfUnreferenced,
  ensureLocalProjectStorage,
  putSourceBlobIfAbsent,
  releaseSourceBlobClaim,
  type LocalStorageReadiness,
  type StoredSourceBlob
} from './localProjectStore';
import type { ValidatedFeatureOutcome } from '../hooks/useValidatedFeatureCommit';
import type { UnitSystem } from '@openzcad/shared';

// The workspace reaches the mesh command builders through this lazily loaded
// module, which keeps them out of the launcher chunk.
export {
  importedMeshCommand,
  meshInDocumentUnits
} from './importedMeshCommand';

/** What a mesh import needs from the device's local source-blob storage. */
export interface MeshPayloadStore {
  ensureLocalProjectStorage(): Promise<LocalStorageReadiness>;
  putSourceBlobIfAbsent(
    source: Uint8Array<ArrayBuffer>,
    options: { claimId: string }
  ): Promise<StoredSourceBlob>;
  deleteSourceBlobIfUnreferenced(input: {
    checksumSha256: string;
    claimId: string;
  }): Promise<boolean>;
  releaseSourceBlobClaim(
    checksumSha256: string,
    claimId: string
  ): Promise<void>;
}

/** The production wiring; a test supplies a fake. */
export const localMeshPayloadStore: MeshPayloadStore = {
  ensureLocalProjectStorage,
  putSourceBlobIfAbsent,
  deleteSourceBlobIfUnreferenced,
  releaseSourceBlobClaim
};

/** One mesh import's hold on the payload it is about to commit against. */
export interface MeshPayloadHold {
  /** The triangles as the command stores them. */
  form: ImportedMeshPayloadForm;
  /**
   * The encoded payload, for the archive that lets other devices resolve the
   * reference; null when the triangles are embedded.
   */
  bytes: Uint8Array<ArrayBuffer> | null;
  /**
   * Ends the hold once the import knows its fate, exactly as a STEP import
   * settles its source: kept for a commit, deleted for a refusal or a cancel
   * only when this import is what wrote the bytes. Never throws — a storage
   * failure here leaves the bytes, which is the no-data-loss direction.
   */
  settle(
    result: ImportRunResult,
    document: ProjectDocument | null
  ): Promise<boolean>;
}

/**
 * Stores a mesh import's triangles as one content-addressed payload, so the
 * feature, its `import.mesh` command and its undo entry carry a reference
 * instead of three copies of the mesh.
 *
 * Embedding is the fallback, as it is for STEP: when this browser has no
 * usable blob storage the triangles go into the document as they always did,
 * and the import still lands. The caller holds the commit lock, if it has
 * one, before calling — a run turned away afterwards must not leave bytes
 * behind (`settle` cleans up after every outcome).
 */
export async function holdImportedMeshPayload(deps: {
  triangles: DocumentUnitTriangles;
  marks: { inFlight: InFlightImportChecksums; abandoned: Set<string> };
  /** Unique per call. `crypto.randomUUID` in the app. */
  newId(): string;
  store?: MeshPayloadStore;
}): Promise<MeshPayloadHold> {
  const store = deps.store ?? localMeshPayloadStore;
  const embedded: MeshPayloadHold = {
    form: deps.triangles,
    bytes: null,
    settle: async () => false
  };
  let stored: StoredSourceBlob;
  let bytes: Uint8Array<ArrayBuffer>;
  const claimId = deps.newId();
  try {
    // A blocked schema upgrade or denied storage is not a refusal: the mesh
    // embeds, exactly as every mesh import did before references.
    if ((await store.ensureLocalProjectStorage()) !== 'ready') {
      return embedded;
    }
    bytes = encodeImportedMeshPayload(deps.triangles);
    stored = await store.putSourceBlobIfAbsent(bytes, { claimId });
  } catch {
    return embedded;
  }
  const checksumSha256 = stored.ref.checksumSha256;
  // Marked in the same tick the bytes become reachable, so a concurrent
  // import of the same mesh never sees a blob it could prune.
  deps.marks.inFlight.acquire(checksumSha256);
  let settled = false;
  return {
    form: { meshPayloadRef: stored.ref },
    bytes,
    async settle(result, document) {
      if (settled) return false;
      settled = true;
      deps.marks.inFlight.release(checksumSha256);
      return settleImportSource({
        checksumSha256,
        result,
        createdByThisImport: stored.created,
        abandonedChecksums: deps.marks.abandoned,
        document,
        inFlightChecksums: deps.marks.inFlight,
        deleteSourceBlobIfUnreferenced: (checksum) =>
          store.deleteSourceBlobIfUnreferenced({
            checksumSha256: checksum,
            claimId
          }),
        releaseSourceBlobClaim: () =>
          store.releaseSourceBlobClaim(checksumSha256, claimId)
      }).catch(() => false);
    }
  };
}

/**
 * {@link holdImportedMeshPayload} for a millimetre mesh joining a document in
 * `units` — the one way both mesh import paths store their triangles.
 */
export function holdMeshImport(
  mesh: MillimetreMesh,
  units: UnitSystem,
  marks: { inFlight: InFlightImportChecksums; abandoned: Set<string> }
): Promise<MeshPayloadHold> {
  return holdImportedMeshPayload({
    triangles: meshInDocumentUnits(mesh, units),
    marks,
    newId: () => crypto.randomUUID()
  });
}

/** A failure that is the user withdrawing, not storage failing. */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export interface ImportedMeshArchive {
  /** What the feature names: the payload's artifact, or the original's. */
  artifactId: string;
  /**
   * Whether another device can now resolve the reference. Null for an
   * embedded mesh, which carries its triangles with the document.
   */
  payloadArchived: boolean | null;
  /** Whether the file the user picked was stored with the project. */
  originalArchived: boolean;
  /**
   * How the import's status line ends: a full stop, or the archive it is
   * missing.
   */
  note: string;
}

/**
 * Archives what a mesh import's feature will point at, best-effort.
 *
 * A referenced mesh points its `artifactId` at the uploaded payload — the
 * bytes matching its checksum, which is what lets every other device, a share
 * link and a backup resolve it, just as a STEP import's artifact is its
 * source. The original file is still stored alongside as an ordinary stored
 * file. An embedded mesh points at the original, as it always has.
 *
 * A failed upload leaves a local id and the import still lands: the payload
 * stays in this device's blob store and is listed for a later archive. A
 * cancelled one is rethrown, so the run ends cancelled and nothing commits.
 */
export async function archiveImportedMesh(deps: {
  hold: Pick<MeshPayloadHold, 'bytes'>;
  sourceName: string;
  original: {
    fileName: string;
    contentType: string;
    kind: 'stl-import' | 'mesh-import';
    body: Blob;
  };
  archive(input: {
    fileName: string;
    contentType: string;
    kind: 'stl-import' | 'mesh-import' | 'mesh-payload';
    body: Blob;
    metadata: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<string>;
  /** Defaults to `crypto.randomUUID`. */
  newId?(): string;
  signal?: AbortSignal;
}): Promise<ImportedMeshArchive> {
  const { signal } = deps;
  const attempt = async (
    input: Parameters<typeof deps.archive>[0]
  ): Promise<string | null> => {
    try {
      return await deps.archive({ ...input, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return null;
    }
  };
  let payloadArtifactId: string | null = null;
  if (deps.hold.bytes) {
    const archive = meshPayloadArchive(deps.sourceName);
    payloadArtifactId = await attempt({
      ...archive,
      body: new Blob([deps.hold.bytes], { type: archive.contentType }),
      metadata: { source: 'direct-upload' }
    });
  }
  const originalArtifactId = await attempt({
    ...deps.original,
    metadata: { source: 'direct-upload' }
  });
  const localArtifactId = `artifact_local_${(deps.newId ?? (() => crypto.randomUUID()))()}`;
  const payloadArchived = deps.hold.bytes ? payloadArtifactId !== null : null;
  const originalArchived = originalArtifactId !== null;
  return {
    artifactId:
      (deps.hold.bytes ? payloadArtifactId : originalArtifactId) ??
      localArtifactId,
    payloadArchived,
    originalArchived,
    // The reference is what other devices need; the original is a courtesy.
    note:
      payloadArchived === false
        ? ' (cloud archive unavailable; mesh saved locally).'
        : originalArchived
          ? '.'
          : ' (original file not archived: upload unavailable).'
  };
}

/**
 * What a finished validated run means for its payload bytes — the same
 * mapping a STEP import applies to its source.
 */
export function meshImportRunResult(
  outcome: ValidatedFeatureOutcome | 'failed',
  cancelled: boolean
): ImportRunResult {
  if (outcome === 'committed') return 'committed';
  if (cancelled || outcome === 'cancelled') return 'cancelled';
  if (outcome === 'busy' || outcome === 'superseded') return 'no-verdict';
  return 'refused';
}
