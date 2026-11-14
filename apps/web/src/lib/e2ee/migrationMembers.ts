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
 *   changed since. Every member counts: one listed for the migration only
 *   with an invitation to (or a statement naming) another project is not
 *   ready, and is refused again just before the Add.
 * - **Resuming a staging.** The approval covers the whole staged roster,
 *   members already re-added included: a staging resumed after a reload
 *   (or one an older app version staged, which re-added members without
 *   asking) goes on to the cutover only with the owner's approval of every
 *   member, given now or recorded by this browser for that same staging
 *   (`MigrationApprovalReceipt`). A member re-added without a signed
 *   acceptance the owner can review drops the staging, which starts again.
 * - **The staged group.** The roster that counts is the staged MLS group's,
 *   not the server's listing (`stagedGroupMembers`): before a resumed
 *   staging is written to, and again just before the cutover, everyone in
 *   the group besides the owner must be an approved identity with the
 *   approved role (`stagedGroupApproved`), or the staging starts again. A
 *   member an older staging re-added and the listing leaves out is no
 *   exception.
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
  type E2eeMigrationMembersResponse,
  type E2eeProjectMigrationRecord
} from '@openzcad/shared';
import { toHex } from '@openzcad/crypto';
import { ApiError } from '../api';
import {
  addInvitedMember,
  inviteToEncryptedProject,
  reviewAcceptance,
  signInvitationStatement,
  type InvitationAcceptor,
  type InvitationContext
} from './invitations';
import { catchUpProjectGroup } from './projectGroups';
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
   * Once `ready` (or `readded`, when the acceptance still verifies): the
   * verified contact whose device signed the acceptance, with the contact
   * code Contacts shows. What the owner approves.
   */
  readonly acceptor?: InvitationAcceptor | null;
  /**
   * Once `ready` (or `readded`, likewise): the role the re-add statement
   * this account signed names.
   */
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

/**
 * The owner's approval of a staging's roster, as this browser recorded it
 * when the staging went ahead with it: bound to the project and the
 * staging (its attempt counter and `startedAt`), with each approved
 * account, identity and signed role. Kept on this device only (the server
 * never sees or supplies it), so a reload resumes that staging without
 * asking again, while a staging this browser did not approve (another, or
 * an older app version's) asks.
 */
export interface MigrationApprovalReceipt {
  readonly projectId: string;
  /**
   * The staging's attempt counter (migration 0053), or null from a Worker
   * without one. Two stagings may share a start time, never a counter: a
   * receipt counts only for the staging whose counter and start it names
   * (#1465 review), so one kept without a counter (an older app's, or from
   * before migration 0053) never counts for a staging that has one.
   */
  readonly stagingAttempt: number | null;
  readonly stagingStartedAt: string;
  readonly members: readonly MigrationMemberApproval[];
}

/**
 * Whether `receipt` was recorded for exactly the staging `migration` is:
 * the same counter (or neither has one) and the same start.
 */
export function isReceiptFor(
  receipt: MigrationApprovalReceipt,
  migration: Pick<E2eeProjectMigrationRecord, 'attempt' | 'startedAt'>
): boolean {
  return (
    receipt.stagingStartedAt === migration.startedAt &&
    receipt.stagingAttempt === (migration.attempt ?? null)
  );
}

export interface MigrationApprovalReceipts {
  get(projectId: string): MigrationApprovalReceipt | null;
  set(receipt: MigrationApprovalReceipt): void;
  delete(projectId: string): void;
}

export function memoryApprovalReceipts(): MigrationApprovalReceipts {
  const receipts = new Map<string, MigrationApprovalReceipt>();
  return {
    get: (projectId) => receipts.get(projectId) ?? null,
    set: (receipt) => void receipts.set(receipt.projectId, receipt),
    delete: (projectId) => void receipts.delete(projectId)
  };
}

const HEX_HASH = /^[0-9a-f]{64}$/;

