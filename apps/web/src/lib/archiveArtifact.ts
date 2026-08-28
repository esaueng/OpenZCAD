import type {
  ArtifactKind,
  ArtifactMetadataResponse,
  ArtifactRecord,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  FinalizeArtifactRequest,
  ProjectId
} from '@openzcad/shared';
import {
  uploadArtifactBody,
  type ArtifactUploadTransport
} from './artifactUpload';

/** Just the artifact half of the API client, so a test can stand it up. */
export interface ArchiveArtifactTransport extends ArtifactUploadTransport {
  createUploadSession(
    payload: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse>;
  finalizeArtifact(
    payload: FinalizeArtifactRequest
  ): Promise<{ artifactId: string | null }>;
  getArtifactMetadata(artifactId: string): Promise<ArtifactMetadataResponse>;
}

export interface ArchiveArtifactInput {
  fileName: string;
  contentType: string;
  kind: ArtifactKind;
  body: Blob;
  metadata?: Record<string, string | number | boolean>;
  /** Bytes the store has accepted, for a caller reporting the upload. */
  onUploadProgress?(uploaded: number, total: number): void;
  /**
   * Stops the upload.
   *
   * `runStepImport` has always passed one; the app's own implementation of
   * this call simply did not declare it, so the property was dropped on the
   * way in without a type error. Archiving is the longest phase of an import,
   * the only one with a byte-accurate progress bar, and therefore the one a
   * user actually reaches for cancel during — and the transfer ran to
   * completion and finalized an artifact into the File menu after the card
   * had already said the import was cancelled.
   */
  signal?: AbortSignal;
}

/**
 * Uploads one artifact body and returns the finalized artifact id.
 *
 * The two abort checks bracket the transfer for different reasons. The first
 * avoids opening an upload session for a run that is already cancelled. The
 * second is the one that matters: an unfinalized session is swept by the
 * worker's expiry sweep, whereas a finalized artifact is permanent and listed
 * in the File menu — and a cancelled import prunes its local source, so
 * nothing is left that could ever re-reference it.
 */
export async function archiveArtifact(
  transport: ArchiveArtifactTransport,
  projectId: ProjectId,
  input: ArchiveArtifactInput,
  onArtifactStored?: (artifact: ArtifactRecord) => void
): Promise<string> {
  input.signal?.throwIfAborted();
  const { session: upload } = await transport.createUploadSession({
    projectId,
    fileName: input.fileName,
    contentType: input.contentType,
    kind: input.kind,
    ...(input.metadata ? { metadata: input.metadata } : {})
  });
  if (!upload.uploadUrl) {
    throw new Error('Artifact upload is unavailable.');
  }
  // Chunked above the part size, single PUT below; retries each part and
  // aborts the multipart state if the upload cannot finish.
  await uploadArtifactBody(
    transport,
    { uploadSessionId: upload.uploadSessionId, uploadUrl: upload.uploadUrl },
    input.body,
    {
      ...(input.onUploadProgress
        ? { onProgress: input.onUploadProgress }
        : {}),
      ...(input.signal ? { signal: input.signal } : {})
    }
  );
  input.signal?.throwIfAborted();
  await transport.finalizeArtifact({
    projectId,
    uploadSessionId: upload.uploadSessionId,
    artifactId: upload.artifactId
  });
  const stored = await transport.getArtifactMetadata(upload.artifactId);
  if (stored.artifact) {
    onArtifactStored?.(stored.artifact);
  }
  return upload.artifactId;
}
