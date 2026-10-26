/**
 * Invitations to end-to-end encrypted projects, their KeyPackages and
 * Welcomes (ADR-024 Phase 5, slice 5-3a; roadmap L11; migration 0038).
 *
 * - `POST /api/e2ee/projects/:id/invitations` (owner): stores an
 *   owner-signed invitation statement ("OZI", `@openzcad/crypto`) after
 *   checking its signature against the owner's newest device list, keeps a
 *   hash of the invitee's email (not the email) and emails a link that names
 *   the sender, not the project. `GET` lists them; `DELETE …/:invitationId`
 *   revokes one that no Add completed.
 * - `POST /api/e2ee/invitations/accept`: binds the signed-in account whose
 *   email hashes to the statement's. It does not make a member: the owner's
 *   Add Commit does. `GET /api/e2ee/invitations` lists this account's
 *   accepted, unfinished invitations; `GET …/invitations/sent` the
 *   owner's (slice 5-3b).
 * - `POST /api/e2ee/projects/:id/key-packages` (the accepted invitee): one
 *   KeyPackage per project and certified device, with its certified leaf.
 *   Republishing replaces one that no Add consumed (and resets its claim).
 * - `POST …/key-packages/claim` (owner): claims every unclaimed KeyPackage
 *   of the invitation in one statement. A claim is atomic and single use: a
 *   claimed KeyPackage is never handed out again.
 * - The Add form of `POST …/mls/commits` (`add`, `prepareAddCommit`): the
 *   owner states the invitation, exactly the KeyPackages it claimed and the
 *   Welcome. The Worker refuses a Commit whose stated change does not match
 *   the claim. Otherwise the Commit's own batch consumes the KeyPackages,
 *   registers their leaves (so every member's MLS directory accepts the new
 *   leaves; a leaf a Commit adds without a claimed KeyPackage is not in the
 *   registry, and every member's directory refuses it), stores the Welcome
 *   per recipient KeyPackage, inserts the `project_members` row with the
 *   invitation's role and completes the invitation.
 * - `GET …/welcome?deviceId=` (a member): the device's newest Welcome.
 *
 * Served by `handleE2eeRequest` after the key gate, key-table readiness and
 * the write authorization. Here: E2EE_PROJECTS_ENABLED, project sharing for
 * the account, migrations 0031, 0032 and 0038 (503 without them),
 * format-2 projects only. The plaintext invitation routes are unchanged and
 * keep refusing encrypted projects; an encrypted invitation's token is
 * unknown to them.
 */
import {
  ProjectInvitationError,
  decodeProjectInvitation,
  invitationEmailHash,
  toHex,
  verifyProjectInvitation,
  type ProjectInvitation
} from '@openzcad/crypto';
import type {
  E2eeInvitationRecord,
  E2eeInvitationResponse,
  E2eeInvitationsResponse,
  E2eeKeyPackageRecord,
  E2eeKeyPackageResponse,
  E2eeKeyPackagesResponse,
  E2eeMlsAddedKeyPackage,
  E2eeWelcomeResponse
} from '@openzcad/shared';
import {
  isE2eeInvitationStorageReady,
  isE2eeProjectGroupStorageReady,
  isProjectStorageFormatReady
} from '@openzcad/cloudflare-adapters';
import {
  PROJECT_ACTIVE_INVITATION_CAP,
  PROJECT_INVITATION_RATE_LIMIT,
  PROJECT_INVITATION_RATE_WINDOW_SECONDS,
  PROJECT_MEMBER_CAP
} from '@openzcad/persistence';
import {
  CHAINED,
  PROJECT_FENCE,
  RouteError,
  bytesField,
  deviceListMoved,
  deviceListUnchanged,
  idField,
  invalid,
  json,
  leafField,
  record,
  refuse,
  requireCertifiedDevice,
  requireEncryptedProjectAccess,
  requireOwnedEncryptedProject,
  projectFence,
  runBatch,
  type Authorization
} from './e2eeProjects';
import {
  createProjectInvitationToken,
  hashProjectInvitationToken
} from './sharing';

const PROJECT_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/(invitations|invitations\/[^/]+|key-packages|key-packages\/claim|welcome)$/;
export const E2EE_INVITATIONS_ROUTE = '/api/e2ee/invitations';
export const E2EE_INVITATION_ACCEPT_ROUTE = '/api/e2ee/invitations/accept';
export const E2EE_SENT_INVITATIONS_ROUTE = '/api/e2ee/invitations/sent';

/** The encrypted invitation, KeyPackage and Welcome routes. */
export function isE2eeInvitationPath(pathname: string): boolean {
  return (
    pathname === E2EE_INVITATIONS_ROUTE ||
    pathname === E2EE_INVITATION_ACCEPT_ROUTE ||
    pathname === E2EE_SENT_INVITATIONS_ROUTE ||
    PROJECT_ROUTE.test(pathname)
  );
}

/** A canonical invitation statement is at most 601 bytes (crypto). */
const MAX_STATEMENT_BYTES = 601;
const SIGNATURE_BYTES = 65;
/** Judgment: a P-256 KeyPackage is well under 1 KiB; leave room. */
const MAX_KEY_PACKAGE_BYTES = 16 * 1024;
const MAX_WELCOME_BYTES = 256 * 1024;
/**
 * Most devices one Add brings (judgment): the Commit row's gate binds two
 * values per KeyPackage and D1 allows 100 bound values per statement.
 */
const MAX_ADDED_DEVICES = 16;
const LIST_LIMIT = 100;

/**
 * What the encrypted invitation routes need from the Worker around them:
 * the session's email (to bind an acceptance), how the sender is named,
 * whether project sharing is open to the account, and the email sender.
 */
