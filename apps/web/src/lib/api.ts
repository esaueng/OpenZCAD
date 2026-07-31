import type {
  AppSettingsResponse,
  AuthConfigResponse,
  AuthSession,
  ArtifactMetadataResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  DuplicateProjectResponse,
  FinalizeArtifactRequest,
  HealthResponse,
  ListProjectsResponse,
  ProjectDocument,
  ListArtifactsResponse,
  PurgeProjectsResponse,
  ReorderProjectsRequest,
  ReorderProjectsResponse,
  SaveAssistantCredentialRequest,
  SaveRevisionRequest,
  StartEmailLoginRequest,
  StartEmailLoginResponse,
  UpdateAppSettingsRequest,
  UpdateProjectRequest,
  UpdateProjectResponse,
  VerifyEmailLoginRequest
} from '@openzcad/shared';

/**
 * An API call that reached the server and came back refused. Callers need the
 * status to tell a rejected request apart from an unreachable backend: the
 * former is the user's problem to fix, the latter is what offline mode is for.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server rejected the request itself, e.g. failed validation. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

async function requestJson<T>(
  input: RequestInfo,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === 'string') {
        message = payload.error;
      }
    } catch {
      // Plain-text responses remain useful as-is.
    }
    throw new ApiError(
      response.status,
      message || `${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => requestJson<HealthResponse>('/api/health'),
  authConfig: () => requestJson<AuthConfigResponse>('/api/auth/config'),
  session: () => requestJson<AuthSession>('/api/session'),
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
    requestJson<{ ok: true; latencyMs: number }>(
      '/api/settings/assistant/test',
      { method: 'POST', body: '{}' }
    ),
  listProjects: () => requestJson<ListProjectsResponse>('/api/projects'),
  createProject: (payload: CreateProjectRequest) =>
    requestJson<CreateProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  loadProject: (projectId: string) =>
    requestJson<ProjectDocument>(`/api/projects/${projectId}`),
  duplicateProject: (projectId: string, name?: string) =>
    requestJson<DuplicateProjectResponse>(
      `/api/projects/${projectId}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify(name === undefined ? {} : { name })
      }
    ),
  updateProject: (payload: UpdateProjectRequest) =>
    requestJson<UpdateProjectResponse>(`/api/projects/${payload.projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  reorderProjects: (payload: ReorderProjectsRequest) =>
    requestJson<ReorderProjectsResponse>('/api/projects/reorder', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  /** Irreversible. Use `updateProject` with status 'deleted' for the bin. */
  deleteProject: async (projectId: string) => {
    const response = await fetch(`/api/projects/${projectId}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });
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
  saveRevision: (payload: SaveRevisionRequest) =>
    requestJson<ProjectDocument>(
      `/api/projects/${payload.projectId}/revisions`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    ),
  createUploadSession: (payload: CreateUploadSessionRequest) =>
    requestJson<CreateUploadSessionResponse>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  uploadArtifact: async (uploadUrl: string, body: Blob) => {
    const response = await fetch(uploadUrl, {
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
  finalizeArtifact: (payload: FinalizeArtifactRequest) =>
    requestJson<{ artifactId: string | null }>('/api/artifacts/finalize', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  listArtifacts: (projectId: string) =>
    requestJson<ListArtifactsResponse>(`/api/projects/${projectId}/artifacts`),
  getArtifactMetadata: (artifactId: string) =>
    requestJson<ArtifactMetadataResponse>(`/api/artifacts/${artifactId}`),
  artifactDownloadUrl: (artifactId: string) =>
    `/api/artifacts/${artifactId}/download`
};
