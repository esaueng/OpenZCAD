/**
 * Migrating a shared plaintext project (ADR-024 Phase 7, slice 7-4;
 * decisions M7(a) and M8; roadmap L11): the Worker's part in re-adding a
 * project's existing members to its encrypted group. Served through the
 * migration routes (`e2eeProjectMigrations.ts`), so only while
 * E2EE_MIGRATION_ENABLED is on.
 *
 * - `POST …/migration/invitations` (owner): a re-add invitation for one
 *   existing member, an owner-signed statement ("OZI", slice 5-3a) naming
 *   the member's email hash and current role. It is stored as an encrypted
 *   invitation bound to the member at once (they are already a member: no
 *   email, no usable token) and replaces any older open one of theirs. The
 *   member's browser then publishes KeyPackages for it as for any accepted
 *   invitation (`e2eeInvitations.ts` takes them for a plaintext project
 *   being migrated, from a member only).
 * - `GET …/migration/members` (owner): every member with their role,
 *   whether their account has keys, their newest re-add invitation with its
 *   KeyPackage counts and whether this staging re-added them; and the live
 *   plaintext links and pending invitations the cutover revokes.
 * - The start and the cutover ask {@link membersNotReadySql}: a start needs
 *   every member ready (a live re-add invitation with their current role
 *   and an unconsumed KeyPackage), so the project is never locked while
 *   the owner waits for people; the cutover needs every member re-added by
 *   an Add Commit of this staging (with a leaf it registered), and mirrors
 *   them in its batch (`cutoverMirrorStatements`).
 *
 * Verification (slice 5-1) is the owner's browser's check: the Worker sees
 * KeyPackages, not who compared codes with whom.
 */
import {
  ProjectInvitationError,
  decodeProjectInvitation,
  invitationEmailHash,
  toHex,
  verifyProjectInvitation,
  type ProjectInvitation
} from '@openzcad/crypto';
import {
  E2EE_MIGRATION_CODES,
  PROJECT_SHARE_LINK_TTL_SECONDS,
  type E2eeInvitationResponse,
  type E2eeMigrationMemberReason,
  type E2eeMigrationMemberRecord,
  type E2eeMigrationMembersResponse
} from '@openzcad/shared';
import { isE2eeInvitationStorageReady } from '@openzcad/cloudflare-adapters';
import {
  INVITATION_COLUMNS,
  KEY_PACKAGE_COUNTS,
  invitationRecord,
  type InvitationRow
} from './e2eeInvitations';
import {
  bytesField,
  idField,
  json,
  refuse,
  requireCertifiedDevice,
  runBatch,
  type Authorization
} from './e2eeProjects';

const MAX_STATEMENT_BYTES = 601;
/** An ISO time after every `completed_at`: nothing counts as re-added. */
export const NEVER = '9999-12-31T23:59:59.999Z';
const SIGNATURE_BYTES = 65;

/**
 * Member `alias` holds a live re-add invitation with their current role
 * and at least one unconsumed KeyPackage for it. Binds: the time in ms.
 */
const readyInvitation = (alias: string) => `EXISTS (
  SELECT 1 FROM e2ee_invitations ri
  WHERE ri.project_id = ${alias}.project_id
    AND ri.accepted_by_user_id = ${alias}.user_id AND ri.role = ${alias}.role
    AND ri.completed_at IS NULL AND ri.revoked_at IS NULL AND ri.expires_at > ?
    AND EXISTS (SELECT 1 FROM e2ee_key_packages rk
                WHERE rk.invitation_id = ri.invitation_id
                  AND rk.consumed_at IS NULL))`;

/**
 * Member `alias` was re-added by an Add Commit of the staging that began
 * at the bound time (ISO): its invitation completed since, with their
 * current role, and the Add registered a leaf of theirs.
 */
const readded = (alias: string) => `(EXISTS (
  SELECT 1 FROM e2ee_invitations di
  WHERE di.project_id = ${alias}.project_id
    AND di.accepted_by_user_id = ${alias}.user_id AND di.role = ${alias}.role
    AND di.completed_at IS NOT NULL AND di.revoked_at IS NULL
    AND di.completed_at >= ?)
  AND EXISTS (SELECT 1 FROM e2ee_project_leaves dl
              WHERE dl.project_id = ${alias}.project_id
                AND dl.user_id = ${alias}.user_id))`;

