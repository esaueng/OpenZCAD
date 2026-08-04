import type {
  CreateProjectInvitationResponse,
  ProjectMemberRole,
  UserId
} from '@openzcad/shared';
import type { PersistenceService } from '@openzcad/persistence';
import { normalizeEmail } from './auth';

export const PROJECT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createProjectInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashProjectInvitationToken(
  token: string
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export function parseProjectMemberRole(value: unknown): ProjectMemberRole {
  if (value !== 'editor' && value !== 'viewer') {
    throw new SharingRequestError(
      400,
      'SHARING_ROLE_INVALID',
      'Project role must be editor or viewer.'
    );
  }
  return value;
}

export function parseCreateInvitation(value: unknown): {
  email: string;
  role: ProjectMemberRole;
} {
  const record = asRecord(value);
  return {
    email: normalizeEmail(record.email),
    role: parseProjectMemberRole(record.role)
  };
}

export function parseInvitationAcceptance(value: unknown): string {
  const token = asRecord(value).token;
  if (
    typeof token !== 'string' ||
    token.length < 40 ||
    token.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new SharingRequestError(
      400,
      'INVITATION_TOKEN_INVALID',
      'Project invitation token is invalid.'
    );
  }
  return token;
}

export async function createInvitation(
  persistence: PersistenceService,
  ownerUserId: UserId,
  projectId: string,
  value: unknown,
  now = Math.floor(Date.now() / 1000)
): Promise<CreateProjectInvitationResponse> {
  const request = parseCreateInvitation(value);
  const token = createProjectInvitationToken();
  const invitation = await persistence.createProjectInvitation(
    ownerUserId,
    projectId,
    {
      invitationId: `invite_${crypto.randomUUID()}`,
      email: request.email,
      role: request.role,
      tokenHash: await hashProjectInvitationToken(token),
      createdAt: now,
      expiresAt: now + PROJECT_INVITATION_TTL_SECONDS
    }
  );
  return { invitation, token };
}

export async function acceptInvitation(
  persistence: PersistenceService,
  userId: UserId,
  authenticatedEmail: string | undefined,
  value: unknown,
  now = Math.floor(Date.now() / 1000)
): Promise<{ projectId: string; role: ProjectMemberRole }> {
  if (!authenticatedEmail) {
    throw new SharingRequestError(
      400,
      'INVITATION_EMAIL_REQUIRED',
      'An authenticated email is required to accept an invitation.'
    );
  }
  const email = normalizeEmail(authenticatedEmail);
  const token = parseInvitationAcceptance(value);
  return persistence.acceptProjectInvitation(
    userId,
    email,
    await hashProjectInvitationToken(token),
    now
  );
}

export class SharingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SharingRequestError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SharingRequestError(
      400,
      'SHARING_REQUEST_INVALID',
      'Sharing request must be a JSON object.'
    );
  }
  return value as Record<string, unknown>;
}
