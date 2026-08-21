import type {
  CreateProjectShareLinkResponse,
  ListProjectShareLinksResponse,
  ProjectShareLinkMode,
  ProjectShareLinkSummary,
  SharedProjectResponse
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import { ProjectSharingApiError } from './projectSharing';

export type {
  CreateProjectShareLinkResponse,
  ListProjectShareLinksResponse,
  ProjectShareLinkMode,
  ProjectShareLinkSummary,
  SharedProjectResponse
};

export interface ProjectShareLinkClient {
  createProjectShareLink(
    projectId: string,
    mode: ProjectShareLinkMode
  ): Promise<CreateProjectShareLinkResponse>;
  listProjectShareLinks(projectId: string): Promise<ProjectShareLinkSummary[]>;
  revokeProjectShareLink(
    projectId: string,
    shareLinkId: string
  ): Promise<void>;
  /** Anonymous fetch by token; unknown and revoked links resolve to null. */
  fetchSharedProject(token: string): Promise<SharedProjectResponse | null>;
}

function routePart(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return encodeURIComponent(trimmed);
}

async function responseError(
  response: Response
): Promise<ProjectSharingApiError> {
  let message = `Project share link request failed (${response.status}).`;
  let code: string | null = null;
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      code?: unknown;
    };
    if (typeof payload.error === 'string' && payload.error.trim()) {
      message = payload.error;
    }
    if (typeof payload.code === 'string') {
      code = payload.code;
    }
  } catch {
    // Preserve the status-only fallback for non-JSON gateway failures.
  }
  return new ProjectSharingApiError(response.status, code, message);
}

/** The fragment form the workspace reads back out on load. */
export function buildShareLinkUrl(token: string): string {
  return `${location.origin}/#share=${token}`;
}

/** Where a share-link visitor fetches one import-source asset from. */
export function sharedAssetUrl(token: string, assetId: string): string {
  return `/api/share/${routePart(token, 'Share token')}/assets/${routePart(
    assetId,
    'Asset ID'
  )}`;
}

/** Typed client for the owner share-link routes and the anonymous read. */
export function createProjectShareLinkClient(
  fetcher: typeof fetch = desktopFetch
): ProjectShareLinkClient {
  return {
    async createProjectShareLink(projectId, mode) {
      const response = await fetcher(
        `/api/projects/${routePart(projectId, 'Project ID')}/share-links`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode })
        }
      );
      if (!response.ok) {
        throw await responseError(response);
      }
      return (await response.json()) as CreateProjectShareLinkResponse;
    },
    async listProjectShareLinks(projectId) {
      const response = await fetcher(
        `/api/projects/${routePart(projectId, 'Project ID')}/share-links`,
        { credentials: 'same-origin' }
      );
      if (!response.ok) {
        throw await responseError(response);
      }
      const payload = (await response.json()) as ListProjectShareLinksResponse;
      return payload.shareLinks;
    },
    async revokeProjectShareLink(projectId, shareLinkId) {
      const response = await fetcher(
        `/api/projects/${routePart(projectId, 'Project ID')}/share-links/${routePart(
          shareLinkId,
          'Share link ID'
        )}`,
        { method: 'DELETE', credentials: 'same-origin' }
      );
      if (!response.ok) {
        throw await responseError(response);
      }
    },
    async fetchSharedProject(token) {
      const response = await fetcher(
        `/api/share/${routePart(token, 'Share token')}`,
        // Visitors have no session; never send one that might exist.
        { credentials: 'omit' }
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw await responseError(response);
      }
      return (await response.json()) as SharedProjectResponse;
    }
  };
}

const defaultClient = createProjectShareLinkClient();

export function createProjectShareLink(
  projectId: string,
  mode: ProjectShareLinkMode
): Promise<CreateProjectShareLinkResponse> {
  return defaultClient.createProjectShareLink(projectId, mode);
}

export function listProjectShareLinks(
  projectId: string
): Promise<ProjectShareLinkSummary[]> {
  return defaultClient.listProjectShareLinks(projectId);
}

export function revokeProjectShareLink(
  projectId: string,
  shareLinkId: string
): Promise<void> {
  return defaultClient.revokeProjectShareLink(projectId, shareLinkId);
}

export function fetchSharedProject(
  token: string
): Promise<SharedProjectResponse | null> {
  return defaultClient.fetchSharedProject(token);
}
