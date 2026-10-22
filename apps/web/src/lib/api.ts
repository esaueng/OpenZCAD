import { isAnalyticsEnabled, trackDetail, trackSize, durationBucket } from './analytics';
import type {
  AccountStorageUsage,
  AccountDeletionPreview,
  AccountDeletionScope,
  AppSettingsResponse,
  AuthConfigResponse,
  AuthSession,
  ArtifactMetadataResponse,
  CompleteMultipartUploadRequest,
  CreateMultipartUploadResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  UploadedArtifactPart,
  DeleteAccountDataResponse,
  DuplicateProjectRequest,
  DuplicateProjectResponse,
  FinalizeArtifactRequest,
  HealthResponse,
  ListProjectsResponse,
  ListRevisionsResponse,
  ProjectCollaborationCapabilitiesResponse,
  ProjectDocument,
  ListArtifactsResponse,
  PurgeProjectsResponse,
  ReorderProjectsRequest,
  ReorderProjectsResponse,
  SaveAssistantCredentialRequest,
  SaveProjectDocumentRequest,
  SaveProjectDocumentResponse,
  SaveRevisionRequest,
  UserId,
  StartEmailLoginRequest,
  StartEmailLoginResponse,
  UpdateAppSettingsRequest,
  UpdateProjectRequest,
  UpdateProjectResponse,
  VerifyEmailLoginRequest
} from '@openzcad/shared';
import {
  adoptProjectDocument,
  createSavedRevision,
  normalizeDocument,
  normalizeDocumentHistory,
  reidentifyProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { createId, toProjectId } from '@openzcad/shared';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import { desktopFetch, isDesktopApp } from './desktopBridge';

/**
 * An API call that reached the server and came back refused. Callers need the
 * status to tell a rejected request apart from an unreachable backend: the
 * former is the user's problem to fix, the latter is what offline mode is for.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The machine-readable `code` the API sends alongside a refusal, when it
     * sends one. Statuses are too coarse for the sync paths: a 409 can mean
     * "already in your account" or "someone else edited this", and those want
     * opposite responses from the client.
     */
    readonly code?: string,
    /**
     * The rest of the refusal body. A fenced write reports the version the
     * account actually holds, and a size refusal reports the ceiling; both let
     * the client explain itself without a second round trip.
     */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server rejected the request itself, e.g. failed validation. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export const PROJECT_DOCUMENT_UNAVAILABLE_CODE = 'PROJECT_DOCUMENT_UNAVAILABLE';

export function isProjectDocumentUnavailableError(
  error: unknown
): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    error.code === PROJECT_DOCUMENT_UNAVAILABLE_CODE
  );
}

async function requestJson<T>(
  input: RequestInfo,
  init?: RequestInit,
  observations: { documentDownload?: boolean; expectedMissing?: boolean } = {}
): Promise<T> {
  const collect = isAnalyticsEnabled();
  const started = performance.now();
  // Use only a fixed operation class; never send the URL or embedded IDs.
  const projectCall = typeof input === 'string' && input.startsWith('/api/projects');
  const writing = !['GET','HEAD','OPTIONS'].includes(init?.method ?? 'GET');
  let response: Response;
  try {
    response = await desktopFetch(input, {
      ...init, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
    });
  } catch (error) {
    if (collect && projectCall) { trackDetail(writing ? 'error_cloud_save' : 'error_cloud_load'); trackDetail('cloud_status','network'); }
    throw error;
  }
  if (collect && projectCall) {
    if (!response.ok) {
      // Revision retention's documented null result is not a load failure.
      if (!(observations.expectedMissing && response.status === 404)) {
        trackDetail(writing ? 'error_cloud_save' : 'error_cloud_load');
        trackDetail('cloud_status', response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 409 ? 'conflict' : response.status === 413 ? 'too_large' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'server' : 'other');
      }
    } else if (writing && typeof init?.body === 'string') {
      trackSize('transfer_upload',new Blob([init.body]).size);
      const bucket=durationBucket(performance.now()-started); if(bucket)trackDetail('save_latency',bucket);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (typeof payload.error === 'string') {
        message = payload.error;
      }
      if (typeof payload.code === 'string') {
        code = payload.code;
      }
      details = payload;
    } catch {
      // Plain-text responses remain useful as-is.
    }
    throw new ApiError(
      response.status,
      message || `${response.status} ${response.statusText}`,
      code,
      details
    );
  }

  if (collect && observations.documentDownload && !writing) {
    // Read once and measure the successfully parsed UTF-8 JSON body. Content-
    // Length may describe compressed bytes or be absent; names/IDs stay local.
    const text = await response.text();
    const value = JSON.parse(text) as T;
    trackSize('transfer_download', new TextEncoder().encode(text).byteLength);
    return value;
  }
  return (await response.json()) as T;
}