export interface E2eeInvitationHost {
  /** The session's authenticated email; null when it has none. */
  readonly email: string | null;
  /** How the invitation email names the sender. */
  readonly inviterLabel: string;
  /** Project sharing is open to this account (the collaboration rollout). */
  readonly sharingEnabled: boolean;
  /**
   * The plaintext invitation route's recipient rules that apply here (the
   * canary allowlist; since slice 5-4 not its edit-lease rule for
   * editors): a refusal, or null to go ahead.
   */
  recipientRefusal?(
    email: string,
    role: 'editor' | 'viewer'
  ): { status: number; code: string; message: string } | null;
  /** The invitation email can be sent at all (binding, sender, origin). */
  readonly emailConfigured: boolean;
  sendInvitationEmail(details: {
    recipientEmail: string;
    inviterLabel: string;
    role: 'editor' | 'viewer';
    /** Unix seconds. */
    expiresAt: number;
    token: string;
  }): Promise<void>;
}

// --- Rows ------------------------------------------------------------------

export interface InvitationRow {
  invitation_id: string;
  project_id: string;
  invited_by_user_id: string;
  email_hash: string;
  role: 'editor' | 'viewer';
  statement: string;
  signature: string;
  signer_device_id: string;
  created_at: string;
  expires_at: number;
  accepted_by_user_id: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  completed_epoch: number | null;
  revoked_at: string | null;
  /** The owner's lists only (slice 5-3b). */
  key_packages?: number;
  claimed_key_packages?: number;
  /** The invitee's answers only (slice 5-3b). */
  group_epoch?: number | null;
}

export const INVITATION_COLUMNS = `invitation_id, project_id, invited_by_user_id,
  email_hash, role, statement, signature, signer_device_id, created_at,
  expires_at, accepted_by_user_id, accepted_at, completed_at,
  completed_epoch, revoked_at`;

export const invitationRecord = (row: InvitationRow): E2eeInvitationRecord => ({
  invitationId: row.invitation_id,
  projectId: row.project_id,
  inviterUserId: row.invited_by_user_id,
  role: row.role,
  emailHash: row.email_hash,
  statement: row.statement,
  signature: row.signature,
  signerDeviceId: row.signer_device_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  acceptedByUserId: row.accepted_by_user_id,
  acceptedAt: row.accepted_at,
  completedAt: row.completed_at,
  completedEpoch: row.completed_epoch,
  revokedAt: row.revoked_at,
  ...(row.key_packages === undefined
    ? {}
    : {
        keyPackages: row.key_packages,
        claimedKeyPackages: row.claimed_key_packages ?? 0
      }),
  ...(row.group_epoch === undefined ? {} : { groupEpoch: row.group_epoch })
});

/**
 * The owner's view of an invitation's KeyPackages (slice 5-3b): published
 * and unclaimed, and claimed but not consumed. Counts only, never the
 * KeyPackages: those go out once, through a claim.
 */
export const KEY_PACKAGE_COUNTS = `,
  (SELECT COUNT(*) FROM e2ee_key_packages k
    WHERE k.invitation_id = e2ee_invitations.invitation_id
      AND k.claimed_at IS NULL AND k.consumed_at IS NULL) AS key_packages,
  (SELECT COUNT(*) FROM e2ee_key_packages k
    WHERE k.invitation_id = e2ee_invitations.invitation_id
      AND k.claimed_at IS NOT NULL AND k.consumed_at IS NULL)
    AS claimed_key_packages`;

/**
 * The invitee's hint (slice 5-3b): the project's group epoch now, which a
 * KeyPackage's leaf is certified from. The invitee cannot read the group
 * before the Add, and a wrong value only narrows what its leaf may do.
 */
const GROUP_EPOCH = `,
  (SELECT g.epoch FROM e2ee_project_groups g
    WHERE g.project_id = e2ee_invitations.project_id) AS group_epoch`;

interface KeyPackageRow {
  invitation_id: string;
  user_id: string;
  device_id: string;
  key_package: string;
  key_package_hash: string;
  leaf_key: string;
  certification: string;
  created_at: string;
  claimed_at: string | null;
  consumed_at: string | null;
}

const KEY_PACKAGE_COLUMNS = `invitation_id, user_id, device_id, key_package,
  key_package_hash, leaf_key, certification, created_at, claimed_at,
  consumed_at`;

const keyPackageRecord = (row: KeyPackageRow): E2eeKeyPackageRecord => ({
  invitationId: row.invitation_id,
  userId: row.user_id,
  deviceId: row.device_id,
  keyPackage: row.key_package,
  keyPackageHash: row.key_package_hash,
  leaf: { leafKey: row.leaf_key, certification: row.certification },
  createdAt: row.created_at,
  claimedAt: row.claimed_at,
  consumedAt: row.consumed_at
});

async function invitationRow(
  db: D1Database,
  invitationId: string
): Promise<InvitationRow | null> {
  return db
    .prepare(
      `SELECT ${INVITATION_COLUMNS} FROM e2ee_invitations WHERE invitation_id = ?`
    )
    .bind(invitationId)
    .first<InvitationRow>();
}

/** An accepted invitation of this project that no Add completed or revoked. */
const OPEN_ACCEPTED = `accepted_by_user_id IS NOT NULL AND completed_at IS NULL
  AND revoked_at IS NULL AND expires_at > ?`;

function unavailableInvitation(): never {
  refuse(
    409,
    'E2EE_INVITATION_UNAVAILABLE',
    'This invitation is not accepted, or it expired, was revoked or was already completed.'
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    )
  );
}

// --- Owner: create, list, revoke --------------------------------------------

