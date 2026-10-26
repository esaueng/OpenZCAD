/**
 * Migrating a shared plaintext project (ADR-024 Phase 7, slice 7-4;
 * decisions M7(a) and M8; roadmap L11): the owner's browser re-adds the
 * project's existing members to its encrypted group, through slice 5-3's
 * invitation machinery, and afterwards offers encrypted replacements for
 * the plaintext links and invitations the cutover revoked.
 *
 * - **Re-add invitations.** For each member whose account has set up
 *   encryption, this device signs an invitation statement naming the
 *   member's email hash and current role, and the Worker binds it to the
 *   member at once (`…/migration/invitations`): they are already a member,
 *   so there is no email and no token. The member's own browser lists it
 *   with its other accepted invitations (slice 5-3b), verifies the owner
 *   (the mutual comparison) and publishes a KeyPackage from each of its
 *   devices, while the project stays plaintext and writable.
 * - **Readiness.** A member is ready once they published a KeyPackage and
 *   the owner verified them (slice 5-1). Until every member is, nothing is
 *   staged: the project is not locked while the owner waits (decision
 *   M7(a): block the cutover until every member is verified and re-added).
 * - **Re-add.** Once the staging is complete, just before the cutover, the
 *   owner adds each member by Welcome with their current role, one Add
 *   Commit per member (`addInvitedMember`), under the migration lease. The
 *   Worker's cutover refuses unless every member was re-added this way.
 * - **After the cutover.** The plaintext links and pending invitations the
 *   cutover revoked can be reissued: links as new encrypted links of the
 *   same modes (slice 5-10, whose URLs differ and must be shared again),
 *   invitations as encrypted invitations to the same addresses (5-3b).
 */
import {
  E2EE_MIGRATION_CODES,
  type E2eeInvitationRecord,
  type E2eeMigrationMemberRecord,
  type E2eeMigrationMembersResponse
} from '@openzcad/shared';
import { ApiError } from '../api';
import {
  addInvitedMember,
  inviteToEncryptedProject,
  signInvitationStatement,
  type InvitationContext
} from './invitations';
import type { ProjectMigrationsApi } from './projectMigrationsApi';
import {
  createShareLink,
  type CreatedShareLink,
  type ShareLinksContext
} from './shareLinks';

/**
 * Where a member stands, in the order the owner works through it:
 * `needs-encryption` (they set up encryption), `needs-invitation` (this
 * browser makes their re-add invitation; only an address it cannot see
 * leaves it stuck), `waiting-for-keys` (they open OpenZCAD, compare codes
 * with the owner and their browser publishes keys), `verify` (the owner
 * compares codes with them), `ready`, and `readded`.
 */
export type MigrationMemberState =
  | 'needs-encryption'
  | 'needs-invitation'
  | 'waiting-for-keys'
  | 'verify'
  | 'ready'
  | 'readded';

export interface MigrationMember {
  readonly userId: string;
  readonly email: string | null;
  readonly role: 'editor' | 'viewer';
  readonly state: MigrationMemberState;
  readonly invitation: E2eeInvitationRecord | null;
}

/** What a shared project's migration carries over, or offers to reissue. */
export interface MigrationSharing {
  readonly members: readonly MigrationMember[];
  /** Live plaintext share links, revoked at the cutover (decision M8). */
  readonly shareLinks: E2eeMigrationMembersResponse['shareLinks'];
  /** Pending plaintext invitations, revoked at the cutover. */
  readonly invitations: E2eeMigrationMembersResponse['invitations'];
}

/** What the owner, or the member, does next: plain words for the list. */
export function migrationMemberAction(member: MigrationMember): string {
  const who = member.email ?? 'This member';
  switch (member.state) {
    case 'needs-encryption':
      return `${who} needs to set up encryption in Settings › Encryption.`;
    case 'needs-invitation':
      return member.email
        ? 'Preparing their invitation to the encrypted project…'
        : 'Their email address is not visible to you; remove them and invite them again after encrypting.';
    case 'waiting-for-keys':
      return `${who} needs to open OpenZCAD, compare codes with you (Settings › Encryption › Invitations) and stay signed in until their keys arrive.`;
    case 'verify':
      return `Compare codes with ${member.email ?? 'them'} in Settings › Encryption › Contacts.`;
    case 'ready':
      return 'Ready to be added back with their current role.';
    case 'readded':
      return 'Added back to the encrypted project.';
  }
}

/** A shared project's members are not all ready (decision M7(a)). */
export class MigrationMembersNotReadyError extends Error {
  override readonly name = 'MigrationMembersNotReadyError';
  readonly code = E2EE_MIGRATION_CODES.membersNotReady;
  constructor(readonly members: readonly MigrationMember[]) {
    super(
      members.length === 1
        ? `${members[0]!.email ?? 'A member'} is not ready to be added to the encrypted project yet.`
        : `${members.length} members are not ready to be added to the encrypted project yet.`
    );
  }
}

const usable = (
  record: E2eeMigrationMemberRecord,
  at: number
): E2eeInvitationRecord | null => {
  const invitation = record.invitation;
  return invitation &&
    !invitation.completedAt &&
    !invitation.revokedAt &&
    invitation.expiresAt > at &&
    invitation.role === record.role &&
    invitation.acceptedByUserId === record.userId
    ? invitation
    : null;
};