/** What a start or cutover statement ANDs in (as `NOT …`), with its binds. */
export interface MembersCheck {
  readonly sql: string;
  binds(projectId: string, now: number, stagedSince: string): unknown[];
}

/**
 * A member is not ready (`start`: neither ready nor re-added by this
 * staging) or not re-added (`cutover`). Without migration 0038's tables
 * no member can be, so any member counts.
 */
export function membersNotReadySql(
  invitationTables: boolean,
  mode: 'start' | 'cutover'
): MembersCheck {
  if (!invitationTables) {
    return {
      sql: `EXISTS (SELECT 1 FROM project_members nm WHERE nm.project_id = ?)`,
      binds: (projectId) => [projectId]
    };
  }
  if (mode === 'cutover') {
    return {
      sql: `EXISTS (SELECT 1 FROM project_members nm WHERE nm.project_id = ?
              AND NOT ${readded('nm')})`,
      binds: (projectId, _now, stagedSince) => [projectId, stagedSince]
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM project_members nm WHERE nm.project_id = ?
            AND NOT ${readyInvitation('nm')} AND NOT ${readded('nm')})`,
    binds: (projectId, now, stagedSince) => [projectId, now, stagedSince]
  };
}

/**
 * Refuses with 409 `E2EE_MIGRATION_MEMBERS_NOT_READY` when a member is not
 * ready (or, at the cutover, not re-added), naming each with the reason.
 */
export async function requireMembersReady(
  db: D1Database,
  projectId: string,
  now: number,
  stagedSince: string,
  mode: 'start' | 'cutover'
): Promise<void> {
  const tables = await isE2eeInvitationStorageReady(db);
  const { results } = await db
    .prepare(
      tables
        ? `SELECT m.user_id,
             EXISTS (SELECT 1 FROM e2ee_identities ei
                     WHERE ei.user_id = m.user_id) AS has_keys,
             EXISTS (SELECT 1 FROM e2ee_invitations li
                     WHERE li.project_id = m.project_id
                       AND li.accepted_by_user_id = m.user_id
                       AND li.role = m.role AND li.completed_at IS NULL
                       AND li.revoked_at IS NULL AND li.expires_at > ?)
               AS invited,
             ${readyInvitation('m')} AS ready,
             ${readded('m')} AS readded
           FROM project_members m WHERE m.project_id = ? ORDER BY m.user_id`
        : `SELECT m.user_id,
             EXISTS (SELECT 1 FROM e2ee_identities ei
                     WHERE ei.user_id = m.user_id) AS has_keys,
             0 AS invited, 0 AS ready, 0 AS readded
           FROM project_members m WHERE m.project_id = ? ORDER BY m.user_id`
    )
    .bind(...(tables ? [now, now, stagedSince, projectId] : [projectId]))
    .all<{
      user_id: string;
      has_keys: number;
      invited: number;
      ready: number;
      readded: number;
    }>();
  const members: { userId: string; reason: E2eeMigrationMemberReason }[] = [];
  for (const row of results ?? []) {
    if (row.readded) continue;
    if (mode === 'cutover') {
      members.push({ userId: row.user_id, reason: 'not-readded' });
      continue;
    }
    if (row.ready) continue;
    members.push({
      userId: row.user_id,
      reason: !row.has_keys
        ? 'no-keys'
        : !row.invited
          ? 'not-invited'
          : 'waiting-for-keys'
    });
  }
  if (members.length) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.membersNotReady,
      mode === 'cutover'
        ? 'Every member must be added back to the encrypted project before it switches over.'
        : 'Every member must be ready to be added back before this shared project is encrypted.',
      { members }
    );
  }
}

/**
 * The cutover's mirror of the re-adds (decision M7(a)), chained on its own
 * fence (`cut`, one SQL fragment and its binds): each member's role as the
 * Add's invitation named it (their current one, which the cutover checked),
 * an access event per re-added member, and every re-add invitation still
 * open (a renewed one nobody used) revoked with its KeyPackages.
 */
export function cutoverMirrorStatements(
  db: D1Database,
  input: {
    readonly projectId: string;
    readonly ownerUserId: string;
    readonly stagedSince: string;
    readonly nowIso: string;
    readonly nowSeconds: number;
    readonly cut: { readonly sql: string; readonly binds: readonly unknown[] };
  }
): D1PreparedStatement[] {
  const { projectId, stagedSince, cut } = input;
  const completed = `FROM e2ee_invitations ci
    WHERE ci.project_id = project_members.project_id
      AND ci.accepted_by_user_id = project_members.user_id
      AND ci.completed_at IS NOT NULL AND ci.revoked_at IS NULL
      AND ci.completed_at >= ?`;
  return [
    db
      .prepare(
        `UPDATE project_members
         SET role = (SELECT ci.role ${completed}
                     ORDER BY ci.completed_at DESC LIMIT 1),
             updated_at = ?
         WHERE project_id = ? AND EXISTS (SELECT 1 ${completed})
           AND ${cut.sql}`
      )
      .bind(
        stagedSince,
        input.nowSeconds,
        projectId,
        stagedSince,
        ...cut.binds
      ),
    db
      .prepare(
        `INSERT INTO project_access_events
           (project_id, actor_user_id, subject_user_id, event_type,
            next_role, created_at, metadata_json)
         SELECT m.project_id, ?, m.user_id, 'invitation-accepted', m.role, ?,
                json_object('encryptedInvitationId', i.invitation_id,
                            'epoch', i.completed_epoch,
                            'migration', json('true'))
         FROM project_members m
         JOIN e2ee_invitations i
           ON i.project_id = m.project_id AND i.accepted_by_user_id = m.user_id
          AND i.completed_at IS NOT NULL AND i.revoked_at IS NULL
          AND i.completed_at >= ?
         WHERE m.project_id = ? AND ${cut.sql}`
      )
      .bind(
        input.ownerUserId,
        input.nowSeconds,
        stagedSince,
        projectId,
        ...cut.binds
      ),
    db
      .prepare(
        `DELETE FROM e2ee_key_packages
         WHERE project_id = ? AND consumed_at IS NULL
           AND invitation_id IN (SELECT invitation_id FROM e2ee_invitations
             WHERE project_id = ? AND completed_at IS NULL
               AND revoked_at IS NULL)
           AND ${cut.sql}`
      )
      .bind(projectId, projectId, ...cut.binds),
    db
      .prepare(
        `UPDATE e2ee_invitations SET revoked_at = ?
         WHERE project_id = ? AND completed_at IS NULL AND revoked_at IS NULL
           AND ${cut.sql}`
      )
      .bind(input.nowIso, projectId, ...cut.binds)
  ];
}

/**
 * What an abandoned encrypt staging's cleanup drops besides its group
 * (fenced on `fence`, one bind: the project id): the Welcomes and consumed
 * KeyPackages of its re-adds, and their completed invitations, so a new
 * staging re-adds the members again. Open invitations and unconsumed
 * KeyPackages stay: the members need not publish again.
 */
export async function abandonedReaddStatements(
  db: D1Database,
  projectId: string,
  fence: string
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeInvitationStorageReady(db))) return [];
  return [
    db
      .prepare(`DELETE FROM e2ee_welcomes WHERE project_id = ? AND ${fence}`)
      .bind(projectId, projectId),
    db
      .prepare(
        `DELETE FROM e2ee_key_packages WHERE project_id = ?
           AND (consumed_at IS NOT NULL OR invitation_id IN (
             SELECT invitation_id FROM e2ee_invitations
             WHERE project_id = ? AND completed_at IS NOT NULL))
           AND ${fence}`
      )
      .bind(projectId, projectId, projectId),
    db
      .prepare(
        `DELETE FROM e2ee_invitations
         WHERE project_id = ? AND completed_at IS NOT NULL AND ${fence}`
      )
      .bind(projectId, projectId)
  ];
}

// --- Routes -------------------------------------------------------------------

interface MemberRow {
  user_id: string;
  email: string | null;
  role: 'editor' | 'viewer';
  has_keys: number;
}

/** `GET …/migration/members` (the caller owns the project). */
export async function listMigrationMembers(
  db: D1Database,
  projectId: string,
  stagedSince: string | null
): Promise<Response> {
  const tables = await isE2eeInvitationStorageReady(db);
  const { results: memberRows } = await db
    .prepare(
      `SELECT m.user_id, u.email, m.role,
         EXISTS (SELECT 1 FROM e2ee_identities ei
                 WHERE ei.user_id = m.user_id) AS has_keys
       FROM project_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? ORDER BY m.user_id`
    )
    .bind(projectId)
    .all<MemberRow>();
  const members: E2eeMigrationMemberRecord[] = [];
  for (const row of memberRows ?? []) {
    let invitation: InvitationRow | null = null;
    let wasReadded = false;
    if (tables) {
      // A re-add of this staging first, then the newest open one, then
      // the newest at all.
      invitation = await db
        .prepare(
          `SELECT ${INVITATION_COLUMNS}${KEY_PACKAGE_COUNTS}
           FROM e2ee_invitations
           WHERE project_id = ? AND accepted_by_user_id = ?
           ORDER BY (completed_at IS NOT NULL AND completed_at >= ?) DESC,
                    (completed_at IS NULL AND revoked_at IS NULL) DESC,
                    created_at DESC, invitation_id
           LIMIT 1`
        )
        .bind(projectId, row.user_id, stagedSince ?? NEVER)
        .first<InvitationRow>();
      if (stagedSince !== null) {
        const done = await db
          .prepare(
            `SELECT ${readded('m')} AS readded FROM project_members m
             WHERE m.project_id = ? AND m.user_id = ?`
          )
          .bind(stagedSince, projectId, row.user_id)
          .first<{ readded: number }>();
        wasReadded = Boolean(done?.readded);
      }
    }
    members.push({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      hasKeys: Boolean(row.has_keys),
      invitation: invitation ? invitationRecord(invitation) : null,
      readded: wasReadded
    });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { results: links } = await db
    .prepare(
      `SELECT id, mode FROM project_share_links
       WHERE project_id = ? AND revoked_at IS NULL AND created_at > ?
       ORDER BY created_at, id`
    )
    .bind(projectId, nowSeconds - PROJECT_SHARE_LINK_TTL_SECONDS)
    .all<{ id: string; mode: 'view' | 'tweak' }>();
  const { results: invitations } = await db
    .prepare(
      `SELECT id, email, role FROM project_invitations
       WHERE project_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at >= ?
       ORDER BY created_at, id`
    )
    .bind(projectId, nowSeconds)
    .all<{ id: string; email: string; role: 'editor' | 'viewer' }>();
  return json({
    members,
    shareLinks: (links ?? []).map((link) => ({
      shareLinkId: link.id,
      mode: link.mode
    })),
    invitations: (invitations ?? []).map((invitation) => ({
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role
    }))
  } satisfies E2eeMigrationMembersResponse);
}

function invalidStatement(message: string): never {
  refuse(400, 'E2EE_INVITATION_INVALID', message);
}

/**
 * `POST …/migration/invitations` (the caller owns this plaintext project,
 * which is not past its cutover): stores a re-add invitation for one of
 * its members and revokes their older open ones.
 */
export async function createMigrationInvitation(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>
): Promise<Response> {
  if (!(await isE2eeInvitationStorageReady(db))) {
    refuse(
      503,
      'E2EE_UNAVAILABLE',
      'Encrypting shared projects is unavailable until the database is updated.'
    );
  }
  const memberUserId = idField(body.memberUserId, 'memberUserId');
  const statementField = bytesField(body.statement, 'statement', {
    max: MAX_STATEMENT_BYTES
  });
  const signatureField = bytesField(body.signature, 'signature', {
    exact: SIGNATURE_BYTES
  });
  const member = await db
    .prepare(
      `SELECT m.role, u.email,
         EXISTS (SELECT 1 FROM e2ee_identities ei
                 WHERE ei.user_id = m.user_id) AS has_keys
       FROM project_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? AND m.user_id = ?`
    )
    .bind(projectId, memberUserId)
    .first<{
      role: 'editor' | 'viewer';
      email: string | null;
      has_keys: number;
    }>();
  if (!member) {
    refuse(
      409,
      'E2EE_MEMBER_NOT_FOUND',
      'That person is not a member of this project.'
    );
  }
  if (!member.has_keys || !member.email) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.membersNotReady,
      'This member has not set up encryption yet.',
      { members: [{ userId: memberUserId, reason: 'no-keys' }] }
    );
  }
  let decoded: ProjectInvitation;
  try {
    decoded = decodeProjectInvitation(statementField.bytes);
  } catch {
    invalidStatement('The invitation statement is malformed.');
  }
  if (
    decoded.projectId !== projectId ||
    decoded.inviterUserId !== userId ||
    decoded.role !== member.role
  ) {
    invalidStatement(
      'The invitation statement is for another project, owner or role.'
    );
  }
  const signer = await requireCertifiedDevice(
    db,
    userId,
    decoded.signerDeviceId
  );
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
          inviteeEmailHash: await invitationEmailHash(member.email)
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
    invalidStatement(
      'The invitation statement does not verify for this member with your device’s key.'
    );
  }
  // No token is ever handed out: the member is bound below.
  const token = new Uint8Array(32);
  crypto.getRandomValues(token);
  const tokenHash = toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', token))
  );
  const now = new Date(nowMs).toISOString();
  const project = `EXISTS (SELECT 1 FROM projects p
      WHERE p.id = ? AND p.user_id = ? AND p.storage_format = 1
        AND p.status <> 'deleted')
    AND EXISTS (SELECT 1 FROM project_members pm
      WHERE pm.project_id = ? AND pm.user_id = ? AND pm.role = ?)
    AND NOT EXISTS (SELECT 1 FROM e2ee_project_migrations mm
      WHERE mm.project_id = ? AND mm.state IN ('cutover', 'purging'))`;
  const projectBinds = [
    projectId,
    userId,
    projectId,
    memberUserId,
    member.role,
    projectId
  ];
  const older = `SELECT invitation_id FROM e2ee_invitations
    WHERE project_id = ? AND accepted_by_user_id = ?
      AND completed_at IS NULL AND revoked_at IS NULL`;
  const results = await runBatch(db, [
    db
      .prepare(
        `INSERT INTO e2ee_invitations
           (invitation_id, project_id, invited_by_user_id, email_hash, role,
            token_hash, statement, signature, signer_device_id, created_at,
            expires_at, accepted_by_user_id, accepted_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${authorization.sql} AND ${project}`
      )
      .bind(
        decoded.invitationId,
        projectId,
        userId,
        toHex(decoded.inviteeEmailHash),
        decoded.role,
        tokenHash,
        statementField.text,
        signatureField.text,
        decoded.signerDeviceId,
        now,
        decoded.expiresAt,
        memberUserId,
        now,
        ...authorization.binds,
        ...projectBinds
      ),
    // Their older open re-add invitations end, with their KeyPackages.
    db
      .prepare(
        `DELETE FROM e2ee_key_packages
         WHERE consumed_at IS NULL AND invitation_id IN (${older}
           AND invitation_id <> ?)
           AND EXISTS (SELECT 1 FROM e2ee_invitations
                       WHERE invitation_id = ?)`
      )
      .bind(
        projectId,
        memberUserId,
        decoded.invitationId,
        decoded.invitationId
      ),
    db
      .prepare(
        `UPDATE e2ee_invitations SET revoked_at = ?
         WHERE invitation_id IN (${older} AND invitation_id <> ?)
           AND EXISTS (SELECT 1 FROM e2ee_invitations
                       WHERE invitation_id = ?)`
      )
      .bind(
        now,
        projectId,
        memberUserId,
        decoded.invitationId,
        decoded.invitationId
      )
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'This project can no longer prepare re-add invitations. Reload it.'
    );
  }
  const row = await db
    .prepare(
      `SELECT ${INVITATION_COLUMNS}${KEY_PACKAGE_COUNTS} FROM e2ee_invitations
       WHERE invitation_id = ?`
    )
    .bind(decoded.invitationId)
    .first<InvitationRow>();
  return json(
    { invitation: invitationRecord(row!) } satisfies E2eeInvitationResponse,
    201
  );
}
