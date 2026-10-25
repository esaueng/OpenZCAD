/**
 * Wire types and a thin client for invitations to end-to-end encrypted
 * projects (ADR-024 Phase 5, slice 5-3a; roadmap L11), served under
 * `/api/e2ee/…` behind E2EE_PROJECTS_ENABLED and migration 0038. Every
 * byte string is unpadded base64url; times named `…At` are ISO strings
 * except `expiresAt`, the statement's Unix milliseconds.
 *
 * The flow (the browser half is slice 5-3b):
 *
 * 1. The owner's certified device signs an invitation statement
 *    (`signProjectInvitation`, "OZI") and posts it with the invitee's email:
 *    `POST /api/e2ee/projects/:id/invitations`. The Worker verifies it
 *    against the owner's device list, stores it with a hash of the email,
 *    and emails a link that names the sender, not the project.
 * 2. The invitee signs in with that email and accepts the emailed token:
 *    `POST /api/e2ee/invitations/accept`. That binds their account; it does
 *    not make them a member.
 * 3. Each of the invitee's certified devices publishes one KeyPackage with
 *    its certified leaf: `POST /api/e2ee/projects/:id/key-packages`.
 * 4. The owner claims them once (`POST …/key-packages/claim`; atomic,
 *    single use) and Commits an Add (`POST …/mls/commits` with `add`). The
 *    Worker refuses an Add whose stated KeyPackages are not exactly the ones
 *    the owner claimed for that invitation; otherwise one batch consumes
 *    them, registers their leaves, stores the Welcome for each and inserts
 *    the `project_members` row with the invitation's role.
 * 5. Each added device reads its Welcome: `GET …/welcome?deviceId=`.
 *
 * Slice 5-3b adds the owner's view of each invitation's KeyPackages
 * (`keyPackages`, `claimedKeyPackages`), the group epoch an invitee's
 * leaf is certified from (`groupEpoch`) and `GET /api/e2ee/invitations/sent`.
 */
import type { E2eeProjectLeafInput } from './e2ee-project-groups';

export type E2eeInvitationRole = 'editor' | 'viewer';

/** `POST /api/e2ee/projects/:id/invitations` (owner only). */
export interface E2eeCreateInvitationRequest {
  /** Where the Worker sends the invitation; it stores only the hash. */
  email: string;
  /** Canonical `encodeProjectInvitation` bytes. */
  statement: string;
  /** 65-byte signature by the statement's signing device. */
  signature: string;
}

export interface E2eeInvitationRecord {
  invitationId: string;
  projectId: string;
  inviterUserId: string;
  role: E2eeInvitationRole;
  /** Hex `invitationEmailHash` of the invitee's email. */
  emailHash: string;
  statement: string;
  signature: string;
  signerDeviceId: string;
  createdAt: string;
  expiresAt: number;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  /** The epoch the owner's Add Commit was sent in. */
  completedEpoch: number | null;
  revokedAt: string | null;
  /**
   * The owner's lists (`list`, `sent`; slice 5-3b): the invitee's
   * published KeyPackages no claim took yet, and those the owner claimed
   * that no Add consumed. Absent from the invitee's answers.
   */
  keyPackages?: number;
  claimedKeyPackages?: number;
  /**
   * The invitee's answers (`accept`, `accepted`; slice 5-3b): the
   * project's MLS group epoch now, which a KeyPackage's leaf is certified
   * from (`certifiedEpoch`). A hint the server gives; null without a group.
   */
  groupEpoch?: number | null;
}

export interface E2eeInvitationResponse {
  invitation: E2eeInvitationRecord;
}

export interface E2eeInvitationsResponse {
  invitations: E2eeInvitationRecord[];
}

/** `POST /api/e2ee/invitations/accept`: the token from the emailed link. */
export interface E2eeAcceptInvitationRequest {
  token: string;
}

/** `POST /api/e2ee/projects/:id/key-packages` (the accepted invitee). */
export interface E2eePublishKeyPackageRequest {
  invitationId: string;
  /** The publishing device, certified in the invitee's device list. */
  deviceId: string;
  /** The MLS KeyPackage message. */
  keyPackage: string;
  /** The device's certified leaf for this project. */
  leaf: E2eeProjectLeafInput;
}

export interface E2eeKeyPackageRecord {
  invitationId: string;
  userId: string;
  deviceId: string;
  keyPackage: string;
  /** Hex SHA-256 of the KeyPackage bytes, as an Add names it. */
  keyPackageHash: string;
  leaf: E2eeProjectLeafInput;
  createdAt: string;
  claimedAt: string | null;
  consumedAt: string | null;
}

