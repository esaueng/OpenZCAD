/**
 * What the migration engine reads of a plaintext project (ADR-024 Phase 7,
 * slice 7-2): the ordinary plaintext routes, which keep answering reads
 * while the project is staged. Thin transport only; nothing here encrypts.
 */
import type {
  ArtifactMetadataResponse,
  ArtifactRecord,
  ListArtifactsResponse,
  ListProjectsResponse,
  ListRevisionsResponse,
  ProjectDocument,
  ProjectSummary,
  ProjectWorkspaceSession
} from '@openzcad/shared';
import { ApiError } from '../api';
import { desktopFetch } from '../desktopBridge';
import { LEGACY_PROJECT_FRAME_CONTENT_TYPE } from '@openzcad/shared';
import type { StoredMeasurementRecord } from '../measurementRecord';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PlaintextMeasurements {
  revision: number;
  record: StoredMeasurementRecord | null;
}

export interface MigrationPlaintextSource {
  /** The account's projects, as the shelf lists them. */
  listProjects(): Promise<ProjectSummary[]>;
  loadProject(projectId: string): Promise<ProjectDocument>;
  listRevisions(projectId: string): Promise<ListRevisionsResponse>;
  /** Null once retention dropped it. */
  loadRevision(
    projectId: string,
    revisionId: string
  ): Promise<ProjectDocument | null>;
  listArtifacts(projectId: string): Promise<ArtifactRecord[]>;
  artifact(artifactId: string): Promise<ArtifactRecord | null>;
  download(artifactId: string): Promise<Blob>;
  measurements(projectId: string): Promise<PlaintextMeasurements>;
  workspaceSessions(projectId: string): Promise<ProjectWorkspaceSession[]>;
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

export function createMigrationPlaintextSource(
  fetcher: Fetch = desktopFetch
): MigrationPlaintextSource {
  const get = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetcher(path, {
      ...init,
      credentials: 'same-origin'
    });
    if (!response.ok) throw await refusal(response);
    return response;
  };
  const json = async <T>(path: string): Promise<T> => {
    const response = await get(path);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(502, 'The project route answered garbage.');
    }
  };
  const project = (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}`;
  const document = async (
    path: string,
    projectId: string
  ): Promise<ProjectDocument> => {
    const response = await get(path, {
      headers: { accept: LEGACY_PROJECT_FRAME_CONTENT_TYPE }
    });
    if (
      response.headers.get('content-type')?.split(';')[0] ===
      LEGACY_PROJECT_FRAME_CONTENT_TYPE
    ) {
      const { readLegacyProjectFrame } = await import('../legacyProjectReader');
      return readLegacyProjectFrame(response, projectId, fetcher);
    }
    return response.json() as Promise<ProjectDocument>;
  };
  return {
    listProjects: async () =>
      (await json<ListProjectsResponse>('/api/projects')).projects,
    loadProject: (projectId) => document(project(projectId), projectId),
    listRevisions: (projectId) => json(`${project(projectId)}/revisions`),
    async loadRevision(projectId, revisionId) {
      try {
        return await document(
          `${project(projectId)}/revisions/${encodeURIComponent(revisionId)}`,
          projectId
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    listArtifacts: async (projectId) =>
      (await json<ListArtifactsResponse>(`${project(projectId)}/artifacts`))
        .artifacts,
    async artifact(artifactId) {
      try {
        return (
          await json<ArtifactMetadataResponse>(
            `/api/artifacts/${encodeURIComponent(artifactId)}`
          )
        ).artifact;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    download: async (artifactId) =>
      (
        await get(`/api/artifacts/${encodeURIComponent(artifactId)}/download`)
      ).blob(),
    measurements: (projectId) => json(`${project(projectId)}/measurements`),
    workspaceSessions: async (projectId) =>
      (
        await json<{ sessions: ProjectWorkspaceSession[] }>(
          `${project(projectId)}/workspace-sessions`
        )
      ).sessions
  };
}
