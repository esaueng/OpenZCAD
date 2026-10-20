import {
  reconcileCopiedImportSources,
  type CopiedImportArchive
} from './copied-source-reconciliation';
import {
  ARTIFACT_UPLOAD_PART_BYTES,
  documentNodesWithHistory,
  importedSourceReferenceOf,
  isImportedSourceReference,
  type FeatureNode,
  type ImportSourceCopyRef,
  type ProjectDocument,
  type ProjectId,
  type UserId
} from '@openzcad/shared';
import { ArtifactStorageError, type PersistenceService } from './index';
import { SavePointRequestError } from './client-save-point';

/** The source resolver and exact readers already refuse larger imports. */
const MAX_IMPORT_SOURCE_BYTES = 128 * 1024 * 1024;

/** Bound on one copy request's source list; far above any real project. */
export const MAX_IMPORT_SOURCE_COPY_REFS = 1_000;

export type { ImportSourceCopyRef };

export interface ImportCopyDigest {
  update(bytes: Uint8Array): void;
  digest(): string;
}

const refKey = (
  ref: Pick<ImportSourceCopyRef, 'kind' | 'checksumSha256' | 'logicalBytes'>
) => `${ref.kind}:${ref.checksumSha256}:${ref.logicalBytes}`;

/** Whether `value` is a well-formed {@link ImportSourceCopyRef}. */
export function isImportSourceCopyRef(
  value: unknown
): value is ImportSourceCopyRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const ref = value as Record<string, unknown>;
  return (
    Object.keys(ref).every((key) =>
      ['artifactId', 'kind', 'checksumSha256', 'logicalBytes'].includes(key)
    ) &&
    typeof ref.artifactId === 'string' &&
    ref.artifactId.length > 0 &&
    ref.artifactId.length <= 200 &&
    !ref.artifactId.startsWith('artifact_local_') &&
    (ref.kind === 'step-import' || ref.kind === 'mesh-payload') &&
    typeof ref.checksumSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(ref.checksumSha256) &&
    Number.isSafeInteger(ref.logicalBytes) &&
    (ref.logicalBytes as number) >= 1 &&
    (ref.logicalBytes as number) <= MAX_IMPORT_SOURCE_BYTES
  );
}

/** Every source the copy or its undo/redo history needs must be archived. */
export function assertImportSourceCopyRefsComplete(
  document: ProjectDocument,
  refs: readonly ImportSourceCopyRef[]
): void {
  if (
    refs.length > MAX_IMPORT_SOURCE_COPY_REFS ||
    !refs.every(isImportSourceCopyRef)
  ) {
    throw new SavePointRequestError(
      'The copy import source list is malformed.'
    );
  }
  const listed = new Set(refs.map(refKey));
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) continue;
    const kind =
      node.data.featureKind === 'imported-mesh'
        ? 'mesh-payload'
        : 'step-import';
    if (!listed.has(refKey({ ...ref, kind }))) {
      throw new SavePointRequestError(
        'The copy source list does not cover every imported source.'
      );
    }
  }
}

/**
 * The archived sources `copy` references, resolved against the `source` it
 * was copied from. Pure, so the browser that builds a copy runs it and sends
 * the list; each content identity appears once.
 */
export function importSourceCopyRefs(
  source: ProjectDocument,
  copy: ProjectDocument
): ImportSourceCopyRef[] {
  const originals = new Map<string, FeatureNode>();
  for (const node of documentNodesWithHistory(source)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) continue;
    const artifactId = (node.data as { artifactId: string }).artifactId;
    const key = `${node.data.featureKind}:${ref.checksumSha256}:${ref.logicalBytes}`;
    if (!originals.has(key) || !artifactId.startsWith('artifact_local_'))
      originals.set(key, node);
  }
  const refs = new Map<string, ImportSourceCopyRef>();
  for (const node of documentNodesWithHistory(copy)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) continue;
    const key = `${node.data.featureKind}:${ref.checksumSha256}:${ref.logicalBytes}`;
    const kind =
      node.data.featureKind === 'imported-mesh'
        ? 'mesh-payload'
        : 'step-import';
    if (refs.has(refKey({ ...ref, kind }))) continue;
    if (
      !isImportedSourceReference(ref) ||
      ref.logicalBytes < 1 ||
      ref.logicalBytes > MAX_IMPORT_SOURCE_BYTES
    )
      throw new ArtifactStorageError('The imported source cannot be copied.');
    const original = originals.get(key);
    const artifactId = (original?.data as { artifactId?: string })?.artifactId;
    if (!artifactId || artifactId.startsWith('artifact_local_'))
      throw new ArtifactStorageError(
        'Archive local import sources before duplicating this project.'
      );
    refs.set(refKey({ ...ref, kind }), {
      artifactId,
      kind,
      checksumSha256: ref.checksumSha256,
      logicalBytes: ref.logicalBytes
    });
  }
  return [...refs.values()];
}

/**
 * Archive a copied project's referenced import bytes under independent keys,
 * resolving the sources from the documents. Kept for the server-built copy
 * path, which a pre-Phase 1 client still takes for one release.
 */
