/**
 * Where the beta-only reverse path writes the plaintext it decrypts
 * (ADR-024 Phase 7, slice 7-3): the ordinary plaintext routes of the same
 * project id, through a fetcher that names the decrypt lease
 * (`withMigrationLease`). The Worker stores each write beside the
 * project's ciphertext, never in its project row, until the cutover.
 * Thin transport only; nothing here decrypts.
 */
import type {
  ArtifactKind,
  CompleteMultipartUploadRequest,
  CreateMultipartUploadResponse,
  CreateUploadSessionResponse,
  ProjectDocument,
  UploadedArtifactPart
} from '@openzcad/shared';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import { ApiError } from '../api';
import {
  uploadArtifactBody,
  type ArtifactUploadTransport
} from '../artifactUpload';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface StagedFileInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly kind: ArtifactKind;
  readonly body: Blob;
  readonly metadata?: Record<string, string | number | boolean>;
}

export interface MigrationPlaintextTarget {
  /** Stages one save state under its own revision id. */
  stageRevision(
    projectId: string,
    document: ProjectDocument,
    reason: string,
    revisionId: string
  ): Promise<void>;
  /** Stages the head, at the version it carries. */
  stageHead(projectId: string, document: ProjectDocument): Promise<void>;
  /** Uploads and finalizes one file; resolves to its artifact id. */
  stageFile(projectId: string, input: StagedFileInput): Promise<string>;
}

async function refusal(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let details: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    // A static host answers unknown routes with HTML.
  }
  return new ApiError(
    response.status,
    typeof details?.error === 'string'
      ? details.error
      : `${response.status} ${response.statusText}`,
    typeof details?.code === 'string' ? details.code : undefined,
    details
  );
}

export function createMigrationPlaintextTarget(
  leased: Fetch
): MigrationPlaintextTarget {
  const send = async (
    path: string,
    method: string,
    body?: unknown
  ): Promise<Response> => {
    const response = await leased(path, {
      method,
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
    });
    if (!response.ok) throw await refusal(response);
    return response;
  };
  const json = async <T>(path: string, method: string, body?: unknown) =>
    (await (await send(path, method, body)).json()) as T;
  const project = (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}`;
  const uploads: ArtifactUploadTransport = {
    async uploadArtifact(uploadUrl, body) {
      const response = await leased(uploadUrl, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': body.type || 'application/octet-stream' },
        body
      });
      if (!response.ok) throw await refusal(response);
    },
    createMultipartUpload: (uploadSessionId) =>
      json<CreateMultipartUploadResponse>(
        `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart`,
        'POST'
      ),
    async uploadArtifactPart(uploadSessionId, uploadId, partNumber, body) {
      const response = await leased(
        `/api/uploads/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body
        }
      );
      if (!response.ok) throw await refusal(response);
      return (await response.json()) as UploadedArtifactPart;
    },
    async completeMultipartUpload(
      uploadSessionId,
      payload: CompleteMultipartUploadRequest
    ) {
      await send(
        `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart/complete`,
        'POST',
        payload
      );
    },
    async abortMultipartUpload(uploadSessionId, uploadId) {
      await send(
        `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart?uploadId=${encodeURIComponent(uploadId)}`,
        'DELETE'
      );
    }
  };
  return {
    async stageRevision(projectId, document, reason, revisionId) {
      const split = await splitProjectStorageUpload(document);
      await send(`${project(projectId)}/revisions`, 'POST', {
        projectId,
        reason,
        expectedVersion: Math.max(0, document.version - 1),
        document: split.document,
        storageAssets: split.storageAssets,
        savedRevisionId: revisionId
      });
    },
    async stageHead(projectId, document) {
      const split = await splitProjectStorageUpload(document);
      await send(`${project(projectId)}/document`, 'PUT', {
        projectId,
        expectedVersion: Math.max(0, document.version - 1),
        document: split.document,
        storageAssets: split.storageAssets
      });
    },
    async stageFile(projectId, input) {
      const { session } = await json<CreateUploadSessionResponse>(
        '/api/uploads',
        'POST',
        {
          projectId,
          fileName: input.fileName,
          contentType: input.contentType,
          kind: input.kind,
          ...(input.metadata ? { metadata: input.metadata } : {})
        }
      );
      if (!session.uploadUrl) {
        throw new ApiError(503, 'File uploads are unavailable.');
      }
      await uploadArtifactBody(
        uploads,
        { uploadSessionId: session.uploadSessionId, uploadUrl: session.uploadUrl },
        input.body
      );
      const finalized = await json<{ artifactId: string | null }>(
        '/api/artifacts/finalize',
        'POST',
        {
          projectId,
          uploadSessionId: session.uploadSessionId,
          artifactId: session.artifactId
        }
      );
      if (finalized.artifactId !== session.artifactId) {
        throw new ApiError(409, 'The file could not be stored. Try again.');
      }
      return session.artifactId;
    }
  };
}
