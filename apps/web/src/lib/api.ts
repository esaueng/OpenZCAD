import type {
  AuthSession,
  ArtifactMetadataResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  FinalizeArtifactRequest,
  HealthResponse,
  ListProjectsResponse,
  ProjectDocument,
  ListArtifactsResponse,
  SaveRevisionRequest
} from '@openzcad/shared';

async function requestJson<T>(
  input: RequestInfo,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => requestJson<HealthResponse>('/api/health'),
  session: () => requestJson<AuthSession>('/api/session'),
  listProjects: () => requestJson<ListProjectsResponse>('/api/projects'),
  createProject: (payload: CreateProjectRequest) =>
    requestJson<CreateProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  loadProject: (projectId: string) =>
    requestJson<ProjectDocument>(`/api/projects/${projectId}`),
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
      throw new Error((await response.text()) || `Upload failed (${response.status}).`);
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