export async function copyImportedSources(
  service: PersistenceService,
  userId: UserId,
  source: ProjectDocument,
  copy: ProjectDocument,
  createDigest?: () => ImportCopyDigest,
  onVerifiedArchive?: (archive: CopiedImportArchive) => Promise<void>
): Promise<ProjectDocument> {
  const archives = await copyImportSourceArtifacts(
    service,
    userId,
    copy.projectId,
    importSourceCopyRefs(source, copy),
    createDigest,
    onVerifiedArchive
  );
  return reconcileCopiedImportSources(copy, archives);
}

/**
 * Archive the listed import bytes under the copy's own keys, without reading
 * either document. Every byte is re-hashed against the listed identity before
 * finalizing, so a wrong list can only fail the copy. All writes use the ordinary upload reservations, quotas and finalization.
 * Only a verified payload is finalized; the caller removes its new project
 * on failure, including unfinished uploads. Buffering is bounded by one part.
 */
export async function copyImportSourceArtifacts(
  service: PersistenceService,
  userId: UserId,
  copyProjectId: ProjectId,
  refs: readonly ImportSourceCopyRef[],
  createDigest?: () => ImportCopyDigest,
  onVerifiedArchive?: (archive: CopiedImportArchive) => Promise<void>,
  sourceProjectId?: ProjectId
): Promise<CopiedImportArchive[]> {
  if (refs.length > MAX_IMPORT_SOURCE_COPY_REFS)
    throw new ArtifactStorageError('The project has too many import sources.');
  const archives: CopiedImportArchive[] = [];
  const copied = new Set<string>();
  for (const ref of refs) {
    const key = refKey(ref);
    if (copied.has(key)) continue;
    if (!isImportSourceCopyRef(ref))
      throw new ArtifactStorageError('The imported source cannot be copied.');
    const { artifactId, kind } = ref;
    // Authorization is checked by the source artifact's actual project, before
    // its body is read. Membership in the destination grants no source access.
    const download = await service.downloadArtifact(userId, artifactId);
    if (
      !download ||
      download.artifact.kind !== kind ||
      // A browser-listed source must come from the project being copied.
      (sourceProjectId !== undefined &&
        download.artifact.projectId !== sourceProjectId) ||
      (download.artifact.bytes !== undefined &&
        download.artifact.bytes !== ref.logicalBytes)
    )
      throw new ArtifactStorageError(
        'The imported source is missing or damaged.'
      );
    const reader = new Response(download.body).body!.getReader();
    try {
      const hash = createDigest?.();
      // The in-memory service owns complete ArrayBuffers. Streaming backends
      // supply their incremental digest without putting server APIs in browser code.
      if (!hash && !(download.body instanceof ArrayBuffer))
        throw new ArtifactStorageError(
          'The import copy requires a streaming checksum.'
        );
      const bufferedDigest = hash
        ? null
        : Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                download.body as ArrayBuffer
              )
            ),
            (byte) => byte.toString(16).padStart(2, '0')
          ).join('');
      const { session } = await service.createUploadSession(userId, {
        projectId: copyProjectId,
        fileName: download.artifact.name,
        contentType: download.artifact.contentType,
        kind,
        metadata: {
          source: 'project-copy',
          checksumSha256: ref.checksumSha256,
          logicalBytes: ref.logicalBytes
        }
      });
      const { uploadId } = await service.createMultipartUpload(
        userId,
        session.uploadSessionId
      );
      const buffer = new Uint8Array(
        Math.min(ARTIFACT_UPLOAD_PART_BYTES, ref.logicalBytes)
      );
      const parts: { partNumber: number; etag: string }[] = [];
      let buffered = 0;
      let total = 0;
      const flush = async () => {
        if (!buffered) return;
        const part = await service.putUploadPart(
          userId,
          session.uploadSessionId,
          uploadId,
          parts.length + 1,
          buffer.buffer.slice(0, buffered)
        );
        parts.push(part);
        buffered = 0;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > ref.logicalBytes)
          throw new ArtifactStorageError(
            'The imported source is missing or damaged.'
          );
        hash?.update(value);
        for (let offset = 0; offset < value.length;) {
          const count = Math.min(
            buffer.length - buffered,
            value.length - offset
          );
          buffer.set(value.subarray(offset, offset + count), buffered);
          buffered += count;
          offset += count;
          if (buffered === buffer.length) await flush();
        }
      }
      if (
        total !== ref.logicalBytes ||
        (hash?.digest() ?? bufferedDigest) !== ref.checksumSha256
      )
        throw new ArtifactStorageError(
          'The imported source is missing or damaged.'
        );
      await flush();
      await service.completeMultipartUpload(userId, session.uploadSessionId, {
        uploadId,
        parts
      });
      const artifact = await service.finalizeArtifact(userId, {
        projectId: copyProjectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      });
      if (!artifact || artifact.projectId !== copyProjectId)
        throw new ArtifactStorageError(
          'The copied import source could not be finalized.'
        );
      const archive: CopiedImportArchive = {
        projectId: copyProjectId,
        checksumSha256: ref.checksumSha256,
        logicalBytes: ref.logicalBytes,
        kind,
        artifactId: artifact.artifactId
      };
      // Only this independently hashed path establishes durable aliases.
      // Ordinary upload metadata never grants this trust.
      await onVerifiedArchive?.(archive);
      archives.push(archive);
      copied.add(key);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return archives;
}