async function createInvitation(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  host: E2eeInvitationHost,
  body: Record<string, unknown>
): Promise<Response> {
  await requireOwnedEncryptedProject(db, userId, projectId);
  if (typeof body.email !== 'string') invalid('email must be an address');
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    invalid('email must be an address');
  }
  const statementField = bytesField(body.statement, 'statement', {
    max: MAX_STATEMENT_BYTES
  });
  const signatureField = bytesField(body.signature, 'signature', {
    exact: SIGNATURE_BYTES
  });
  let decoded: ProjectInvitation;
  try {
    decoded = decodeProjectInvitation(statementField.bytes);
  } catch {
    refuse(
      400,
      'E2EE_INVITATION_INVALID',
      'The invitation statement is malformed.'
    );
  }
  if (decoded.projectId !== projectId || decoded.inviterUserId !== userId) {
    refuse(
      400,
      'E2EE_INVITATION_INVALID',
      'The invitation statement is for another project or owner.'
    );
  }
  // The signing device must be certified in the owner's newest list.
  const signer = await requireCertifiedDevice(
    db,
    userId,
    decoded.signerDeviceId
  );
  const emailHash = await invitationEmailHash(email);
  const nowMs = Date.now();
  try {
    await verifyProjectInvitation(
      { statement: statementField.bytes, signature: signatureField.bytes },
      signer.signingKey,
      {
        now: nowMs,
        expected: {
          projectId,
          inviterUserId: userId,
          inviteeEmailHash: emailHash
        }
      }
    );
  } catch (error) {
    if (
      error instanceof ProjectInvitationError &&
      (error.reason === 'expired' || error.reason === 'not-yet-valid')
    ) {
      refuse(
        400,
        'E2EE_INVITATION_EXPIRED',
        'The invitation statement is expired or not valid yet.'
      );
    }
    refuse(
      400,
      'E2EE_INVITATION_INVALID',
      'The invitation statement does not verify with your device’s key.'
    );
  }
  if (
    host.email &&
    toHex(await invitationEmailHash(host.email)) === toHex(emailHash)
  ) {
    invalid('You cannot invite yourself');
  }
  const recipient = host.recipientRefusal?.(email, decoded.role) ?? null;
  if (recipient) refuse(recipient.status, recipient.code, recipient.message);
  if (!host.emailConfigured) {
    refuse(
      503,
      'INVITATION_EMAIL_UNAVAILABLE',
      'Project invitation email is temporarily unavailable.'
    );
  }
  // The plaintext routes' budget, shared: one per owner and window.
  const seconds = Math.floor(nowMs / 1000);
  const windowStart =
    Math.floor(seconds / PROJECT_INVITATION_RATE_WINDOW_SECONDS) *
    PROJECT_INVITATION_RATE_WINDOW_SECONDS;
  const rate = await db
    .prepare(
      `INSERT INTO auth_rate_limits (bucket, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         request_count = CASE
           WHEN auth_rate_limits.window_start = excluded.window_start
             THEN auth_rate_limits.request_count + 1
           ELSE 1
         END,
         window_start = excluded.window_start
       RETURNING request_count`
    )
    .bind(`project-invite-account:${userId}`, windowStart)
    .first<{ request_count: number }>();
  if (!rate || rate.request_count > PROJECT_INVITATION_RATE_LIMIT) {
    refuse(
      429,
      'INVITATION_RATE_LIMIT',
      'Too many project invitations were created recently.'
    );
  }
  const token = createProjectInvitationToken();
  const tokenHash = await hashProjectInvitationToken(token);
  const emailHex = toHex(emailHash);
  const now = new Date(nowMs).toISOString();
  const [inserted] = await runBatch(db, [
    db
      .prepare(
        `INSERT INTO e2ee_invitations
           (invitation_id, project_id, invited_by_user_id, email_hash, role,
            token_hash, statement, signature, signer_device_id, created_at,
            expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${authorization.sql} AND ${PROJECT_FENCE}
           AND NOT EXISTS (SELECT 1 FROM e2ee_invitations
             WHERE project_id = ? AND email_hash = ? AND completed_at IS NULL
               AND revoked_at IS NULL AND expires_at > ?)
           AND (SELECT COUNT(*) FROM e2ee_invitations
             WHERE project_id = ? AND completed_at IS NULL
               AND revoked_at IS NULL AND expires_at > ?) < ?`
      )
      .bind(
        decoded.invitationId,
        projectId,
        userId,
        emailHex,
        decoded.role,
        tokenHash,
        statementField.text,
        signatureField.text,
        decoded.signerDeviceId,
        now,
        decoded.expiresAt,
        ...authorization.binds,
        projectId,
        userId,
        projectId,
        emailHex,
        nowMs,
        projectId,
        nowMs,
        PROJECT_ACTIVE_INVITATION_CAP
      )
  ]);
  if ((inserted?.meta?.changes ?? 0) !== 1) {
    const duplicate = await db
      .prepare(
        `SELECT 1 AS found FROM e2ee_invitations
         WHERE project_id = ? AND email_hash = ? AND completed_at IS NULL
           AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(projectId, emailHex, nowMs)
      .first<{ found: number }>();
    if (duplicate) {
      refuse(
        409,
        'INVITATION_EXISTS',
        'An active invitation already exists for that email.'
      );
    }
    const active = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM e2ee_invitations
         WHERE project_id = ? AND completed_at IS NULL
           AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(projectId, nowMs)
      .first<{ count: number }>();
    if ((active?.count ?? 0) >= PROJECT_ACTIVE_INVITATION_CAP) {
      refuse(
        409,
        'INVITATION_LIMIT',
        'This project has too many active invitations.'
      );
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  try {
    await host.sendInvitationEmail({
      recipientEmail: email,
      inviterLabel: host.inviterLabel,
      role: decoded.role,
      expiresAt: Math.floor(decoded.expiresAt / 1000),
      token
    });
  } catch {
    // Nobody can accept an invitation whose email never went out.
    await db
      .prepare(
        `UPDATE e2ee_invitations SET revoked_at = ?
         WHERE invitation_id = ? AND revoked_at IS NULL`
      )
      .bind(new Date().toISOString(), decoded.invitationId)
      .run();
    console.error(
      JSON.stringify({
        event: 'e2ee_invitation_email_failed',
        invitationId: decoded.invitationId
      })
    );
    refuse(
      503,
      'INVITATION_EMAIL_UNAVAILABLE',
      'Project invitation email is temporarily unavailable. Try again.'
    );
  }
  return json(
    {
      invitation: invitationRecord(
        (await invitationRow(db, decoded.invitationId))!
      )
    } satisfies E2eeInvitationResponse,
    201
  );
}

async function listProjectInvitations(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<Response> {
  await requireOwnedEncryptedProject(db, userId, projectId);
  const { results } = await db
    .prepare(
      `SELECT ${INVITATION_COLUMNS}${KEY_PACKAGE_COUNTS} FROM e2ee_invitations
       WHERE project_id = ? ORDER BY created_at DESC, invitation_id LIMIT ?`
    )
    .bind(projectId, LIST_LIMIT)
    .all<InvitationRow>();
  return json({
    invitations: (results ?? []).map(invitationRecord)
  } satisfies E2eeInvitationsResponse);
}

async function revokeInvitation(
  db: D1Database,
  userId: string,
  projectId: string,
  invitationId: string,
  authorization: Authorization
): Promise<Response> {
  await requireOwnedEncryptedProject(db, userId, projectId);
  const now = new Date().toISOString();
  const [revoked] = await runBatch(db, [
    db
      .prepare(
        `UPDATE e2ee_invitations SET revoked_at = ?
         WHERE invitation_id = ? AND project_id = ? AND completed_at IS NULL
           AND revoked_at IS NULL AND ${authorization.sql} AND ${PROJECT_FENCE}`
      )
      .bind(
        now,
        invitationId,
        projectId,
        ...authorization.binds,
        projectId,
        userId
      ),
    // Its KeyPackages can no longer be claimed or consumed.
    db
      .prepare(
        `DELETE FROM e2ee_key_packages
         WHERE invitation_id = ? AND consumed_at IS NULL AND ${CHAINED}`
      )
      .bind(invitationId)
  ]);
  if ((revoked?.meta?.changes ?? 0) !== 1) {
    refuse(404, 'INVITATION_NOT_FOUND', 'Project invitation not found.');
  }
  return json({
    invitation: invitationRecord((await invitationRow(db, invitationId))!)
  } satisfies E2eeInvitationResponse);
}

// --- Invitee: accept, list ---------------------------------------------------

function tokenField(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 40 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    refuse(
      400,
      'INVITATION_TOKEN_INVALID',
      'Project invitation token is invalid.'
    );
  }
  return value;
}

async function acceptInvitation(
  db: D1Database,
  userId: string,
  authorization: Authorization,
  host: E2eeInvitationHost,
  body: Record<string, unknown>
): Promise<Response> {
  const token = tokenField(body.token);
  if (!host.email) {
    refuse(
      400,
      'INVITATION_EMAIL_REQUIRED',
      'An authenticated email is required to accept an invitation.'
    );
  }
  const emailHex = toHex(await invitationEmailHash(host.email));
  const tokenHash = await hashProjectInvitationToken(token);
  const nowMs = Date.now();
  const [accepted] = await runBatch(db, [
    db
      .prepare(
        `UPDATE e2ee_invitations SET accepted_by_user_id = ?, accepted_at = ?
         WHERE token_hash = ? AND email_hash = ? AND accepted_at IS NULL
           AND revoked_at IS NULL AND expires_at > ?
           AND invited_by_user_id <> ? AND ${authorization.sql}
           AND EXISTS (SELECT 1 FROM projects p
             WHERE p.id = e2ee_invitations.project_id AND p.storage_format = 2
               AND p.status <> 'deleted')`
      )
      .bind(
        userId,
        new Date(nowMs).toISOString(),
        tokenHash,
        emailHex,
        nowMs,
        userId,
        ...authorization.binds
      )
  ]);
  const row = await db
    .prepare(
      `SELECT ${INVITATION_COLUMNS}${GROUP_EPOCH} FROM e2ee_invitations
       WHERE token_hash = ? AND email_hash = ?`
    )
    .bind(tokenHash, emailHex)
    .first<InvitationRow>();
  // Accepting twice from the same account is answered as the first time.
  if (
    !row ||
    ((accepted?.meta?.changes ?? 0) !== 1 &&
      (row.accepted_by_user_id !== userId || row.revoked_at !== null))
  ) {
    refuse(
      404,
      'INVITATION_NOT_FOUND',
      'Project invitation is invalid or expired.'
    );
  }
  return json({
    invitation: invitationRecord(row)
  } satisfies E2eeInvitationResponse);
}

async function listAcceptedInvitations(
  db: D1Database,
  userId: string
): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT ${INVITATION_COLUMNS}${GROUP_EPOCH} FROM e2ee_invitations
       WHERE accepted_by_user_id = ? AND ${OPEN_ACCEPTED}
       ORDER BY accepted_at, invitation_id LIMIT ?`
    )
    .bind(userId, Date.now(), LIST_LIMIT)
    .all<InvitationRow>();
  return json({
    invitations: (results ?? []).map(invitationRecord)
  } satisfies E2eeInvitationsResponse);
}

