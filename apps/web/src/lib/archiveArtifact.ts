import type {
  ArtifactKind,
  ArtifactMetadataResponse,
  ArtifactRecord,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  FinalizeArtifactRequest,
  ProjectId
} from '@openzcad/shared';
import { isEncryptedProject } from './api';
import {
  uploadArtifactBody,
  type ArtifactUploadTransport
} from './artifactUpload';

/** Just the artifact half of the API client, so a test can stand it up. */
export interface ArchiveArtifactTransport extends ArtifactUploadTransport {
  /**
   * An end-to-end encrypted project's file (ADR-024 Phase 4): encrypted
   * into a content blob whose id is the artifact id. Defaults to the
   * page's encrypted store for a project this page knows is encrypted.
   */
  archiveEncrypted?(
    projectId: ProjectId,
    input: ArchiveArtifactInput
  ): Promise<string>;
  createUploadSession(
    payload: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse>;
  finalizeArtifact(
    payload: FinalizeArtifactRequest
  ): Promise<{ artifactId: string | null }>;
  getArtifactMetadata(artifactId: string): Promise<ArtifactMetadataResponse>;
  discardMeshPayload?(
    projectId: ProjectId,
    artifactId: string,
    originalKind?: 'stl-import' | 'mesh-import'
  ): Promise<{ deleted: boolean }>;
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
  /** Cleanup cannot replace the failure that stopped the import. */
  onCleanupFailure?(error: unknown): void;
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
  if (transport.archiveEncrypted || isEncryptedProject(projectId)) {
    // Never through the plaintext routes, which would see the bytes. No
    // artifact record follows: an encrypted project lists no stored files,
    // and an unreferenced blob is collected, so nothing needs discarding.
    if (transport.archiveEncrypted) {
      return transport.archiveEncrypted(projectId, input);
    }
    const { archiveEncryptedArtifact } =
      await import('./e2ee/encryptedProjects');
    return archiveEncryptedArtifact(projectId, input);
  }
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
  let acknowledged = false;
  try {
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
    const finalized = await transport.finalizeArtifact({
      projectId,
      uploadSessionId: upload.uploadSessionId,
      artifactId: upload.artifactId
    });
    if (finalized.artifactId !== upload.artifactId) {
      throw new Error('The artifact could not be finalized.');
    }
    input.signal?.throwIfAborted();
    const stored = await transport.getArtifactMetadata(upload.artifactId);
    input.signal?.throwIfAborted();
    if (
      input.kind === 'mesh-payload' &&
      (!stored.artifact ||
        stored.artifact.artifactId !== upload.artifactId ||
        stored.artifact.projectId !== projectId ||
        stored.artifact.kind !== 'mesh-payload')
    ) {
      throw new Error('The mesh archive could not be verified.');
    }
    if (stored.artifact) {
      acknowledged = true;
      onArtifactStored?.(stored.artifact);
    }
    return upload.artifactId;
  } catch (error) {
    // The server may have finalized before a response or metadata lookup was
    // cancelled. Compensate using this upload's ID and its captured project,
    // without passing the already-aborted signal to cleanup.
    const originalKind =
      !acknowledged &&
      (input.kind === 'stl-import' || input.kind === 'mesh-import')
        ? input.kind
        : undefined;
    if (
      (input.kind === 'mesh-payload' || originalKind) &&
      transport.discardMeshPayload
    ) {
      try {
        const result = originalKind
          ? await transport.discardMeshPayload(
              projectId,
              upload.artifactId,
              originalKind
            )
          : await transport.discardMeshPayload(projectId, upload.artifactId);
        if (!result.deleted)
          throw new Error('Cloud mesh cleanup has not completed.', {
            cause: error
          });
      } catch (cleanupError) {
        try {
          input.onCleanupFailure?.(cleanupError);
        } catch {
          // An observer must not replace the failure that stopped the import.
        }
      }
    }
    throw error;
  }
}