export interface E2eeKeyPackageResponse {
  keyPackage: E2eeKeyPackageRecord;
}

/** `POST …/key-packages/claim` (owner only): every unclaimed one, once. */
export interface E2eeClaimKeyPackagesRequest {
  invitationId: string;
}

export interface E2eeKeyPackagesResponse {
  keyPackages: E2eeKeyPackageRecord[];
}

/** One KeyPackage an Add Commit consumes, as the claim returned it. */
export interface E2eeMlsAddedKeyPackage {
  userId: string;
  deviceId: string;
  keyPackageHash: string;
}

/**
 * The membership change an Add Commit states (`E2eeMlsCommitRequest.add`):
 * the invitation, exactly the KeyPackages the owner claimed for it, and the
 * Commit's Welcome.
 */
export interface E2eeMlsAddRequest {
  invitationId: string;
  keyPackages: E2eeMlsAddedKeyPackage[];
  welcome: string;
}

export interface E2eeWelcomeRecord {
  /** The epoch the Add was sent in; the Welcome joins `epoch + 1`. */
  epoch: number;
  keyPackageHash: string;
  welcome: string;
  createdAt: string;
}

/** `GET …/welcome?deviceId=`: the caller's device's newest Welcome. */
export interface E2eeWelcomeResponse {
  welcome: E2eeWelcomeRecord;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A refusal from the invitation routes, with the Worker's stable `code`. */
export class E2eeInvitationApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'E2eeInvitationApiError';
  }
}

export interface E2eeInvitationsApi {
  create(
    projectId: string,
    request: E2eeCreateInvitationRequest
  ): Promise<E2eeInvitationResponse>;
  /** The project's invitations (owner only). */
  list(projectId: string): Promise<E2eeInvitationsResponse>;
  revoke(
    projectId: string,
    invitationId: string
  ): Promise<E2eeInvitationResponse>;
  accept(request: E2eeAcceptInvitationRequest): Promise<E2eeInvitationResponse>;
  /** Invitations this account accepted that no Add completed yet. */
  accepted(): Promise<E2eeInvitationsResponse>;
  /**
   * Invitations this account sent that their invitee accepted and no Add
   * completed yet, across its projects (slice 5-3b): what the owner's next
   * session completes.
   */
  sent(): Promise<E2eeInvitationsResponse>;
  publishKeyPackage(
    projectId: string,
    request: E2eePublishKeyPackageRequest
  ): Promise<E2eeKeyPackageResponse>;
  claimKeyPackages(
    projectId: string,
    request: E2eeClaimKeyPackagesRequest
  ): Promise<E2eeKeyPackagesResponse>;
  welcome(projectId: string, deviceId: string): Promise<E2eeWelcomeResponse>;
}

export function createE2eeInvitationsApi(fetcher: Fetch): E2eeInvitationsApi {
  const call = async <T>(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<T> => {
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // A static host answers unknown routes with HTML.
    }
    if (!response.ok || payload === null || typeof payload !== 'object') {
      const details = (payload ?? {}) as { error?: unknown; code?: unknown };
      throw new E2eeInvitationApiError(
        response.ok ? 502 : response.status,
        typeof details.error === 'string'
          ? details.error
          : `${response.status} ${response.statusText}`,
        typeof details.code === 'string' ? details.code : undefined
      );
    }
    return payload as T;
  };
  const project = (projectId: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}`;
  return {
    create: (projectId, request) =>
      call(`${project(projectId)}/invitations`, 'POST', request),
    list: (projectId) => call(`${project(projectId)}/invitations`),
    revoke: (projectId, invitationId) =>
      call(
        `${project(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
        'DELETE'
      ),
    accept: (request) => call('/api/e2ee/invitations/accept', 'POST', request),
    accepted: () => call('/api/e2ee/invitations'),
    sent: () => call('/api/e2ee/invitations/sent'),
    publishKeyPackage: (projectId, request) =>
      call(`${project(projectId)}/key-packages`, 'POST', request),
    claimKeyPackages: (projectId, request) =>
      call(`${project(projectId)}/key-packages/claim`, 'POST', request),
    welcome: (projectId, deviceId) =>
      call(
        `${project(projectId)}/welcome?deviceId=${encodeURIComponent(deviceId)}`
      )
  };
}