/**
 * `GET /api/e2ee/invitations/sent` (slice 5-3b): the invitations this
 * account sent, across its encrypted projects, that their invitee accepted
 * and no Add completed, with their KeyPackage counts: what the owner's next
 * session verifies and completes.
 */
async function listSentInvitations(
  db: D1Database,
  userId: string
): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT ${INVITATION_COLUMNS}${KEY_PACKAGE_COUNTS} FROM e2ee_invitations
       WHERE invited_by_user_id = ? AND ${OPEN_ACCEPTED}
         AND EXISTS (SELECT 1 FROM projects p
           WHERE p.id = e2ee_invitations.project_id AND p.user_id = ?
             AND p.storage_format = 2 AND p.status <> 'deleted')
       ORDER BY accepted_at, invitation_id LIMIT ?`
    )
    .bind(userId, Date.now(), userId, LIST_LIMIT)
    .all<InvitationRow>();
  return json({
    invitations: (results ?? []).map(invitationRecord)
  } satisfies E2eeInvitationsResponse);
}

// --- KeyPackages ---------------------------------------------------------------

async function publishKeyPackage(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>,
  migrationOpen: boolean
): Promise<Response> {
  const invitationId = idField(body.invitationId, 'invitationId');
  const deviceId = idField(body.deviceId, 'deviceId');
  const keyPackage = bytesField(body.keyPackage, 'keyPackage', {
    max: MAX_KEY_PACKAGE_BYTES
  });
  const leaf = leafField(body.leaf);
  // Only a device the invitee's newest list certifies holds a leaf.
  await requireCertifiedDevice(db, userId, deviceId);
  const nowMs = Date.now();
  const invitation = await invitationRow(db, invitationId);
  if (
    !invitation ||
    invitation.project_id !== projectId ||
    invitation.accepted_by_user_id !== userId
  ) {
    refuse(
      404,
      'INVITATION_NOT_FOUND',
      'Project invitation is invalid or expired.'
    );
  }
  if (
    invitation.completed_at !== null ||
    invitation.revoked_at !== null ||
    invitation.expires_at <= nowMs
  ) {
    unavailableInvitation();
  }
  const hash = await sha256Hex(keyPackage.bytes);
  const existing = await db
    .prepare(
      `SELECT key_package_hash, claimed_at, consumed_at FROM e2ee_key_packages
       WHERE project_id = ? AND user_id = ? AND device_id = ?`
    )
    .bind(projectId, userId, deviceId)
    .first<{
      key_package_hash: string;
      claimed_at: string | null;
      consumed_at: string | null;
    }>();
  if (existing?.consumed_at) {
    refuse(
      409,
      'E2EE_KEY_PACKAGE_CONSUMED',
      'This device was already added to the project.'
    );
  }
  if (!existing) {
    const devices = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM e2ee_key_packages
         WHERE project_id = ? AND user_id = ? AND consumed_at IS NULL`
      )
      .bind(projectId, userId)
      .first<{ count: number }>();
    if ((devices?.count ?? 0) >= MAX_ADDED_DEVICES) {
      refuse(
        409,
        'E2EE_KEY_PACKAGE_LIMIT',
        `At most ${MAX_ADDED_DEVICES} devices join a project by one invitation; the others rejoin from them.`
      );
    }
  }
  if (existing?.claimed_at && existing.key_package_hash === hash) {
    refuse(
      409,
      'E2EE_KEY_PACKAGE_CLAIMED',
      'This KeyPackage was already claimed; publish a new one.'
    );
  }
  const now = new Date(nowMs).toISOString();
  const [stored] = await runBatch(db, [
    db
      .prepare(
        `INSERT INTO e2ee_key_packages
           (project_id, user_id, device_id, invitation_id, key_package,
            key_package_hash, leaf_key, certification, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${authorization.sql}
           AND EXISTS (SELECT 1 FROM e2ee_invitations
             WHERE invitation_id = ? AND project_id = ? AND accepted_by_user_id = ?
               AND ${OPEN_ACCEPTED})
           AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ?
             AND p.status <> 'deleted' AND (p.storage_format = 2
               OR (? = 1 AND p.storage_format = 1 AND EXISTS (
                 SELECT 1 FROM project_members pm
                 WHERE pm.project_id = p.id AND pm.user_id = ?))))
         ON CONFLICT (project_id, user_id, device_id) DO UPDATE SET
           invitation_id = excluded.invitation_id,
           key_package = excluded.key_package,
           key_package_hash = excluded.key_package_hash,
           leaf_key = excluded.leaf_key,
           certification = excluded.certification,
           created_at = excluded.created_at,
           claimed_by_user_id = NULL,
           claimed_at = NULL
         WHERE e2ee_key_packages.consumed_at IS NULL`
      )
      .bind(
        projectId,
        userId,
        deviceId,
        invitationId,
        keyPackage.text,
        hash,
        leaf.leafKey,
        leaf.certification,
        now,
        ...authorization.binds,
        invitationId,
        projectId,
        userId,
        nowMs,
        projectId,
        migrationOpen ? 1 : 0,
        userId
      )
  ]);
  if ((stored?.meta?.changes ?? 0) !== 1) {
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  const row = await db
    .prepare(
      `SELECT ${KEY_PACKAGE_COLUMNS} FROM e2ee_key_packages
       WHERE project_id = ? AND user_id = ? AND device_id = ?`
    )
    .bind(projectId, userId, deviceId)
    .first<KeyPackageRow>();
  return json(
    { keyPackage: keyPackageRecord(row!) } satisfies E2eeKeyPackageResponse,
    201
  );
}

