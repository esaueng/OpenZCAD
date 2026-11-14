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
 * - **Approval.** The server lists the members and labels them with their
 *   addresses, so a ready roster is shown to the owner first: each member's
 *   contact code (from the verified device list whose device signed the
 *   acceptance) and the role this account signed. Nothing is staged until
 *   the owner approves exactly that roster (`MigrationMemberApproval`), and
 *   the cutover stops and asks again if the roster, an identity or a role
 *   changed since.
 * - **Re-add.** Once the staging is complete, just before the cutover, the
 *   owner adds each member by Welcome with their current role, one Add
 *   Commit per member (`addInvitedMember`), under the migration lease, each
 *   confirmed as exactly the identity the owner approved. The Worker's
 *   cutover refuses unless every member was re-added this way.
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
  reviewAcceptance,
  signInvitationStatement,
  type InvitationAcceptor,
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
  /** The server's label: shown, never relied on. */
  readonly email: string | null;
  readonly role: 'editor' | 'viewer';
  readonly state: MigrationMemberState;
  readonly invitation: E2eeInvitationRecord | null;
  /**
   * Once `ready`: the verified contact whose device signed the acceptance,
   * with the contact code Contacts shows. What the owner approves.
   */
  readonly acceptor?: InvitationAcceptor | null;
  /** Once `ready`: the role the re-add statement this account signed names. */
  readonly signedRole?: 'editor' | 'viewer' | null;
}

/**
 * One member as the owner approved them for the cutover: the account, the
 * signed role and the identity (hex `publicKeyHash`) their code showed.
 */
export interface MigrationMemberApproval {
  readonly userId: string;
  readonly role: 'editor' | 'viewer';
  readonly identityKeyHash: string;
}

/** Client-side: the owner has not approved the ready roster as it is now. */
export const MIGRATION_APPROVAL_CODE = 'E2EE_MIGRATION_MEMBERS_UNAPPROVED';

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
      return `${who} needs to open OpenZCAD, compare codes with you, confirm your invitation (Settings › Encryption › Invitations) and stay signed in until their keys arrive.`;
    case 'verify':
      return `Compare codes with ${member.email ?? 'them'} in Settings › Encryption › Contacts.`;
    case 'ready':
      return 'Ready. Approve only if this is the code Contacts shows for them.';
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

/**
 * The owner has not approved the members about to be added back, or the
 * roster, an identity or a role changed since they did: nothing is staged
 * or switched over until they approve the roster shown now.
 */
export class MigrationApprovalNeededError extends Error {
  override readonly name = 'MigrationApprovalNeededError';
  readonly code = MIGRATION_APPROVAL_CODE;
  constructor(readonly changed: boolean) {
    super(
      changed
        ? 'The members changed since you approved them. Nothing was switched over; check them again.'
        : 'Check each member’s contact code and role below, then approve.'
    );
  }
}

/** The approval of `members` as shown: every ready member, by code. */
export function approvalOf(
  members: readonly MigrationMember[]
): MigrationMemberApproval[] {
  return members.flatMap((member) =>
    member.state === 'ready' && member.acceptor && member.signedRole
      ? [
          {
            userId: member.userId,
            role: member.signedRole,
            identityKeyHash: member.acceptor.identityKeyHash
          }
        ]
      : []
  );
}

/**
 * The owner's approval of each member still to be re-added, by account;
 * throws {@link MigrationApprovalNeededError} unless `approved` is exactly
 * the ready roster as it stands: the same accounts, each with the identity
 * and signed role approved (members already re-added are left out).
 */
export function requireMembersApproved(
  sharing: MigrationSharing,
  approved: readonly MigrationMemberApproval[] | undefined
): Map<string, MigrationMemberApproval> {
  const ready = sharing.members.filter((member) => member.state === 'ready');
  const byUser = new Map<string, MigrationMemberApproval>();
  if (!ready.length) return byUser;
  if (!approved) throw new MigrationApprovalNeededError(false);
  const readded = new Set(
    sharing.members
      .filter((member) => member.state === 'readded')
      .map((member) => member.userId)
  );
  for (const entry of approved) {
    if (readded.has(entry.userId)) continue;
    if (byUser.has(entry.userId)) throw new MigrationApprovalNeededError(true);
    byUser.set(entry.userId, entry);
  }
  if (byUser.size !== ready.length)
    throw new MigrationApprovalNeededError(true);
  for (const member of ready) {
    const entry = byUser.get(member.userId);
    if (
      !entry ||
      entry.role !== member.role ||
      entry.role !== member.signedRole ||
      entry.identityKeyHash !== member.acceptor?.identityKeyHash
    ) {
      throw new MigrationApprovalNeededError(true);
    }
  }
  return byUser;
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
): Promise<Pick<MigrationMember, 'state' | 'acceptor' | 'signedRole'>> {
  if (record.readded) return { state: 'readded' };
  if (!record.hasKeys) return { state: 'needs-encryption' };
  const invitation = usable(record, at);
  if (!invitation) return { state: 'needs-invitation' };
  if (
    (invitation.keyPackages ?? 0) + (invitation.claimedKeyPackages ?? 0) ===
      0 ||
    // Their browser signs an acceptance with its keys; an older one did not.
    !invitation.acceptance
  ) {
    return { state: 'waiting-for-keys' };
  }
  const person = await ctx.people.inspect(record.userId).catch(() => null);
  if (person?.status !== 'verified' || !person.list) return { state: 'verify' };
  // Ready only with what the owner approves: the verified contact whose
  // device signed the acceptance, and the role this account signed.
  const { statement, acceptor } = await reviewAcceptance(ctx, invitation);
  if (!statement || statement.role !== record.role) {
    return { state: 'needs-invitation' };
  }
  if (!acceptor || acceptor.userId !== record.userId) {
    return { state: 'waiting-for-keys' };
  }
  return { state: 'ready', acceptor, signedRole: statement.role };
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
      ...(await stateOf(ctx, record, at)),
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
 * KeyPackage), confirmed as exactly the identity the owner approved
 * (`approved`). `ctx` writes through the staging's leased clients. Throws
 * {@link MigrationMembersNotReadyError} when a member is no longer ready,
 * and {@link MigrationApprovalNeededError} when the roster, an identity or
 * a role is not the one approved.
 */
export async function readdMigrationMembers(
  ctx: InvitationContext,
  migrations: ProjectMigrationsApi,
  projectId: string,
  leaseId: string,
  approved: readonly MigrationMemberApproval[] | undefined
): Promise<MigrationSharing> {
  const current = await describeSharing(
    ctx,
    await migrations.members(projectId, leaseId)
  );
  requireMembersReady(current);
  const approvals = requireMembersApproved(current, approved);
  for (const member of current.members) {
    if (member.state !== 'ready') continue;
    // The owner approved this member by code and role: the Add confirms
    // exactly that identity, so someone this browser once saw removed is
    // added back too, and nobody the owner did not approve is.
    await addInvitedMember(ctx, member.invitation!, {
      confirmedIdentity: approvals.get(member.userId)!.identityKeyHash
    });
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
