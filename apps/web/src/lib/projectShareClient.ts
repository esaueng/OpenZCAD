import type {
  CreateProjectShareLinkResponse,
  ListProjectShareLinksResponse,
  ProjectShareLinkMode,
  ProjectShareLinkSummary,
  SharedProjectResponse
} from '@openzcad/shared';
import {
  assertStorableDocument,
  UnstorableDocumentError
} from '@openzcad/document-core';
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
    mode: ProjectShareLinkMode,
    label?: string | null
  ): Promise<CreateProjectShareLinkResponse>;
  listProjectShareLinks(projectId: string): Promise<ProjectShareLinkSummary[]>;
  /** Names a link for its owner; null or blank clears the name. */
  renameProjectShareLink(
    projectId: string,
    shareLinkId: string,
    label: string | null
  ): Promise<ProjectShareLinkSummary>;
  revokeProjectShareLink(projectId: string, shareLinkId: string): Promise<void>;
  /** Anonymous fetch by token; unknown, revoked and expired links resolve to null. */
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
  return `${location.origin}/#share=${encodeURIComponent(token)}`;
}

/** Where a share-link visitor fetches one import-source asset from. */
export function sharedAssetUrl(token: string, assetId: string): string {
  return `/api/share/${routePart(token, 'Share token')}/assets/${routePart(
    assetId,
    'Asset ID'
  )}`;
}

/** Anonymous STEP source referenced by a shared project's feature history. */
export function sharedImportSourceUrl(
  token: string,
  artifactId: string
): string {
  return `/api/share/${routePart(token, 'Share token')}/sources/${routePart(
    artifactId,
    'Artifact ID'
  )}`;
}

/** Typed client for the owner share-link routes and the anonymous read. */
export function createProjectShareLinkClient(
  fetcher: typeof fetch = desktopFetch
): ProjectShareLinkClient {
  return {
    async createProjectShareLink(projectId, mode, label = null) {
      const response = await fetcher(
        `/api/projects/${routePart(projectId, 'Project ID')}/share-links`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(label === null ? { mode } : { mode, label })
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
    async renameProjectShareLink(projectId, shareLinkId, label) {
      const response = await fetcher(
        `/api/projects/${routePart(projectId, 'Project ID')}/share-links/${routePart(
          shareLinkId,
          'Share link ID'
        )}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label })
        }
      );
      if (!response.ok) {
        throw await responseError(response);
      }
      const payload = (await response.json()) as {
        shareLink: ProjectShareLinkSummary;
      };
      return payload.shareLink;
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
      const shared = (await response.json()) as SharedProjectResponse;
      // The account serves the shared model unread (ADR-024 Phase 1); the
      // visitor opens only a document this browser can open, and only as the
      // project the link names.
      const document = assertStorableDocument(shared.document);
      if (document.projectId !== shared.project.projectId)
        throw new UnstorableDocumentError(
          'The shared model belongs to a different project.'
        );
      return { ...shared, document };
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