async function claimKeyPackages(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>,
  migrationLease: string | null
): Promise<Response> {
  // Slice 7-4: a shared plaintext project being staged for encryption,
  // whose existing members the owner's lease holder re-adds.
  const staged = migrationLease
    ? await requireEncryptedProjectAccess(db, userId, projectId, 'write', {
        migrationLease
      })
    : undefined;
  if (!staged?.staging)
    await requireOwnedEncryptedProject(db, userId, projectId);
  const fence = projectFence(staged, projectId, userId, 'owner');
  const invitationId = idField(body.invitationId, 'invitationId');
  const nowMs = Date.now();
  const invitation = await invitationRow(db, invitationId);
  if (!invitation || invitation.project_id !== projectId) {
    refuse(404, 'INVITATION_NOT_FOUND', 'Project invitation not found.');
  }
  if (
    invitation.accepted_by_user_id === null ||
    invitation.completed_at !== null ||
    invitation.revoked_at !== null ||
    invitation.expires_at <= nowMs
  ) {
    unavailableInvitation();
  }
  // One statement: every unclaimed KeyPackage of the invitation, or none.
  const { results } = await db
    .prepare(
      `UPDATE e2ee_key_packages SET claimed_by_user_id = ?, claimed_at = ?
       WHERE project_id = ? AND invitation_id = ? AND user_id = ?
         AND claimed_at IS NULL AND consumed_at IS NULL
         AND ${authorization.sql} AND ${fence.sql}
         AND EXISTS (SELECT 1 FROM e2ee_invitations
           WHERE invitation_id = ? AND ${OPEN_ACCEPTED})
       RETURNING ${KEY_PACKAGE_COLUMNS}`
    )
    .bind(
      userId,
      new Date(nowMs).toISOString(),
      projectId,
      invitationId,
      invitation.accepted_by_user_id,
      ...authorization.binds,
      ...fence.binds,
      invitationId,
      nowMs
    )
    .all<KeyPackageRow>();
  const claimed = (results ?? []).sort((a, b) =>
    a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0
  );
  if (claimed.length === 0) {
    refuse(
      409,
      'E2EE_KEY_PACKAGE_UNAVAILABLE',
      'The invitee has no unclaimed KeyPackage for this project. Each one is handed out once.'
    );
  }
  return json({
    keyPackages: claimed.map(keyPackageRecord)
  } satisfies E2eeKeyPackagesResponse);
}

