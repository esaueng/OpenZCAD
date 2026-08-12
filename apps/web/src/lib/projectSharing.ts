import type {
  AcceptProjectInvitationResponse,
  CreateProjectInvitationResponse,
  ProjectMemberRole,
  ProjectSharingResponse,
  UserId
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';

export class ProjectSharingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'ProjectSharingApiError';
  }
}

export interface ProjectSharingClient {
  getProjectSharing(projectId: string): Promise<ProjectSharingResponse>;
  createInvitation(
    projectId: string,
    email: string,
    role: ProjectMemberRole
  ): Promise<CreateProjectInvitationResponse>;
  revokeInvitation(projectId: string, invitationId: string): Promise<void>;
  updateMemberRole(
    projectId: string,
    userId: UserId,
    role: ProjectMemberRole
  ): Promise<{ userId: UserId; role: ProjectMemberRole }>;
  removeMember(projectId: string, userId: UserId): Promise<void>;
  acceptInvitation(token: string): Promise<AcceptProjectInvitationResponse>;
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
  let message = `Project sharing request failed (${response.status}).`;
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

async function requestJson<T>(
  fetcher: typeof fetch,
  input: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetcher(input, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return (await response.json()) as T;
}

async function requestEmpty(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit
): Promise<void> {
  const response = await fetcher(input, {
    credentials: 'same-origin',
    ...init
  });
  if (!response.ok) {
    throw await responseError(response);
  }
}

/** Typed client for the already-shipped sharing/member/invitation routes. */
export function createProjectSharingClient(
  fetcher: typeof fetch = desktopFetch
): ProjectSharingClient {
  return {
    getProjectSharing(projectId) {
      return requestJson<ProjectSharingResponse>(
        fetcher,
        `/api/projects/${routePart(projectId, 'Project ID')}/sharing`
      );
    },
    createInvitation(projectId, email, role) {
      const normalizedEmail = email.trim();
      if (!normalizedEmail) {
        return Promise.reject(new Error('Invitation email is required.'));
      }
      return requestJson<CreateProjectInvitationResponse>(
        fetcher,
        `/api/projects/${routePart(projectId, 'Project ID')}/invitations`,
        {
          method: 'POST',
          body: JSON.stringify({ email: normalizedEmail, role })
        }
      );
    },
    revokeInvitation(projectId, invitationId) {
      return requestEmpty(
        fetcher,
        `/api/projects/${routePart(projectId, 'Project ID')}/invitations/${routePart(
          invitationId,
          'Invitation ID'
        )}`,
        { method: 'DELETE' }
      );
    },
    updateMemberRole(projectId, userId, role) {
      return requestJson<{ userId: UserId; role: ProjectMemberRole }>(
        fetcher,
        `/api/projects/${routePart(projectId, 'Project ID')}/members/${routePart(
          userId,
          'User ID'
        )}`,
        { method: 'PATCH', body: JSON.stringify({ role }) }
      );
    },
    removeMember(projectId, userId) {
      return requestEmpty(
        fetcher,
        `/api/projects/${routePart(projectId, 'Project ID')}/members/${routePart(
          userId,
          'User ID'
        )}`,
        { method: 'DELETE' }
      );
    },
    acceptInvitation(token) {
      const trimmed = token.trim();
      if (!trimmed) {
        return Promise.reject(new Error('Invitation token is required.'));
      }
      return requestJson<AcceptProjectInvitationResponse>(
        fetcher,
        '/api/project-invitations/accept',
        { method: 'POST', body: JSON.stringify({ token: trimmed }) }
      );
    }
  };
}
