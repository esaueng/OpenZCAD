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
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';
import { ArtifactStorageError, type PersistenceService } from './index';

/** The source resolver and exact readers already refuse larger imports. */
const MAX_IMPORT_SOURCE_BYTES = 128 * 1024 * 1024;

export interface ImportCopyDigest {
  update(bytes: Uint8Array): void;
  digest(): string;
}

/**
 * Archive a copied project's referenced import bytes under independent keys.
 * All writes use the ordinary upload reservations, quotas and finalization.
 * Only a verified payload is finalized; the caller removes its new project
 * on failure, including unfinished uploads. Buffering is bounded by one part.
 */
export async function copyImportedSources(
  service: PersistenceService,
  userId: UserId,
  source: ProjectDocument,
  copy: ProjectDocument,
  createDigest?: () => ImportCopyDigest,
  onVerifiedArchive?: (archive: CopiedImportArchive) => Promise<void>
): Promise<ProjectDocument> {
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
  const copied = new Set<string>();
  for (const node of documentNodesWithHistory(copy)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    const key = ref
      ? `${node.data.featureKind}:${ref.checksumSha256}:${ref.logicalBytes}`
      : '';
    if (!ref || copied.has(key)) continue;
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
    // Authorization is checked by the source artifact's actual project, before
    // its body is read. Membership in the destination grants no source access.
    const download = await service.downloadArtifact(userId, artifactId);
    const kind =
      node.data.featureKind === 'imported-mesh'
        ? 'mesh-payload'
        : 'step-import';
    if (
      !download ||
      download.artifact.kind !== kind ||
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
        projectId: copy.projectId,
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
        projectId: copy.projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      });
      if (!artifact || artifact.projectId !== copy.projectId)
        throw new ArtifactStorageError(
          'The copied import source could not be finalized.'
        );
      const archive: CopiedImportArchive = {
        projectId: copy.projectId,
        checksumSha256: ref.checksumSha256,
        logicalBytes: ref.logicalBytes,
        kind,
        artifactId: artifact.artifactId
      };
      // Only this independently hashed path establishes durable aliases.
      // Ordinary upload metadata never grants this trust.
      await onVerifiedArchive?.(archive);
      copy = reconcileCopiedImportSources(copy, [archive]);
      copied.add(key);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return copy;
}