/** A stored receipt, or null when it is not one (never trusted half-read). */
export function parseApprovalReceipt(
  value: unknown,
  projectId: string
): MigrationApprovalReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Record<string, unknown>;
  // Absent in a receipt from before the counter: read as none, which then
  // matches only a staging without one.
  const stagingAttempt = receipt.stagingAttempt ?? null;
  if (
    receipt.projectId !== projectId ||
    (stagingAttempt !== null &&
      !(
        typeof stagingAttempt === 'number' &&
        Number.isSafeInteger(stagingAttempt) &&
        stagingAttempt >= 1
      )) ||
    typeof receipt.stagingStartedAt !== 'string' ||
    !receipt.stagingStartedAt ||
    !Array.isArray(receipt.members)
  ) {
    return null;
  }
  const members: MigrationMemberApproval[] = [];
  for (const entry of receipt.members as unknown[]) {
    if (!entry || typeof entry !== 'object') return null;
    const { userId, role, identityKeyHash } = entry as Record<string, unknown>;
    if (
      typeof userId !== 'string' ||
      !userId ||
      (role !== 'editor' && role !== 'viewer') ||
      typeof identityKeyHash !== 'string' ||
      !HEX_HASH.test(identityKeyHash)
    ) {
      return null;
    }
    members.push({ userId, role, identityKeyHash });
  }
  return {
    projectId,
    stagingAttempt,
    stagingStartedAt: receipt.stagingStartedAt,
    members
  };
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

/** The members of the roster the owner approves: ready or re-added. */
const inRoster = (member: MigrationMember) =>
  member.state === 'ready' || member.state === 'readded';

/**
 * The approval of `members` as shown: every ready or re-added member, by
 * code.
 */