async function readWelcome(
  db: D1Database,
  userId: string,
  projectId: string,
  url: URL
): Promise<Response> {
  await requireEncryptedProjectAccess(db, userId, projectId, 'read');
  const deviceId = idField(url.searchParams.get('deviceId'), 'deviceId');
  const row = await db
    .prepare(
      `SELECT epoch, key_package_hash, welcome, created_at FROM e2ee_welcomes
       WHERE project_id = ? AND user_id = ? AND device_id = ?
       ORDER BY epoch DESC LIMIT 1`
    )
    .bind(projectId, userId, deviceId)
    .first<{
      epoch: number;
      key_package_hash: string;
      welcome: string;
      created_at: string;
    }>();
  if (!row) {
    refuse(
      404,
      'E2EE_WELCOME_NOT_FOUND',
      'No Welcome is waiting for this device.'
    );
  }
  return json({
    welcome: {
      epoch: row.epoch,
      keyPackageHash: row.key_package_hash,
      welcome: row.welcome,
      createdAt: row.created_at
    }
  } satisfies E2eeWelcomeResponse);
}

// --- The Add form of a Commit -----------------------------------------------

/** What an Add adds to its Commit's batch (`submitCommit`). */
export interface PreparedAdd {
  /** The invitee and the role its invitation names (the new roles' entry). */
  readonly invitee: {
    readonly userId: string;
    readonly role: 'editor' | 'viewer';
  };
  /** ANDed into the Commit row's own insert, which gates the batch. */
  readonly gateSql: string;
  readonly gateBinds: readonly unknown[];
  /** Chained after the rest of the Commit's batch. */
  statements(now: string): D1PreparedStatement[];
  /** Explains a batch that did not land although the epoch was free. */
  explain(): Promise<never>;
}

function addedKeyPackages(value: unknown): E2eeMlsAddedKeyPackage[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ADDED_DEVICES
  ) {
    invalid(`add.keyPackages must list 1 to ${MAX_ADDED_DEVICES} KeyPackages`);
  }
  const list = value.map((item, index): E2eeMlsAddedKeyPackage => {
    const entry = record(item, `add.keyPackages[${index}]`);
    const hash = entry.keyPackageHash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      invalid(`add.keyPackages[${index}].keyPackageHash must be SHA-256 hex`);
    }
    return {
      userId: idField(entry.userId, `add.keyPackages[${index}].userId`),
      deviceId: idField(entry.deviceId, `add.keyPackages[${index}].deviceId`),
      keyPackageHash: hash
    };
  });
  if (new Set(list.map((entry) => entry.deviceId)).size !== list.length) {
    invalid('add.keyPackages names a device twice');
  }
  return list;
}

/**
 * Checks an owner's Add (`E2eeMlsCommitRequest.add`) against the stored
 * invitation and the KeyPackages the owner claimed for it, and returns what
 * the Commit's batch needs. The stated change must name exactly the claimed,
 * unconsumed KeyPackages, by device and hash; anything else is refused
 * (409 `E2EE_ADD_MISMATCH`). The same conditions gate the Commit row in the
 * batch itself, so nothing lands if the claim changed meanwhile.
 */