/**
 * The request with `field`'s embedded import payloads split out into
 * `storageAssets` (ADR-024 Phase 1): the account stores the payloads under
 * their content-addressed keys and the projection as sent, without splitting
 * the document itself.
 */
async function withSplitStorage<T extends object, K extends keyof T & string>(
  request: T,
  field: K
): Promise<
  Omit<T, K> & Record<K, unknown> & Pick<SaveRevisionRequest, 'storageAssets'>
> {
  const split = await splitProjectStorageUpload(
    request[field] as ProjectDocument
  );
  return {
    ...request,
    [field]: split.document,
    storageAssets: split.storageAssets
  };
}

export const api = {
  health: () => requestJson<HealthResponse>('/api/health'),
  authConfig: () => requestJson<AuthConfigResponse>('/api/auth/config'),
  session: () => requestJson<AuthSession>('/api/session'),
  collaborationCapabilities: () =>
    requestJson<ProjectCollaborationCapabilitiesResponse>(
      '/api/collaboration/config'
    ),
  startEmailLogin: (payload: StartEmailLoginRequest) =>
    requestJson<StartEmailLoginResponse>('/api/auth/email/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  verifyEmailLogin: (payload: VerifyEmailLoginRequest) =>
    requestJson<AuthSession>('/api/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  approveDesktopLogin: (attemptId: string, userCode: string) =>
    requestJson<{ ok: true }>('/api/auth/desktop/approve', {
      method: 'POST',
      body: JSON.stringify({ attemptId, userCode })
    }),
  logout: () =>
    requestJson<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
      body: '{}'
    }),
  getSettings: () => requestJson<AppSettingsResponse>('/api/settings'),
  updateSettings: (payload: UpdateAppSettingsRequest) =>
    requestJson<AppSettingsResponse>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  saveAssistantCredential: (payload: SaveAssistantCredentialRequest) =>
    requestJson<AppSettingsResponse>('/api/settings/assistant-credential', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  deleteAssistantCredential: () =>
    requestJson<AppSettingsResponse>('/api/settings/assistant-credential', {
      method: 'DELETE'
    }),
  testAssistantConnection: () =>
    requestJson<{ ok: true; latencyMs: number; requestId: string }>(
      '/api/settings/assistant/test',
      { method: 'POST', body: '{}' }
    ),
  storageUsage: () => requestJson<AccountStorageUsage>('/api/account/storage'),
  accountDeletionPreview: (scope: AccountDeletionScope) =>
    requestJson<AccountDeletionPreview>(
      `/api/account/deletion-preview?scope=${encodeURIComponent(scope)}`
    ),
  deleteAccountData: (scope: AccountDeletionScope, confirmation: string) =>
    requestJson<DeleteAccountDataResponse>('/api/account/delete-data', {
      method: 'POST',
      body: JSON.stringify({ scope, confirmation })
    }),
  listProjects: () => requestJson<ListProjectsResponse>('/api/projects'),
  createProject: async (payload: CreateProjectRequest) =>
    requestJson<CreateProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(
        payload.initialDocument
          ? await withSplitStorage(payload, 'initialDocument')
          : payload
      )
    }),
  /**
   * Gives an existing device-local project an account record and its cloud identity.
   * The derived projection is dropped on the way out: it is rebuilt from
   * canonical history on load, and for a dense import it is most of the bytes.
   *
   * The browser re-homes the document itself (ADR-024 Phase 1): a fresh
   * `proj_<uuid>` id, the account as owner and the closing "Saved to account"
   * checkpoint. The device id travels beside it as the account's retry key,
   * with the archived import ids localization removed, so a discarded mesh
   * upload still refuses the adoption.
   */
  adoptProject: (
    document: ProjectDocument,
    ownerUserId: UserId,
    options: { sourceArtifactIds?: readonly string[] } = {}
  ) => {
    // Shelf saves read IndexedDB without opening the project. Upgrade that
    // snapshot before the Worker checks its schema, keeping undo/redo endpoints
    // consistent with any migrated nodes. Reloading alone never rewrites it.
    // An unreadable history is dropped by normalization; never re-attach it.
    const normalized = normalizeDocument(document);
    const prepared = normalized.editHistory
      ? normalizeDocumentHistory(document, normalized)
      : normalized;
    const send = async (): Promise<CreateProjectResponse> => {
      const adopted = adoptProjectDocument(
        reidentifyProjectDocument(prepared, toProjectId(createId('proj'))),
        ownerUserId,
        prepared.name
      );
      return requestJson<CreateProjectResponse>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(
          await withSplitStorage(
            {
              name: prepared.name,
              adoptionProtocolVersion: 2,
              localProjectId: prepared.projectId,
              ...(options.sourceArtifactIds?.length
                ? { sourceArtifactIds: options.sourceArtifactIds }
                : {}),
              document: withoutDerivedProjection(adopted)
            },
            'document'
          )
        )
      });
    };
    // A minted id that already names a project is a one-in-2^122 collision:
    // mint another once rather than failing the save.
    return send().catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'PROJECT_ID_TAKEN')
        return send();
      throw error;
    });
  },
  loadProject: (projectId: string) =>
    requestJson<ProjectDocument>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      undefined,
      { documentDownload: true }
    ),
  /**
   * Stores a copy of a project. With `revisionId`, the copy starts from that
   * stored save state and records where it came from; the source project is
   * untouched either way. With `document`, the browser built the copy (ADR-024
   * Phase 1) and lists the archived imports the account copies for it;
   * without, the account builds it (the pre-Phase 1 contract).
   */
  duplicateProject: async (
    projectId: string,
    options: Omit<DuplicateProjectRequest, 'projectId'> = {}
  ) => {
    const request = {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.revisionId === undefined
        ? {}
        : { revisionId: options.revisionId }),
      ...(options.document === undefined
        ? {}
        : {
            document: withoutDerivedProjection(options.document),
            documentDigest: options.documentDigest,
            importSources: options.importSources ?? []
          })
    };
    return requestJson<DuplicateProjectResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify(
          request.document
            ? await withSplitStorage(request, 'document')
            : request
        )
      }
    );
  },
  /** The project's retained save states, newest first, without documents. */
  listRevisions: (projectId: string) =>
    requestJson<ListRevisionsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/revisions`
    ),
  /**
   * One save state's document. Resolves to null when the account no longer
   * stores it, which retention makes an ordinary outcome rather than a fault.
   */
  loadRevision: async (projectId: string, revisionId: string) => {
    try {
      return await requestJson<ProjectDocument>(
        `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`,
        undefined,
        { documentDownload: true, expectedMissing: true }
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  },
  updateProject: (payload: UpdateProjectRequest, signal?: AbortSignal) =>
    requestJson<UpdateProjectResponse>(
      `/api/projects/${encodeURIComponent(payload.projectId)}`,
      {
        method: 'PATCH',
        ...(signal ? { signal } : {}),
        body: JSON.stringify(payload)
      }
    ),
  reorderProjects: (payload: ReorderProjectsRequest, signal?: AbortSignal) =>
    requestJson<ReorderProjectsResponse>('/api/projects/reorder', {
      method: 'POST',
      ...(signal ? { signal } : {}),
      body: JSON.stringify(payload)
    }),
  /** Irreversible. Use `updateProject` with status 'deleted' for the bin. */
  deleteProject: async (projectId: string) => {
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'DELETE',
        credentials: 'same-origin'
      }
    );
    if (!response.ok) {
      throw new ApiError(
        response.status,
        (await response.text()) || `Delete failed (${response.status}).`
      );
    }
  },
  purgeExpiredProjects: () =>
    requestJson<PurgeProjectsResponse>('/api/projects/purge', {
      method: 'POST',
      body: '{}'
    }),
  /**
   * A named save. The browser appends the save point — revision, checkpoint,
   * ids and times — and the account checks and stores the document as sent
   * (ADR-024 Phase 1). The reason is trimmed first because the server compares
   * the minted records with the trimmed reason it receives.
   */
  saveRevision: async (payload: SaveRevisionRequest) => {
    const reason = payload.reason.trim();
    const document =
      payload.savedRevisionId === undefined
        ? createSavedRevision(payload.document, reason)
        : payload.document;
    return requestJson<ProjectDocument>(
      `/api/projects/${encodeURIComponent(payload.projectId)}/revisions`,
      {
        method: 'POST',
        body: JSON.stringify(
          await withSplitStorage(
            {
              ...payload,
              reason,
              document,
              savedRevisionId:
                payload.savedRevisionId ?? document.revisions.at(-1)!.revisionId
            } satisfies SaveRevisionRequest,
            'document'
          )
        )
      }
    );
  },
  /**
   * The continuous-sync write. Same fencing as `saveRevision`, no history
   * entry, and only an acknowledgement comes back.
   *
   * `keepalive` is best-effort: browsers cap keepalive request bodies at
   * 64 KiB and reject larger ones outright, so it is applied only when the
   * body fits. An oversized document falls back to a plain fetch, which is
   * exactly the pre-keepalive behaviour.
   */
  saveProjectDocument: async (
    payload: SaveProjectDocumentRequest,
    options?: { keepalive?: boolean }
  ) => {
    const body = JSON.stringify(await withSplitStorage(payload, 'document'));
    return requestJson<SaveProjectDocumentResponse>(
      `/api/projects/${encodeURIComponent(payload.projectId)}/document`,
      {
        method: 'PUT',
        body,
        keepalive:
          options?.keepalive === true && new Blob([body]).size <= 60_000
      }
    );
  },
  createUploadSession: (payload: CreateUploadSessionRequest) =>
    requestJson<CreateUploadSessionResponse>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  uploadArtifact: async (uploadUrl: string, body: Blob) => {
    if (
      !isDesktopApp() &&
      new URL(uploadUrl, window.location.href).origin !== window.location.origin
    ) {
      throw new Error('Artifact upload URL must use the application origin.');
    }
    const response = await desktopFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': body.type || 'application/octet-stream' },
      body
    });
    if (!response.ok) {
      throw new Error(
        (await response.text()) || `Upload failed (${response.status}).`
      );
    }
  },
  createMultipartUpload: (uploadSessionId: string) =>
    requestJson<CreateMultipartUploadResponse>(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart`,
      { method: 'POST' }
    ),
  uploadArtifactPart: async (
    uploadSessionId: string,
    uploadId: string,
    partNumber: number,
    body: Blob
  ): Promise<UploadedArtifactPart> => {
    const response = await desktopFetch(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body
      }
    );
    if (!response.ok) {
      throw new Error(
        (await response.text()) ||
          `Upload part ${partNumber} failed (${response.status}).`
      );
    }
    return (await response.json()) as UploadedArtifactPart;
  },
  completeMultipartUpload: async (
    uploadSessionId: string,
    payload: CompleteMultipartUploadRequest
  ) => {
    const response = await desktopFetch(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      throw new Error(
        (await response.text()) ||
          `Completing the upload failed (${response.status}).`
      );
    }
  },
  abortMultipartUpload: async (uploadSessionId: string, uploadId: string) => {
    const response = await desktopFetch(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart?uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw new Error(
        (await response.text()) ||
          `Aborting the upload failed (${response.status}).`
      );
    }
  },
  finalizeArtifact: (payload: FinalizeArtifactRequest) =>
    requestJson<{ artifactId: string | null }>('/api/artifacts/finalize', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  discardMeshPayload: (
    projectId: string,
    artifactId: string,
    kind?: 'stl-import' | 'mesh-import' | 'reference-image'
  ) =>
    requestJson<{ deleted: boolean }>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/discard-unreferenced`,
      { method: 'POST', body: JSON.stringify({ projectId, kind }) }
    ),
  listArtifacts: (projectId: string) =>
    requestJson<ListArtifactsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/artifacts`
    ),
  getArtifactMetadata: (artifactId: string) =>
    requestJson<ArtifactMetadataResponse>(
      `/api/artifacts/${encodeURIComponent(artifactId)}`
    )
};