export function approvalOf(
  members: readonly MigrationMember[]
): MigrationMemberApproval[] {
  return members.flatMap((member) =>
    inRoster(member) && member.acceptor && member.signedRole
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
 * Members re-added to the staged group whom the owner cannot review: no
 * acceptance by a verified contact that still verifies (an older app
 * version re-added them without one). Their staging is dropped and staged
 * again, so they are added only once approved.
 */
export function unconfirmedReadds(
  sharing: MigrationSharing
): MigrationMember[] {
  return sharing.members.filter(
    (member) =>
      member.state === 'readded' && (!member.acceptor || !member.signedRole)
  );
}

/**
 * The owner's approval of each member of the staged roster (ready, or
 * already re-added), by account; throws
 * {@link MigrationApprovalNeededError} unless `approved` (the owner's,
 * given now) or else `receipt` (what this browser recorded for this
 * staging) is exactly the roster as it stands: the same accounts, each
 * with the identity and signed role approved.
 */
export function requireMembersApproved(
  sharing: MigrationSharing,
  approved: readonly MigrationMemberApproval[] | undefined,
  receipt: readonly MigrationMemberApproval[] | null = null
): Map<string, MigrationMemberApproval> {
  const roster = sharing.members.filter(inRoster);
  if (!roster.length) return new Map();
  const matching = (entries: readonly MigrationMemberApproval[]) => {
    const byUser = new Map<string, MigrationMemberApproval>();
    for (const entry of entries) {
      if (byUser.has(entry.userId)) return null;
      byUser.set(entry.userId, entry);
    }
    if (byUser.size !== roster.length) return null;
    for (const member of roster) {
      const entry = byUser.get(member.userId);
      if (
        !entry ||
        !member.acceptor ||
        !member.signedRole ||
        entry.role !== member.role ||
        entry.role !== member.signedRole ||
        entry.identityKeyHash !== member.acceptor.identityKeyHash
      ) {
        return null;
      }
    }
    return byUser;
  };
  const given = approved ?? receipt;
  if (!given) throw new MigrationApprovalNeededError(false);
  const byUser = matching(given);
  if (!byUser) throw new MigrationApprovalNeededError(true);
  return byUser;
}

/**
 * One account other than the owner's that holds a leaf in the staged MLS
 * group, as the group's authenticated state names it: the role in the
 * group's roles extension, and the identity of the verified contact whose
 * pinned device list certifies every one of its leaves (null when it is not
 * a verified contact, a leaf's device is not on that list, or the group
 * gives it no member role).
 */
export interface StagedGroupMember {
  readonly userId: string;
  readonly role: 'editor' | 'viewer' | null;
  readonly identityKeyHash: string | null;
}

/**
 * Who the staged group holds besides the owner, from this device's own
 * MLS state of it once caught up with every Commit the sequencer accepted
 * (another of the owner's devices, or an older app version, may have
 * added someone). Never the server's member listing: one that leaves out a
 * member re-added earlier does not hide them here. Null when this device
 * cannot read the group's state (no certified device, no session, a group
 * it cannot catch up with): the staged roster is then unknown.
 */
export async function stagedGroupMembers(
  ctx: InvitationContext,
  projectId: string
): Promise<StagedGroupMember[] | null> {
  const groups = ctx.groups;
  const device = groups.device;
  const ownerId = groups.account.userId;
  if (!device || device.userId !== ownerId) return null;
  try {
    await catchUpProjectGroup(groups, projectId);
    const status = await groups.sessions.status({
      userId: ownerId,
      deviceId: device.deviceId,
      projectId
    });
    if (!status.inGroup || status.removed || !status.roles) return null;
    const leaves = new Map<string, string[]>();
    for (const leaf of status.members) {
      if (leaf.userId === ownerId) continue;
      leaves.set(leaf.userId, [
        ...(leaves.get(leaf.userId) ?? []),
        leaf.deviceId
      ]);
    }
    const members: StagedGroupMember[] = [];
    for (const [userId, devices] of leaves) {
      const held = status.roles.users.find((entry) => entry.userId === userId);
      const role =
        held?.role === 'editor' || held?.role === 'viewer' ? held.role : null;
      const person = await ctx.people.inspect(userId).catch(() => null);
      const list =
        person?.status === 'verified' && person.userId === userId
          ? person.list
          : null;
      const certified =
        !!list &&
        list.userId === userId &&
        devices.every((deviceId) =>
          list.devices.some((listed) => listed.deviceId === deviceId)
        );
      members.push({
        userId,
        role,
        identityKeyHash: certified ? toHex(list.identityKeyHash) : null
      });
    }
    return members;
  } catch {
    return null;
  }
}

/**
 * Whether the staged group holds nobody the owner did not approve: every
 * account in it besides the owner's is an approved account, by the
 * approved identity and with the approved role. With `complete` (just
 * before the cutover), every approved account must also be in it.
 * `group` null (unreadable) never passes.
 */
export function stagedGroupApproved(
  group: readonly StagedGroupMember[] | null,
  approved: ReadonlyMap<string, MigrationMemberApproval>,
  complete = false
): boolean {
  if (!group) return false;
  for (const member of group) {
    const entry = approved.get(member.userId);
    if (
      !entry ||
      !member.role ||
      !member.identityKeyHash ||
      member.role !== entry.role ||
      member.identityKeyHash !== entry.identityKeyHash
    ) {
      return false;
    }
  }
  if (complete) {
    const present = new Set(group.map((member) => member.userId));
    for (const userId of approved.keys()) {
      if (!present.has(userId)) return false;
    }
  }
  return true;
}

/**
 * The member's live re-add invitation to `projectId`: one the server
 * lists for another project is not theirs to be added by here.
 */
const usable = (
  projectId: string,
  record: E2eeMigrationMemberRecord,
  at: number
): E2eeInvitationRecord | null => {
  const invitation = record.invitation;
  return invitation &&
    invitation.projectId === projectId &&
    !invitation.completedAt &&
    !invitation.revokedAt &&
    invitation.expiresAt > at &&
    invitation.role === record.role &&
    invitation.acceptedByUserId === record.userId
    ? invitation
    : null;
};

/**
 * Who a re-added member was added as: the verified contact whose device
 * signed the acceptance of the re-add statement this account signed for
 * `projectId` with their role, checked as of the Add (when it completed).
 * Nothing when it does not verify (an older app version's re-add, which
 * had no acceptance).
 */
async function readdedAs(
  ctx: InvitationContext,
  projectId: string,
  record: E2eeMigrationMemberRecord
): Promise<Pick<MigrationMember, 'acceptor' | 'signedRole'>> {
  const invitation = record.invitation;
  if (
    !invitation?.completedAt ||
    invitation.projectId !== projectId ||
    invitation.acceptedByUserId !== record.userId
  ) {
    return {};
  }
  const completed = Date.parse(invitation.completedAt);
  const { statement, acceptor } = await reviewAcceptance(
    ctx,
    invitation,
    Number.isFinite(completed) ? { at: completed } : {}
  ).catch(() => ({ statement: null, acceptor: null }));
  if (
    !statement ||
    statement.projectId !== projectId ||
    statement.role !== record.role ||
    !acceptor ||
    acceptor.userId !== record.userId
  ) {
    return {};
  }
  return { acceptor, signedRole: statement.role };
}

async function stateOf(
  ctx: InvitationContext,
  projectId: string,
  record: E2eeMigrationMemberRecord,
  at: number
): Promise<Pick<MigrationMember, 'state' | 'acceptor' | 'signedRole'>> {
  if (record.readded) {
    return { state: 'readded', ...(await readdedAs(ctx, projectId, record)) };
  }
  if (!record.hasKeys) return { state: 'needs-encryption' };
  const invitation = usable(projectId, record, at);
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
  if (
    !statement ||
    statement.projectId !== projectId ||
    statement.role !== record.role
  ) {
    return { state: 'needs-invitation' };
  }
  if (!acceptor || acceptor.userId !== record.userId) {
    return { state: 'waiting-for-keys' };
  }
  return { state: 'ready', acceptor, signedRole: statement.role };
}

async function describeSharing(
  ctx: InvitationContext,
  projectId: string,
  answer: E2eeMigrationMembersResponse
): Promise<MigrationSharing> {
  const at = (ctx.now ?? Date.now)();
  const members: MigrationMember[] = [];
  for (const record of answer.members) {
    members.push({
      userId: record.userId,
      email: record.email,
      role: record.role,
      ...(await stateOf(ctx, projectId, record, at)),
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
    if (usable(projectId, record, at)) continue;
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
  return describeSharing(ctx, projectId, answer);
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
 * (`approved`, or this staging's `receipt`), the whole staged roster
 * included. `ctx` writes through the staging's leased clients. Throws
 * {@link MigrationMembersNotReadyError} when a member is no longer ready,
 * and {@link MigrationApprovalNeededError} when the roster, an identity or
 * a role is not the one approved. Each Add is to `projectId` only: an
 * invitation to another project is refused.
 */
export async function readdMigrationMembers(
  ctx: InvitationContext,
  migrations: ProjectMigrationsApi,
  projectId: string,
  leaseId: string,
  approved: readonly MigrationMemberApproval[] | undefined,
  receipt: readonly MigrationMemberApproval[] | null = null
): Promise<MigrationSharing> {
  const current = await describeSharing(
    ctx,
    projectId,
    await migrations.members(projectId, leaseId)
  );
  requireMembersReady(current);
  const approvals = requireMembersApproved(current, approved, receipt);
  for (const member of current.members) {
    if (member.state !== 'ready') continue;
    // The owner approved this member by code and role: the Add confirms
    // exactly that identity, so someone this browser once saw removed is
    // added back too, and nobody the owner did not approve is. It adds to
    // this project only, whatever the server's record names.
    await addInvitedMember(ctx, member.invitation!, {
      confirmedIdentity: approvals.get(member.userId)!.identityKeyHash,
      projectId
    });
  }
  const after = await describeSharing(
    ctx,
    projectId,
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