export async function prepareAddCommit(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly projectId: string;
    readonly epoch: number;
    readonly kind: 'commit' | 'external';
    readonly add: unknown;
    /**
     * Slice 7-4: the Commit re-adds an existing member of a shared
     * plaintext project being staged for encryption. Its batch leaves
     * `project_members` and the access log as they are: the cutover's
     * batch mirrors every re-add with the format flip, and an abandoned
     * staging leaves the plaintext membership untouched.
     */
    readonly staged?: boolean;
  }
): Promise<PreparedAdd> {
  const { userId, projectId, epoch } = input;
  if (!(await isE2eeInvitationStorageReady(db))) {
    refuse(
      503,
      'E2EE_UNAVAILABLE',
      'Adding members to encrypted projects is unavailable until the database is updated.'
    );
  }
  if (input.kind !== 'commit') invalid('Only a Commit adds members');
  const add = record(input.add, 'add');
  const invitationId = idField(add.invitationId, 'add.invitationId');
  const stated = addedKeyPackages(add.keyPackages);
  const welcome = bytesField(add.welcome, 'add.welcome', {
    max: MAX_WELCOME_BYTES
  }).text;
  const owner = await db
    .prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>();
  if (owner?.user_id !== userId) {
    refuse(
      403,
      'E2EE_PROJECT_OWNER_ONLY',
      'Only the owner can add members to an encrypted project.'
    );
  }
  const check = async (): Promise<InvitationRow> => {
    const nowMs = Date.now();
    const invitation = await invitationRow(db, invitationId);
    if (!invitation || invitation.project_id !== projectId) {
      refuse(404, 'INVITATION_NOT_FOUND', 'Project invitation not found.');
    }
    if (
      invitation.accepted_by_user_id === null ||
      invitation.completed_at !== null ||
      invitation.revoked_at !== null ||
      invitation.expires_at <= nowMs
    ) {
      unavailableInvitation();
    }
    const { results } = await db
      .prepare(
        `SELECT device_id, key_package_hash FROM e2ee_key_packages
         WHERE project_id = ? AND invitation_id = ? AND user_id = ?
           AND claimed_by_user_id = ? AND claimed_at IS NOT NULL
           AND consumed_at IS NULL`
      )
      .bind(projectId, invitationId, invitation.accepted_by_user_id, userId)
      .all<{ device_id: string; key_package_hash: string }>();
    const claimed = new Map(
      (results ?? []).map((row) => [row.device_id, row.key_package_hash])
    );
    const matches =
      claimed.size === stated.length &&
      stated.every(
        (entry) =>
          entry.userId === invitation.accepted_by_user_id &&
          claimed.get(entry.deviceId) === entry.keyPackageHash
      );
    if (!matches) {
      refuse(
        409,
        'E2EE_ADD_MISMATCH',
        'This Commit’s membership change does not match the KeyPackages you claimed for the invitation. Nothing was changed.'
      );
    }
    const members = await db
      .prepare(
        `SELECT COUNT(*) AS count,
           MAX(user_id = ?) AS already FROM project_members WHERE project_id = ?`
      )
      .bind(invitation.accepted_by_user_id, projectId)
      .first<{ count: number; already: number | null }>();
    if (!members?.already && (members?.count ?? 0) >= PROJECT_MEMBER_CAP) {
      refuse(409, 'MEMBER_LIMIT', 'This project has too many members.');
    }
    return invitation;
  };
  const invitation = await check();
  const invitee = invitation.accepted_by_user_id!;
  // Slice 7-4: a staged re-add's leaves are fenced on the member's device
  // list. Nothing but the owner's lease holder commits to a staged group,
  // so a member's device removed after its leaf landed there is refused
  // until the cutover or an abandon (`e2ee.ts`'s staged-leaf fence); one
  // removed before must not land a leaf either, so each added device must
  // be certified in the member's newest list, which must still be theirs
  // when the batch runs.
  const inviteeList = input.staged
    ? await certifiedInviteeList(db, invitee, stated)
    : null;
  const inviteeFence = inviteeList
    ? deviceListUnchanged(invitee, inviteeList)
    : null;
  const nowMs = Date.now();
  const pairs = stated
    .map(() => '(device_id = ? AND key_package_hash = ?)')
    .join(' OR ');
  const claimedRows = `FROM e2ee_key_packages
    WHERE project_id = ? AND invitation_id = ? AND user_id = ?
      AND claimed_by_user_id = ? AND claimed_at IS NOT NULL
      AND consumed_at IS NULL`;
  const claimedBinds = [projectId, invitationId, invitee, userId];
  const gateSql = `EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)
    AND EXISTS (SELECT 1 FROM e2ee_invitations
      WHERE invitation_id = ? AND project_id = ? AND accepted_by_user_id = ?
        AND completed_at IS NULL AND revoked_at IS NULL AND expires_at > ?)
    AND (SELECT COUNT(*) ${claimedRows}) = ?
    AND (SELECT COUNT(*) ${claimedRows} AND (${pairs})) = ?
    AND (EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)
      OR (SELECT COUNT(*) FROM project_members WHERE project_id = ?) < ?)${
        inviteeFence
          ? `
    AND ${inviteeFence.sql}`
          : ''
      }`;
  const gateBinds = [
    projectId,
    userId,
    invitationId,
    projectId,
    invitee,
    nowMs,
    ...claimedBinds,
    stated.length,
    ...claimedBinds,
    ...stated.flatMap((entry) => [entry.deviceId, entry.keyPackageHash]),
    stated.length,
    projectId,
    invitee,
    projectId,
    PROJECT_MEMBER_CAP,
    ...(inviteeFence?.binds ?? [])
  ];
  return {
    invitee: { userId: invitee, role: invitation.role },
    gateSql,
    gateBinds,
    statements: (now) => [
      ...stated.flatMap((entry) => [
        db
          .prepare(
            `UPDATE e2ee_key_packages SET consumed_at = ?, consumed_epoch = ?
             WHERE project_id = ? AND user_id = ? AND device_id = ?
               AND key_package_hash = ? AND claimed_by_user_id = ?
               AND consumed_at IS NULL AND ${CHAINED}`
          )
          .bind(
            now,
            epoch,
            projectId,
            invitee,
            entry.deviceId,
            entry.keyPackageHash,
            userId
          ),
        // The new leaf joins the registry the MLS directory reads.
        db
          .prepare(
            `INSERT INTO e2ee_project_leaves
               (project_id, user_id, device_id, leaf_key, certification, created_at)
             SELECT project_id, user_id, device_id, leaf_key, certification, ?
             FROM e2ee_key_packages
             WHERE project_id = ? AND user_id = ? AND device_id = ?
               AND key_package_hash = ? AND ${CHAINED}`
          )
          .bind(now, projectId, invitee, entry.deviceId, entry.keyPackageHash),
        db
          .prepare(
            `INSERT INTO e2ee_welcomes
               (project_id, user_id, device_id, key_package_hash, epoch,
                welcome, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${CHAINED}`
          )
          .bind(
            projectId,
            invitee,
            entry.deviceId,
            entry.keyPackageHash,
            epoch,
            welcome,
            now
          )
      ]),
      // The server's mirror of the role the Add's roles extension sets
      // (for a staged re-add, the cutover's).
      ...(input.staged
        ? []
        : [
            db
              .prepare(
                `INSERT INTO project_members
             (project_id, user_id, role, added_by_user_id, created_at, updated_at)
           SELECT ?, ?, role, ?, ?, ? FROM e2ee_invitations
           WHERE invitation_id = ? AND ${CHAINED}
           ON CONFLICT (project_id, user_id) DO UPDATE SET
             role = excluded.role, updated_at = excluded.updated_at`
              )
              .bind(
                projectId,
                invitee,
                userId,
                Math.floor(nowMs / 1000),
                Math.floor(nowMs / 1000),
                invitationId
              )
          ]),
      db
        .prepare(
          `UPDATE e2ee_invitations SET completed_at = ?, completed_epoch = ?
           WHERE invitation_id = ? AND completed_at IS NULL AND ${CHAINED}`
        )
        .bind(now, epoch, invitationId),
      ...(input.staged
        ? []
        : [
            db
              .prepare(
                `INSERT INTO project_access_events
             (project_id, actor_user_id, subject_user_id, event_type,
              next_role, created_at, metadata_json)
           SELECT ?, ?, ?, 'invitation-accepted', role, ?, ?
           FROM e2ee_invitations WHERE invitation_id = ? AND ${CHAINED}`
              )
              .bind(
                projectId,
                userId,
                invitee,
                Math.floor(nowMs / 1000),
                JSON.stringify({ encryptedInvitationId: invitationId, epoch }),
                invitationId
              )
          ])
    ],
    explain: async () => {
      await check();
      if (inviteeList && (await deviceListMoved(db, invitee, inviteeList))) {
        refuseInviteeDevicesMoved();
      }
      refuse(
        409,
        'E2EE_ADD_MISMATCH',
        'This Commit’s membership change no longer matches the claimed KeyPackages. Nothing was changed.'
      );
    }
  };
}

