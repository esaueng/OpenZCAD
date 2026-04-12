import type {
  ArtifactMetadataResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  FinalizeImportRequest,
  HealthResponse,
  ListProjectsResponse,
  ProjectDocument,
  RequestExportRequest,
  RequestExportResponse,
  SaveRevisionRequest
} from '@openzcad/shared';

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
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
  listProjects: () => requestJson<ListProjectsResponse>('/api/projects'),
  createProject: (payload: CreateProjectRequest) =>
    requestJson<CreateProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  loadProject: (projectId: string) =>
    requestJson<ProjectDocument>(`/api/projects/${projectId}`),
  saveRevision: (payload: SaveRevisionRequest) =>
    requestJson<ProjectDocument>(`/api/projects/${payload.projectId}/revisions`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  createUploadSession: (payload: CreateUploadSessionRequest) =>
    requestJson<CreateUploadSessionResponse>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  finalizeImport: (payload: FinalizeImportRequest) =>
    requestJson<{ artifactId: string | null }>('/api/imports/finalize', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  requestExport: (payload: RequestExportRequest) =>
    requestJson<RequestExportResponse>('/api/exports', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getArtifactMetadata: (artifactId: string) =>
    requestJson<ArtifactMetadataResponse>(`/api/artifacts/${artifactId}`)
};

