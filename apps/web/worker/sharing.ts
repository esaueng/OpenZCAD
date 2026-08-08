import type {
  CreateProjectInvitationResponse,
  ProjectMemberRole,
  UserId
} from '@openzcad/shared';
import type { PersistenceService } from '@openzcad/persistence';
import { normalizeEmail } from './auth';

export const PROJECT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

export interface ProjectInvitationEmailConfig {
  sender: string;
  publicAppOrigin: string;
}

export interface ProjectInvitationEmailDetails {
  recipientEmail: string;
  inviterLabel: string;
  projectName: string;
  role: ProjectMemberRole;
  expiresAt: number;
  token: string;
}

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&#39;';
      default:
        return '&quot;';
    }
  });
}

export function projectInvitationUrl(
  publicAppOrigin: string,
  token: string
): string {
  let origin: URL;
  try {
    origin = new URL(publicAppOrigin);
  } catch {
    throw new SharingRequestError(
      503,
      'INVITATION_EMAIL_UNAVAILABLE',
      'Project invitation email is not configured.'
    );
  }
  const localDevelopmentOrigin =
    origin.protocol === 'http:' &&
    (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1');
  if (
    (origin.protocol !== 'https:' && !localDevelopmentOrigin) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new SharingRequestError(
      503,
      'INVITATION_EMAIL_UNAVAILABLE',
      'Project invitation email is not configured.'
    );
  }
  origin.hash = `invite=${encodeURIComponent(token)}`;
  return origin.toString();
}

export function buildProjectInvitationEmail(
  config: ProjectInvitationEmailConfig,
  details: ProjectInvitationEmailDetails
): EmailMessageBuilder {
  const invitationUrl = projectInvitationUrl(
    config.publicAppOrigin,
    details.token
  );
  const roleLabel = details.role === 'editor' ? 'Editor' : 'Viewer';
  const expiresAt = new Date(details.expiresAt * 1_000).toUTCString();
  const escapedProjectName = escapeHtml(details.projectName);
  const escapedInviter = escapeHtml(details.inviterLabel);
  const escapedRole = escapeHtml(roleLabel);
  const escapedExpiry = escapeHtml(expiresAt);
  const escapedUrl = escapeHtml(invitationUrl);
  return {
    to: details.recipientEmail,
    from: { email: config.sender, name: 'OpenZCAD' },
    subject: 'You are invited to an OpenZCAD project',
    text: [
      `${details.inviterLabel} invited you to the OpenZCAD project “${details.projectName}” as a ${roleLabel.toLowerCase()}.`,
      '',
      `Open the project: ${invitationUrl}`,
      '',
      `Sign in with the email address that received this invitation. The link expires ${expiresAt}.`,
      '',
      'If you were not expecting this invitation, you can ignore this email.'
    ].join('\n'),
    html: [
      '<!doctype html><html><body style="margin:0;background:#f5f7fa;color:#172033;font-family:Arial,sans-serif">',
      '<div style="max-width:560px;margin:0 auto;padding:32px 20px">',
      '<div style="background:#fff;border:1px solid #dfe4ec;border-radius:12px;padding:28px">',
      '<p style="margin:0 0 8px;font-size:13px;color:#667085">OpenZCAD project invitation</p>',
      `<h1 style="margin:0 0 18px;font-size:24px">${escapedProjectName}</h1>`,
      `<p style="margin:0 0 18px;line-height:1.55"><strong>${escapedInviter}</strong> invited you as a <strong>${escapedRole}</strong>.</p>`,
      `<p style="margin:0 0 22px"><a href="${escapedUrl}" style="display:inline-block;padding:11px 18px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Open project</a></p>`,
      '<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#667085">Sign in with the email address that received this invitation.</p>',
      `<p style="margin:0;font-size:13px;line-height:1.5;color:#667085">This link expires ${escapedExpiry}. If you were not expecting it, you can ignore this email.</p>`,
      '</div></div></body></html>'
    ].join('')
  };
}

export async function sendProjectInvitationEmail(
  email: SendEmail,
  config: ProjectInvitationEmailConfig,
  details: ProjectInvitationEmailDetails
): Promise<void> {
  await email.send(buildProjectInvitationEmail(config, details));
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