/**
 * Slice 7-4: the member's newest device-list head, in which every device a
 * staged re-add adds is certified. Refused like any stale claim
 * (`E2EE_ADD_MISMATCH`), so the owner's browser drops it.
 */
async function certifiedInviteeList(
  db: D1Database,
  invitee: string,
  stated: readonly { readonly deviceId: string }[]
): Promise<{ generation: number; headSequence: number }> {
  let head: { generation: number; headSequence: number } | null = null;
  for (const entry of stated) {
    let current: { generation: number; headSequence: number };
    try {
      current = await requireCertifiedDevice(db, invitee, entry.deviceId);
    } catch (error) {
      if (
        error instanceof RouteError &&
        error.code === 'E2EE_DEVICE_NOT_CERTIFIED'
      ) {
        refuseInviteeDevicesMoved();
      }
      throw error;
    }
    if (
      head &&
      (head.generation !== current.generation ||
        head.headSequence !== current.headSequence)
    ) {
      refuseInviteeDevicesMoved();
    }
    head = {
      generation: current.generation,
      headSequence: current.headSequence
    };
  }
  if (!head) invalid('An Add carries at least one KeyPackage');
  return head;
}

function refuseInviteeDevicesMoved(): never {
  refuse(
    409,
    'E2EE_ADD_MISMATCH',
    'A device this Commit adds is no longer in the member’s device list. Nothing was changed.'
  );
}

// --- Dispatch ----------------------------------------------------------------------

export async function handleE2eeInvitationRequest(
  request: Request,
  db: D1Database,
  userId: string,
  projectsEnabled: boolean,
  authorization: Authorization,
  host: E2eeInvitationHost,
  readBody: () => Promise<Record<string, unknown>>,
  /**
   * Slice 7-4 (only while E2EE_MIGRATION_ENABLED is on): a member of a
   * shared plaintext project publishes KeyPackages for its re-add
   * invitation, and the owner's lease holder claims them.
   */
  migration: { readonly open: boolean; readonly lease: string | null } = {
    open: false,
    lease: null
  }
): Promise<Response> {
  try {
    if (!projectsEnabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Encrypted projects are not available for this account yet.'
      );
    }
    if (!host.sharingEnabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Project sharing is disabled for this account.'
      );
    }
    if (
      !(await isProjectStorageFormatReady(db)) ||
      !(await isE2eeProjectGroupStorageReady(db)) ||
      !(await isE2eeInvitationStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Invitations to encrypted projects are unavailable until the database is updated.'
      );
    }
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === E2EE_INVITATION_ACCEPT_ROUTE && method === 'POST') {
      return await acceptInvitation(
        db,
        userId,
        authorization,
        host,
        await readBody()
      );
    }
    if (url.pathname === E2EE_INVITATIONS_ROUTE && method === 'GET') {
      return await listAcceptedInvitations(db, userId);
    }
    if (url.pathname === E2EE_SENT_INVITATIONS_ROUTE && method === 'GET') {
      return await listSentInvitations(db, userId);
    }
    const match = PROJECT_ROUTE.exec(url.pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    let rest: string;
    try {
      projectId = decodeURIComponent(match[1]!);
      rest = match[2]!;
    } catch {
      refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    }
    if (rest === 'invitations') {
      if (method === 'POST') {
        return await createInvitation(
          db,
          userId,
          projectId,
          authorization,
          host,
          await readBody()
        );
      }
      if (method === 'GET') {
        return await listProjectInvitations(db, userId, projectId);
      }
    } else if (rest.startsWith('invitations/') && method === 'DELETE') {
      let invitationId: string;
      try {
        invitationId = decodeURIComponent(rest.slice('invitations/'.length));
      } catch {
        refuse(404, 'INVITATION_NOT_FOUND', 'Project invitation not found.');
      }
      return await revokeInvitation(
        db,
        userId,
        projectId,
        idField(invitationId, 'invitationId'),
        authorization
      );
    } else if (rest === 'key-packages' && method === 'POST') {
      return await publishKeyPackage(
        db,
        userId,
        projectId,
        authorization,
        await readBody(),
        migration.open
      );
    } else if (rest === 'key-packages/claim' && method === 'POST') {
      return await claimKeyPackages(
        db,
        userId,
        projectId,
        authorization,
        await readBody(),
        migration.open ? migration.lease : null
      );
    } else if (rest === 'welcome' && method === 'GET') {
      return await readWelcome(db, userId, projectId, url);
    }
    refuse(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    if (error instanceof RouteError) {
      return json(
        { error: error.message, code: error.code, ...error.extra },
        error.status
      );
    }
    throw error;
  }
}

/**
 * Account erasure (migration 0038): the account's KeyPackages and Welcomes,
 * and the invitations it received (by acceptance or by its email's hash).
 * Invitations it sent are its projects' data and go with them. Empty until
 * the tables exist.
 */
export async function invitationErasureStatements(
  db: D1Database,
  userId: string,
  email: string | undefined
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeInvitationStorageReady(db))) return [];
  const emailHash = email ? toHex(await invitationEmailHash(email)) : null;
  return [
    db.prepare('DELETE FROM e2ee_welcomes WHERE user_id = ?').bind(userId),
    db
      .prepare(
        `DELETE FROM e2ee_key_packages WHERE user_id = ? OR invitation_id IN (
           SELECT invitation_id FROM e2ee_invitations
           WHERE accepted_by_user_id = ? OR email_hash = ?)`
      )
      .bind(userId, userId, emailHash),
    db
      .prepare(
        `DELETE FROM e2ee_invitations
         WHERE accepted_by_user_id = ? OR email_hash = ?`
      )
      .bind(userId, emailHash)
  ];
}