async function stateOf(
  ctx: InvitationContext,
  record: E2eeMigrationMemberRecord,
  at: number
): Promise<MigrationMemberState> {
  if (record.readded) return 'readded';
  if (!record.hasKeys) return 'needs-encryption';
  const invitation = usable(record, at);
  if (!invitation) return 'needs-invitation';
  if (
    (invitation.keyPackages ?? 0) + (invitation.claimedKeyPackages ?? 0) ===
    0
  ) {
    return 'waiting-for-keys';
  }
  const person = await ctx.people.inspect(record.userId).catch(() => null);
  return person?.status === 'verified' && person.list ? 'ready' : 'verify';
}

async function describeSharing(
  ctx: InvitationContext,
  answer: E2eeMigrationMembersResponse
): Promise<MigrationSharing> {
  const at = (ctx.now ?? Date.now)();
  const members: MigrationMember[] = [];
  for (const record of answer.members) {
    members.push({
      userId: record.userId,
      email: record.email,
      role: record.role,
      state: await stateOf(ctx, record, at),
      invitation: record.invitation
    });
  }
  return {
    members,
    shareLinks: answer.shareLinks,
    invitations: answer.invitations
  };
}

/**
 * Readies a project's members for its migration: makes (or renews) the
 * re-add invitation of every member with encryption set up whose
 * invitation is missing, expired, revoked or names another role, then says
 * where each member stands. A solo project answers with no members.
 */
export async function prepareMigrationMembers(
  ctx: InvitationContext,
  migrations: ProjectMigrationsApi,
  projectId: string,
  leaseId?: string | null
): Promise<MigrationSharing> {
  let answer = await migrations.members(projectId, leaseId);
  const at = (ctx.now ?? Date.now)();
  let invited = false;
  for (const record of answer.members) {
    if (record.readded || !record.hasKeys || !record.email) continue;
    if (usable(record, at)) continue;
    const signed = await signInvitationStatement(
      ctx,
      projectId,
      record.email,
      record.role
    );
    await migrations.invite(
      projectId,
      {
        memberUserId: record.userId,
        statement: signed.statement,
        signature: signed.signature
      },
      leaseId
    );
    invited = true;
  }
  if (invited) answer = await migrations.members(projectId, leaseId);
  return describeSharing(ctx, answer);
}

/** The members still to be re-added; throws unless every one is ready. */
export function requireMembersReady(sharing: MigrationSharing): void {
  const waiting = sharing.members.filter(
    (member) => member.state !== 'ready' && member.state !== 'readded'
  );
  if (waiting.length) throw new MigrationMembersNotReadyError(waiting);
}

/**
 * Re-adds every member not yet re-added, each by an Add Commit with their
 * current role and a Welcome (slice 5-3b's `addInvitedMember`, which checks
 * the statement, that the member is a verified contact and each claimed
 * KeyPackage). `ctx` writes through the staging's leased clients. Throws
 * {@link MigrationMembersNotReadyError} when a member is no longer ready.
 */
export async function readdMigrationMembers(
  ctx: InvitationContext,
  migrations: ProjectMigrationsApi,
  projectId: string,
  leaseId: string
): Promise<MigrationSharing> {
  const current = await describeSharing(
    ctx,
    await migrations.members(projectId, leaseId)
  );
  requireMembersReady(current);
  for (const member of current.members) {
    if (member.state !== 'ready') continue;
    await addInvitedMember(ctx, member.invitation!);
  }
  const after = await describeSharing(
    ctx,
    await migrations.members(projectId, leaseId)
  );
  if (after.members.some((member) => member.state !== 'readded')) {
    throw new ApiError(
      409,
      'A member could not be added back. Nothing was switched over; try again.',
      E2EE_MIGRATION_CODES.membersNotReady
    );
  }
  return after;
}

/**
 * Offers encrypted links in place of the plaintext ones the cutover
 * revoked (decision M8): one new encrypted link per revoked link, of the
 * same mode. Their URLs are new; whoever had the old ones needs the new.
 */
export async function reissuePlaintextShareLinks(
  ctx: ShareLinksContext,
  projectId: string,
  links: MigrationSharing['shareLinks']
): Promise<CreatedShareLink[]> {
  const created: CreatedShareLink[] = [];
  for (const link of links) {
    created.push(await createShareLink(ctx, projectId, link.mode));
  }
  return created;
}

/**
 * Invites again, to the encrypted project, everyone whose plaintext
 * invitation the cutover revoked, with the same role. One that fails is
 * reported; the rest still go out.
 */
export async function reinviteToEncryptedProject(
  ctx: InvitationContext,
  projectId: string,
  invitations: MigrationSharing['invitations']
): Promise<{ invited: string[]; failed: { email: string; error: unknown }[] }> {
  const invited: string[] = [];
  const failed: { email: string; error: unknown }[] = [];
  for (const invitation of invitations) {
    try {
      await inviteToEncryptedProject(
        ctx,
        projectId,
        invitation.email,
        invitation.role
      );
      invited.push(invitation.email);
    } catch (error) {
      failed.push({ email: invitation.email, error });
    }
  }
  return { invited, failed };
}
