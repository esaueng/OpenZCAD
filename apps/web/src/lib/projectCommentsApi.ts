import type {
  CreateProjectCommentRequest,
  ListProjectCommentsResponse,
  ProjectComment
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import { projectRequest } from './projectWriteGate';
import { isEncryptedProject } from './api';
import { shareTokenHeaders } from './projectShareClient';

/**
 * L08 review comments for a plaintext project in the account. An encrypted
 * project's comments are refused here, before any request: they are not
 * offered until they can travel as encrypted records (ADR-024), so nothing
 * about them is sent in plaintext.
 */
export const ENCRYPTED_COMMENTS_UNAVAILABLE =
  'Comments are not available on encrypted projects yet.';

export class ProjectCommentsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ProjectCommentsError';
  }
}

async function request<T>(
  projectId: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (isEncryptedProject(projectId))
    throw new ProjectCommentsError(ENCRYPTED_COMMENTS_UNAVAILABLE, 0);
  const response = await desktopFetch(
    `/api/projects/${encodeURIComponent(projectId)}/comments${path}`,
    projectRequest(
      { projectId, payload: 'plaintext' },
      {
        ...init,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }
      }
    )
  );
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (!response.ok)
    throw new ProjectCommentsError(
      body?.error ?? 'Comments could not be reached.',
      response.status,
      body?.code
    );
  return body as T;
}

export const projectCommentsApi = {
  async list(projectId: string): Promise<ProjectComment[]> {
    return (await request<ListProjectCommentsResponse>(projectId, '')).comments;
  },
  async create(
    projectId: string,
    input: CreateProjectCommentRequest
  ): Promise<ProjectComment> {
    return (
      await request<{ comment: ProjectComment }>(projectId, '', {
        method: 'POST',
        body: JSON.stringify(input)
      })
    ).comment;
  },
  async resolve(
    projectId: string,
    commentId: string,
    resolved: boolean
  ): Promise<ProjectComment> {
    return (
      await request<{ comment: ProjectComment }>(projectId, `/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ resolved })
      })
    ).comment;
  },
  async remove(projectId: string, commentId: string): Promise<void> {
    await request<void>(projectId, `/${commentId}`, { method: 'DELETE' });
  }
};

async function linkRequest<T>(
  token: string,
  init: RequestInit = {}
): Promise<T> {
  // The token travels in its header, never the URL (share-link-token.ts).
  const response = await desktopFetch('/api/share/comments', {
    ...init,
    credentials: 'omit',
    headers: { 'content-type': 'application/json', ...shareTokenHeaders(token) }
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (!response.ok)
    throw new ProjectCommentsError(
      response.status === 404
        ? 'This link no longer takes comments.'
        : (body?.error ?? 'Comments could not be reached.'),
      response.status,
      body?.code
    );
  return body as T;
}

/**
 * L08 commenter links: a plaintext link's visitor, with no account, reads the
 * project's comments and writes their own, signed with the name they type.
 * An encrypted link never reaches here (its comments are slice 4).
 */
export const linkCommentsApi = {
  async list(token: string): Promise<ProjectComment[]> {
    return (await linkRequest<ListProjectCommentsResponse>(token)).comments;
  },
  async create(
    token: string,
    name: string,
    input: CreateProjectCommentRequest
  ): Promise<ProjectComment> {
    return (
      await linkRequest<{ comment: ProjectComment }>(token, {
        method: 'POST',
        body: JSON.stringify({ ...input, name })
      })
    ).comment;
  }
};
