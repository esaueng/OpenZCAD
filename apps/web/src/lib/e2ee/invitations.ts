/**
 * Invitations to end-to-end encrypted projects in the browser (ADR-024
 * Phase 5, slice 5-3b; roadmap L11), over the routes and Add gate of slice
 * 5-3a (`createE2eeInvitationsApi`).
 *
 * - **Owner: invite.** This device signs the invitation statement ("OZI":
 *   project, invitation id, owner, a hash of the invitee's email, the role,
 *   seven days of validity, this device and its key hash) and posts it
 *   with the email, which the Worker mails and forgets (it keeps the hash).
 *   This browser keeps the email for the pending list.
 * - **Invitee: accept, verify, publish.** Accepting binds the account; the
 *   invitee's browser checks the statement against the owner's device list
 *   and, once the owner is a verified contact (slice 5-1, the mutual
 *   comparison), each of its online certified devices makes a leaf for the
 *   project certified from the group's current epoch and publishes one
 *   KeyPackage (decision M3: every device that published one is added).
 * - **Invitee: sign the acceptance.** Before its KeyPackage, a device signs
 *   an acceptance ("OZJ"): the invitation, by the hash of its statement,
 *   and the account and identity accepting it as the recipient of the
 *   email hash the statement names. The Worker keeps it with the invitation.
 *   A device signs only for an invitation the person accepted on it: the
 *   emailed link opened there (`acceptEncryptedInvitation`), or the in-app
 *   confirmation that shows the inviter and role
 *   (`confirmEncryptedInvitation`). An invitation the server merely lists
 *   is never signed in the background: the server could list another
 *   person's invitation, and the signed-in email it reports is no check
 *   (nothing the account signs binds an email). The account's other
 *   devices publish KeyPackages once one of its devices signed.
 * - **Owner: verify and add.** The owner's next session lists accepted
 *   invitations: "waiting for keys" until KeyPackages arrive, "waiting for
 *   you to verify" until the invitee is a verified contact, "waiting for
 *   them to accept again" until a valid signed acceptance is there (one an
 *   older app version accepted has none). Only then, and only for a
 *   statement this account's device signed, are the KeyPackages claimed
 *   (once; kept locally until the Add lands), each checked (the invitee's
 *   account, a device of their verified list, its leaf certification), and
 *   one Add Commit with the statement's role travels with the Welcome and
 *   the owner's wraps of the new epoch (`addInvitee`). The account added is
 *   the one whose device signed the acceptance, never merely the one the
 *   server names; an account this browser saw removed from the project is
 *   added back only on the owner's explicit confirmation. That check runs
 *   again on every attempt of the Add Commit, after catching up, so a
 *   removal another device of the owner made meanwhile stops it; and a
 *   page that could not write a removal down adds nobody automatically.
 * - **Invitee: join.** A device whose KeyPackage was added joins by its
 *   Welcome, verifying the whole history (`joinProjectByWelcome`, #817),
 *   and posts its account's wraps of the joined epoch; the account's other
 *   devices rejoin by External Commit with the account-wrapped rejoin PSK
 *   (`joinProjectGroup`).
 *
 * Not here: role changes and removal (5-4, 5-5), and a recovery Add of a
 * lagging member device (no KeyPackage route outside invitations yet).
 */
import {
  decodeInvitationAcceptance,
  decodeProjectInvitation,
  fromBase64Url,
  invitationEmailHash,
  invitationStatementHash,
  MAX_PROJECT_INVITATION_LIFETIME_MS,
  publicKeyHash,
  signInvitationAcceptance,
  signProjectInvitation,
  toBase64Url,
  toHex,
  verifyInvitationAcceptance,
  verifyProjectInvitation,
  type InvitationAcceptance,
  type ProjectInvitation,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import {
  E2eeInvitationApiError,
  type E2eeInvitationRecord,
  type E2eeInvitationRole,
  type E2eeInvitationsApi,
  type E2eeKeyPackageRecord
} from '@openzcad/shared';
import type { AccountView } from './accountKeys';
import { inspectContact, loadContacts, type ContactsContext } from './contacts';
import { E2eeApiError } from './e2eeApi';
import {
  addInvitee,
  joinProjectByWelcome,
  type InviteeKeyPackage,
  type ProjectGroupContext,
  type ProjectGroupState
} from './projectGroups';
import type {
  InvitationIntent,
  InvitationStore,
  RemovedMember
} from './invitationStore';
import { rememberExpectedProjectOwner } from './projectAuthority';

// --- Context ----------------------------------------------------------------

/** One person as the contacts module (slice 5-1) sees them now. */
export interface InvitationPerson {
  readonly userId: string;
  readonly email: string | null;
  /** `verified` only for a verified contact whose key has not changed. */
  readonly status: 'verified' | 'seen' | 'no-keys';
  /** Their device list, checked against this browser's pins. */
  readonly list: VerifiedDeviceList | null;
}

export interface InvitationPeople {
  /** Null when the server will not look them up (no relation, M2). */
  inspect(userId: string): Promise<InvitationPerson | null>;
}

export interface InvitationContext {
  readonly groups: ProjectGroupContext;
  readonly api: E2eeInvitationsApi;
  readonly people: InvitationPeople;
  readonly store: InvitationStore;
  /** The signed-in account's email, for checking a statement's hash. */
  readonly email?: string | null;
  readonly now?: () => number;
}

/** `InvitationPeople` from the contacts module and this browser's pins. */
export function contactInvitationPeople(
  contacts: ContactsContext,
  account: AccountView
): InvitationPeople {
  return {
    async inspect(userId) {
      const book = await loadContacts(contacts, account);
      try {
        const view = await inspectContact(contacts, book, userId);
        return {
          userId,
          email: view.email,
          status:
            view.status === 'verified' && !view.keyChanged
              ? 'verified'
              : view.status === 'no-keys'
                ? 'no-keys'
                : 'seen',
          list: view.list
        };
      } catch (error) {
        if (error instanceof E2eeApiError && error.status === 404) return null;
        throw error;
      }
    }
  };
}

export type InvitationErrorCode =
  /** The invitee (or, for the invitee, the owner) is not a verified contact. */
  | 'not-verified'
  /** The statement does not verify, or is not this account's to complete. */
  | 'statement-invalid'
  /** A claimed KeyPackage is not the invitee's, or its leaf does not verify. */
  | 'key-package-invalid'
  /** No KeyPackage to add yet. */
  | 'no-key-packages'
  /** This browser has no certified device to sign or hold a leaf with. */
  | 'device-not-certified'
  /**
   * The invitee has no signed acceptance yet (an older app version
   * accepted): it comes once they open OpenZCAD again.
   */
  | 'acceptance-missing'
  /** The acceptance does not verify, or accepts something else. */
  | 'acceptance-invalid'
  /**
   * This account was removed from the project: adding it back takes the
   * owner's explicit confirmation (`confirmReAdd`).
   */
  | 'removed-member';

export class InvitationError extends Error {
  override readonly name = 'InvitationError';
  constructor(
    readonly code: InvitationErrorCode,
    message: string
  ) {
    super(message);
  }
}

const now = (ctx: InvitationContext) => (ctx.now ?? Date.now)();

function certifiedDevice(ctx: InvitationContext) {
  const device = ctx.groups.device;
  const listed = device
    ? ctx.groups.account.list.devices.find(
        (candidate) => candidate.deviceId === device.deviceId
      )
    : undefined;
  if (!device || !listed || device.userId !== ctx.groups.account.userId) {
    throw new InvitationError(
      'device-not-certified',
      'Only a device certified in your device list can sign invitations or join encrypted projects.'
    );
  }
  return { device, listed };
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}${toHex(bytes)}`;
}

const isApiError = (error: unknown, ...codes: string[]) =>
  (error instanceof E2eeInvitationApiError || error instanceof E2eeApiError) &&
  codes.includes(error.code ?? '');

/**
 * The statement of `record`, verified against `list` (the owner's device
 * list): signed by a device it certifies now, valid at `at`, and naming the
 * same project, invitation and owner as the record.
 */
async function verifiedStatement(
  record: E2eeInvitationRecord,
  list: VerifiedDeviceList,
  at: number,
  expected: { readonly inviteeEmail?: string | null } = {}
): Promise<ProjectInvitation> {
  const statement = fromBase64Url(record.statement);
  let decoded: ProjectInvitation;
  try {
    decoded = decodeProjectInvitation(statement);
  } catch {
    throw new InvitationError(
      'statement-invalid',
      'The invitation statement is malformed.'
    );
  }
  const signer = list.devices.find(
    (device) => device.deviceId === decoded.signerDeviceId
  );
  if (!signer || list.userId !== record.inviterUserId) {
    throw new InvitationError(
      'statement-invalid',
      'The invitation is not signed by a device of the project’s owner.'
    );
  }
  try {
    return await verifyProjectInvitation(
      { statement, signature: fromBase64Url(record.signature) },
      signer.signingKey,
      {
        now: at,
        expected: {
          projectId: record.projectId,
          invitationId: record.invitationId,
          inviterUserId: record.inviterUserId,
          ...(expected.inviteeEmail
            ? {
                inviteeEmailHash: await invitationEmailHash(
                  expected.inviteeEmail
                )
              }
            : {})
        }
      }
    );
  } catch (error) {
    throw new InvitationError(
      'statement-invalid',
      `The invitation statement does not verify: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The invitee's signed acceptance of `record`, verified against `list`
 * (their verified device list): signed by a device it certifies now, by the
 * account `record` says accepted and the identity `list` pins, for exactly
 * this invitation statement and the email hash `statement` names.
 */
async function verifiedAcceptance(
  record: E2eeInvitationRecord,
  statement: ProjectInvitation,
  list: VerifiedDeviceList
): Promise<InvitationAcceptance> {
  if (!record.acceptance) {
    throw new InvitationError(
      'acceptance-missing',
      'They have not confirmed this invitation on a device of theirs yet. It completes once they open OpenZCAD again.'
    );
  }
  const invalid = (why: string): never => {
    throw new InvitationError(
      'acceptance-invalid',
      `The invitee’s acceptance does not verify: ${why}`
    );
  };
  let signed: { statement: Uint8Array; signature: Uint8Array };
  let decoded: InvitationAcceptance;
  try {
    signed = {
      statement: fromBase64Url(record.acceptance.statement),
      signature: fromBase64Url(record.acceptance.signature)
    };
    decoded = decodeInvitationAcceptance(signed.statement);
  } catch {
    return invalid('it is malformed.');
  }
  const signer = list.devices.find(
    (device) => device.deviceId === decoded.signerDeviceId
  );
  if (!signer || list.userId !== record.acceptedByUserId) {
    return invalid('it is not signed by a device of the invitee.');
  }
  try {
    return await verifyInvitationAcceptance(signed, signer.signingKey, {
      projectId: record.projectId,
      invitationId: record.invitationId,
      invitationHash: await invitationStatementHash(
        fromBase64Url(record.statement)
      ),
      inviteeUserId: list.userId,
      inviteeIdentityKeyHash: list.identityKeyHash,
      inviteeEmailHash: statement.inviteeEmailHash
    });
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The accounts (per store) whose removal record this page failed to write.
 * Until the page reloads, its store cannot say who was removed, so the
 * sweep adds nobody of theirs and the owner confirms each Add.
 */
const unrecordedRemovals = new WeakMap<InvitationStore, Set<string>>();

/**
 * Records that `removal.userIds` left `removal.projectId` (the owner's
 * removal, before its Commit is sent, or a Commit this device processed):
 * the invitation sweep never adds them back. Awaited, so the record is
 * there before any Add this page builds next. A write that fails latches
 * this page into adding nobody automatically for the account (resolves
 * false); it never throws, since the removal itself must go ahead.
 */
export async function recordRemovedMembers(
  store: InvitationStore,
  accountUserId: string,
  removal: { readonly projectId: string; readonly userIds: readonly string[] },
  removedAt: number = Date.now()
): Promise<boolean> {
  let recorded = true;
  for (const userId of removal.userIds) {
    try {
      await store.rememberRemoved(accountUserId, {
        projectId: removal.projectId,
        userId,
        removedAt
      });
    } catch {
      recorded = false;
    }
  }
  if (!recorded) {
    const latched = unrecordedRemovals.get(store) ?? new Set<string>();
    latched.add(accountUserId);
    unrecordedRemovals.set(store, latched);
  }
  return recorded;
}

/**
 * The accounts this browser saw removed from projects, or null when its
 * store cannot say (a read or an earlier write failed): then everyone
 * counts as removed (fail closed), so the sweep adds nobody and the owner
 * confirms each Add.
 */
async function removedMembers(
  ctx: InvitationContext
): Promise<readonly RemovedMember[] | null> {
  const userId = ctx.groups.account.userId;
  if (unrecordedRemovals.get(ctx.store)?.has(userId)) return null;
  return ctx.store.removedMembers(userId).catch(() => null);
}

const isRemoved = (
  removed: readonly RemovedMember[] | null,
  projectId: string,
  memberUserId: string | null
) =>
  removed === null ||
  removed.some(
    (entry) => entry.projectId === projectId && entry.userId === memberUserId
  );

// --- Owner ------------------------------------------------------------------

/**
 * Invite `email` to an encrypted project this account owns, as `role`: this
 * device signs the statement, the Worker mails the link. The email stays in
 * this browser only.
 */
export async function inviteToEncryptedProject(
  ctx: InvitationContext,
  projectId: string,
  email: string,
  role: E2eeInvitationRole
): Promise<E2eeInvitationRecord> {
  const address = email.trim().toLowerCase();
  const signed = await signInvitationStatement(ctx, projectId, address, role);
  const { invitation } = await ctx.api.create(projectId, {
    email: address,
    statement: signed.statement,
    signature: signed.signature
  });
  await ctx.store
    .rememberEmail(ctx.groups.account.userId, {
      projectId,
      invitationId: invitation.invitationId,
      email: address
    })
    .catch(() => undefined);
  return invitation;
}

/**
 * This device signs an invitation statement for `email` as `role` (seven
 * days of validity), base64url-encoded with its signature. Shared by
 * {@link inviteToEncryptedProject} and slice 7-4's re-add invitations of
 * a shared plaintext project's existing members.
 */
export async function signInvitationStatement(
  ctx: InvitationContext,
  projectId: string,
  email: string,
  role: E2eeInvitationRole
): Promise<{ invitationId: string; statement: string; signature: string }> {
  const { device, listed } = certifiedDevice(ctx);
  const address = email.trim().toLowerCase();
  const issuedAt = now(ctx);
  const value: ProjectInvitation = {
    projectId,
    invitationId: randomId('inv_'),
    inviterUserId: ctx.groups.account.userId,
    inviteeEmailHash: await invitationEmailHash(address),
    role,
    issuedAt,
    expiresAt: issuedAt + MAX_PROJECT_INVITATION_LIFETIME_MS,
    signerDeviceId: device.deviceId,
    signerKeyHash: await publicKeyHash(listed.signingKey)
  };
  const signed = await signProjectInvitation(device.signing.privateKey, value);
  return {
    invitationId: value.invitationId,
    statement: toBase64Url(signed.statement),
    signature: toBase64Url(signed.signature)
  };
}

/** Where an invitation stands, as the owner's sharing dialog shows it. */
export type OwnerInvitationState =
  /** Sent; the invitee has not accepted it yet. */
  | 'invited'
  /** Accepted; no device of the invitee has published a KeyPackage yet. */
  | 'waiting-for-keys'
  /** KeyPackages are waiting; the invitee is not a verified contact yet. */
  | 'waiting-for-verification'
  /**
   * Verified, with KeyPackages, but no valid signed acceptance (an older
   * app version accepted): they need to open OpenZCAD again.
   */
  | 'needs-acceptance'
  /**
   * Verified and accepted, but removed from this project before (or this
   * page failed to write a removal down, so it cannot tell): only the
   * owner's explicit confirmation adds them.
   */
  | 'confirm-re-add'
  /** Verified, accepted, with KeyPackages: this browser adds them. */
  | 'ready'
  | 'completed'
  | 'revoked'
  | 'expired';

export interface OwnerInvitation {
  readonly record: E2eeInvitationRecord;
  readonly state: OwnerInvitationState;
  /** The address this browser sent it to, or the accepted invitee's. */
  readonly email: string | null;
}

function ownerState(
  record: E2eeInvitationRecord,
  at: number,
  standing: {
    readonly verified: boolean;
    readonly claimedHere: boolean;
    readonly accepted: boolean;
    readonly removed: boolean;
  }
): OwnerInvitationState {
  if (record.completedAt) return 'completed';
  if (record.revokedAt) return 'revoked';
  if (record.expiresAt <= at) return 'expired';
  if (!record.acceptedByUserId) return 'invited';
  const waiting =
    (record.keyPackages ?? 0) +
    (standing.claimedHere ? (record.claimedKeyPackages ?? 0) : 0);
  if (waiting === 0) return 'waiting-for-keys';
  if (!standing.verified) return 'waiting-for-verification';
  if (!standing.accepted) return 'needs-acceptance';
  return standing.removed ? 'confirm-re-add' : 'ready';
}

/**
 * Whether `record` carries a valid signed acceptance by `person`, for a
 * statement this account signed: what `addInvitedMember` checks again.
 */
async function acceptedBy(
  ctx: InvitationContext,
  record: E2eeInvitationRecord,
  person: InvitationPerson | null,
  at: number
): Promise<boolean> {
  if (!record.acceptance || person?.status !== 'verified' || !person.list) {
    return false;
  }
  try {
    const statement = await verifiedStatement(
      record,
      ctx.groups.account.list,
      at
    );
    await verifiedAcceptance(record, statement, person.list);
    return true;
  } catch {
    return false;
  }
}

async function describe(
  ctx: InvitationContext,
  records: readonly E2eeInvitationRecord[]
): Promise<OwnerInvitation[]> {
  const userId = ctx.groups.account.userId;
  const emails = new Map(
    (await ctx.store.emails(userId).catch(() => [])).map((entry) => [
      entry.invitationId,
      entry.email
    ])
  );
  const at = now(ctx);
  const removed = await removedMembers(ctx);
  const out: OwnerInvitation[] = [];
  for (const record of records) {
    // Only an open, accepted invitation needs the invitee's standing.
    const open =
      record.acceptedByUserId !== null &&
      !record.completedAt &&
      !record.revokedAt &&
      record.expiresAt > at;
    const person = open
      ? await ctx.people.inspect(record.acceptedByUserId!).catch(() => null)
      : null;
    const claimed = await ctx.store
      .claim(userId, record.invitationId)
      .catch(() => null);
    out.push({
      record,
      state: ownerState(record, at, {
        verified: person?.status === 'verified',
        claimedHere: claimed !== null,
        accepted: await acceptedBy(ctx, record, person, at),
        removed: isRemoved(removed, record.projectId, record.acceptedByUserId)
      }),
      email: emails.get(record.invitationId) ?? person?.email ?? null
    });
  }
  return out;
}

/** The project's invitations (owner only), with where each stands. */
export async function projectInvitations(
  ctx: InvitationContext,
  projectId: string
): Promise<OwnerInvitation[]> {
  const { invitations } = await ctx.api.list(projectId);
  return describe(ctx, invitations);
}

/**
 * The accepted invitations this account sent, across its projects, that
 * no Add completed: what the owner's next session verifies and completes.
 */
export async function sentInvitations(
  ctx: InvitationContext
): Promise<OwnerInvitation[]> {
  const { invitations } = await ctx.api.sent();
  return describe(ctx, invitations);
}

/**
 * Checks one claimed KeyPackage before it goes into an Add: the
 * invitation's invitee, a device their verified list certifies, a leaf
 * certification by that device for this project from no later than the
 * group's epoch, and the hash the Add will name. The MLS directory then
 * checks that the KeyPackage itself carries that leaf.
 */
async function checkedKeyPackage(
  ctx: InvitationContext,
  record: E2eeKeyPackageRecord,
  invitation: E2eeInvitationRecord,
  list: VerifiedDeviceList,
  groupEpoch: number
): Promise<InviteeKeyPackage> {
  const refuse = (why: string): never => {
    throw new InvitationError(
      'key-package-invalid',
      `A KeyPackage of the invitee ${why}. Nothing was added.`
    );
  };
  if (
    record.userId !== invitation.acceptedByUserId ||
    record.invitationId !== invitation.invitationId
  ) {
    refuse('names another account or invitation');
  }
  const signer = list.devices.find(
    (device) => device.deviceId === record.deviceId
  );
  if (!signer) refuse('comes from a device their device list does not certify');
  const keyPackage = fromBase64Url(record.keyPackage);
  const hash = toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(keyPackage))
    )
  );
  if (hash !== record.keyPackageHash) refuse('does not match its hash');
  const leafKey = fromBase64Url(record.leaf.leafKey);
  const certification = fromBase64Url(record.leaf.certification);
  const verified = await ctx.groups.sessions.verifyLeafCertification(
    {
      projectId: invitation.projectId,
      userId: record.userId,
      deviceId: record.deviceId,
      leafKey,
      certification
    },
    signer!.signingKey
  );
  if (!verified) refuse('carries a leaf its device did not certify');
  if (verified!.certifiedEpoch > groupEpoch) {
    refuse('is certified from an epoch the group has not reached');
  }
  return {
    deviceId: record.deviceId,
    keyPackage,
    keyPackageHash: hash,
    leafKey,
    certification
  };
}

/**
 * Add the invitee of one accepted invitation (owner only): the statement
 * must be this account's, signed by one of its certified devices and still
 * valid; the invitee must be a verified contact (an unverified one is never
 * added, whatever the server says) whose certified device signed an
 * acceptance of exactly this statement as the recipient of its email hash;
 * an account this browser saw removed from the project is added back only
 * with `confirmReAdd` (the owner's explicit action, never the sweep); their
 * KeyPackages are claimed once (or taken from this browser's earlier
 * claim), each checked, and added in one Commit with the statement's role.
 * The claim is dropped once the Add lands.
 */
export async function addInvitedMember(
  ctx: InvitationContext,
  invitation: E2eeInvitationRecord,
  options: { readonly confirmReAdd?: boolean } = {}
): Promise<ProjectGroupState> {
  const userId = ctx.groups.account.userId;
  certifiedDevice(ctx);
  if (invitation.inviterUserId !== userId) {
    throw new InvitationError(
      'statement-invalid',
      'Only the owner who signed an invitation completes it.'
    );
  }
  const statement = await verifiedStatement(
    invitation,
    ctx.groups.account.list,
    now(ctx)
  );
  const invitee = invitation.acceptedByUserId;
  if (!invitee) {
    throw new InvitationError(
      'no-key-packages',
      'The invitation has not been accepted yet.'
    );
  }
  const person = await ctx.people.inspect(invitee);
  if (!person || person.status !== 'verified' || !person.list) {
    throw new InvitationError(
      'not-verified',
      'Verify this person first: compare your codes with them in Settings › Encryption › Contacts.'
    );
  }
  // The account added is the one whose device accepted this statement.
  await verifiedAcceptance(invitation, statement, person.list);
  // Asked before claiming anything, and again on every attempt of the
  // Commit after catching up: a removal processed there stops the Add.
  const authorize = async () => {
    if (options.confirmReAdd) return;
    if (isRemoved(await removedMembers(ctx), invitation.projectId, invitee)) {
      throw new InvitationError(
        'removed-member',
        'This person was removed from the project. Confirm adding them back in the project’s sharing settings.'
      );
    }
  };
  await authorize();
  let claimed = await ctx.store
    .claim(userId, invitation.invitationId)
    .catch(() => null);
  if (!claimed) {
    const { keyPackages } = await ctx.api.claimKeyPackages(
      invitation.projectId,
      { invitationId: invitation.invitationId }
    );
    claimed = {
      projectId: invitation.projectId,
      invitationId: invitation.invitationId,
      keyPackages
    };
    await ctx.store.saveClaim(userId, claimed).catch(() => undefined);
  }
  const { group } = await ctx.groups.api.group(invitation.projectId);
  const keyPackages: InviteeKeyPackage[] = [];
  try {
    for (const record of claimed.keyPackages) {
      keyPackages.push(
        await checkedKeyPackage(
          ctx,
          record,
          invitation,
          person.list,
          group.epoch
        )
      );
    }
  } catch (error) {
    // Refused KeyPackages are never added: the invitee publishes new ones.
    await ctx.store
      .dropClaim(userId, invitation.invitationId)
      .catch(() => undefined);
    throw error;
  }
  let state: ProjectGroupState;
  try {
    state = await addInvitee(
      ctx.groups,
      invitation.projectId,
      {
        invitationId: invitation.invitationId,
        userId: invitee,
        role: statement.role,
        list: person.list,
        keyPackages
      },
      { authorize }
    );
  } catch (error) {
    // A claim the Worker no longer matches (the invitee republished, or the
    // invitation ended) is dropped: the next attempt claims afresh.
    if (
      isApiError(
        error,
        'E2EE_ADD_MISMATCH',
        'E2EE_INVITATION_UNAVAILABLE',
        'INVITATION_NOT_FOUND'
      )
    ) {
      await ctx.store
        .dropClaim(userId, invitation.invitationId)
        .catch(() => undefined);
    }
    throw error;
  }
  await ctx.store
    .dropClaim(userId, invitation.invitationId)
    .catch(() => undefined);
  if (options.confirmReAdd) {
    await ctx.store
      .forgetRemoved(userId, invitation.projectId, invitee)
      .catch(() => undefined);
  }
  return state;
}

/**
 * Add every invitee of `invitations` who is ready (verified, accepted by
 * signature, with KeyPackages, never removed from the project). One that
 * fails stays pending and is reported; the rest still go ahead.
 */
export async function completeReadyInvitations(
  ctx: InvitationContext,
  invitations: readonly OwnerInvitation[]
): Promise<{
  added: string[];
  failed: { invitationId: string; error: unknown }[];
}> {
  const added: string[] = [];
  const failed: { invitationId: string; error: unknown }[] = [];
  for (const invitation of invitations) {
    if (invitation.state !== 'ready') continue;
    try {
      await addInvitedMember(ctx, invitation.record);
      added.push(invitation.record.invitationId);
    } catch (error) {
      failed.push({ invitationId: invitation.record.invitationId, error });
    }
  }
  return { added, failed };
}

// --- Invitee ----------------------------------------------------------------

const statementHashOf = async (record: E2eeInvitationRecord) =>
  toHex(await invitationStatementHash(fromBase64Url(record.statement)));

/** Records that the person accepted `record` on this device. */
async function rememberIntent(
  ctx: Pick<InvitationContext, 'groups' | 'store' | 'now'>,
  record: E2eeInvitationRecord,
  source: InvitationIntent['source']
): Promise<void> {
  await ctx.store.rememberIntent(ctx.groups.account.userId, {
    projectId: record.projectId,
    invitationId: record.invitationId,
    inviterUserId: record.inviterUserId,
    statementHash: await statementHashOf(record),
    source,
    intendedAt: (ctx.now ?? Date.now)()
  });
}

/**
 * Accept the emailed link: binds this account (no membership yet), and
 * records on this device that the person accepted this invitation, which
 * is what lets this device sign the acceptance later. A record that cannot
 * be written leaves the in-app confirmation to do it.
 */
export async function acceptEncryptedInvitation(
  ctx: Pick<InvitationContext, 'api' | 'groups' | 'store' | 'now'>,
  token: string
): Promise<E2eeInvitationRecord> {
  const { invitation } = await ctx.api.accept({ token });
  await rememberIntent(ctx, invitation, 'link').catch(() => undefined);
  return invitation;
}

/**
 * The person's explicit confirmation, in this app, of an invitation listed
 * for their account that they did not open by link on this device (an
 * older app version accepted it, the owner's migration bound it, or it was
 * accepted on another device that has not signed): shown with the inviter
 * and role, it lets this device sign the acceptance of exactly the
 * statement shown.
 */
export async function confirmEncryptedInvitation(
  ctx: Pick<InvitationContext, 'groups' | 'store' | 'now'>,
  record: E2eeInvitationRecord
): Promise<void> {
  await rememberIntent(ctx, record, 'confirmed');
}

/** Where an accepted invitation stands for the invitee. */
export type InviteeInvitationState =
  /** Compare codes with the owner first (the mutual verification). */
  | 'verify-owner'
  /** The statement does not verify against the owner's device list. */
  | 'invalid'
  /** This device published its KeyPackage; the owner adds it next. */
  | 'waiting-for-owner'
  /**
   * Listed for this account, but not accepted on this device and signed by
   * none of its devices: the person confirms it here first (inviter and
   * role shown), or it is not theirs.
   */
  | 'confirm'
  /** The owner is verified; this device publishes its KeyPackage now. */
  | 'ready'
  /** This browser cannot hold a leaf (read-only or not set up). */
  | 'no-device';

export interface InviteeInvitation {
  readonly record: E2eeInvitationRecord;
  readonly state: InviteeInvitationState;
  readonly ownerEmail: string | null;
}

/**
 * How long a published KeyPackage counts as waiting before this device
 * publishes a new one (judgment): an owner's browser that claimed it and
 * never completed the Add left nothing to claim, and republishing replaces
 * an unconsumed KeyPackage and its claim.
 */
export const KEY_PACKAGE_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Invitations this device published a KeyPackage for, recently enough. */
async function recentlyPublished(
  ctx: InvitationContext,
  at: number
): Promise<Set<string>> {
  const device = ctx.groups.device;
  return new Set(
    (await ctx.store.published(ctx.groups.account.userId).catch(() => []))
      .filter(
        (entry) =>
          entry.deviceId === device?.deviceId &&
          at - entry.publishedAt < KEY_PACKAGE_REFRESH_MS
      )
      .map((entry) => entry.invitationId)
  );
}

/**
 * Whether the server holds a valid acceptance of exactly `record`'s
 * statement signed by a device of this account's verified `list`, for its
 * current identity: then one of its devices accepted it, and this device
 * only publishes its KeyPackage (the owner checks the signature again).
 */
async function acceptedHere(
  record: E2eeInvitationRecord,
  statement: ProjectInvitation,
  list: VerifiedDeviceList
): Promise<boolean> {
  if (!record.acceptance) return false;
  try {
    const signed = {
      statement: fromBase64Url(record.acceptance.statement),
      signature: fromBase64Url(record.acceptance.signature)
    };
    const value = decodeInvitationAcceptance(signed.statement);
    const signer = list.devices.find(
      (device) => device.deviceId === value.signerDeviceId
    );
    if (!signer) return false;
    await verifyInvitationAcceptance(signed, signer.signingKey, {
      projectId: record.projectId,
      invitationId: record.invitationId,
      invitationHash: await invitationStatementHash(
        fromBase64Url(record.statement)
      ),
      inviteeUserId: list.userId,
      inviteeIdentityKeyHash: list.identityKeyHash,
      inviteeEmailHash: statement.inviteeEmailHash
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the person accepted exactly `record`'s statement on this device
 * (the link they opened here, or the in-app confirmation).
 */
async function intendedHere(
  intents: readonly InvitationIntent[],
  record: E2eeInvitationRecord
): Promise<boolean> {
  const hash = await statementHashOf(record);
  return intents.some(
    (intent) =>
      intent.invitationId === record.invitationId &&
      intent.projectId === record.projectId &&
      intent.inviterUserId === record.inviterUserId &&
      intent.statementHash === hash
  );
}

const intentsOf = (ctx: InvitationContext) =>
  ctx.store
    .intents(ctx.groups.account.userId)
    .catch((): InvitationIntent[] => []);

/** The invitations this account accepted that no Add completed yet. */
export async function acceptedInvitations(
  ctx: InvitationContext
): Promise<InviteeInvitation[]> {
  const { invitations } = await ctx.api.accepted();
  const device = ctx.groups.device;
  const at = now(ctx);
  const published = await recentlyPublished(ctx, at);
  const intents = await intentsOf(ctx);
  const out: InviteeInvitation[] = [];
  for (const record of invitations) {
    const owner = await ctx.people
      .inspect(record.inviterUserId)
      .catch(() => null);
    let state: InviteeInvitationState;
    if (!owner?.list) state = 'invalid';
    else {
      try {
        const statement = await verifiedStatement(
          record,
          owner.list,
          now(ctx),
          { inviteeEmail: ctx.email ?? null }
        );
        if (owner.status !== 'verified') state = 'verify-owner';
        else if (!device) state = 'no-device';
        else {
          const accepted = await acceptedHere(
            record,
            statement,
            ctx.groups.account.list
          );
          state =
            !accepted && !(await intendedHere(intents, record))
              ? 'confirm'
              : published.has(record.invitationId) && accepted
                ? 'waiting-for-owner'
                : 'ready';
        }
      } catch {
        state = 'invalid';
      }
    }
    out.push({ record, state, ownerEmail: owner?.email ?? null });
  }
  return out;
}

/**
 * Publish this device's KeyPackage for every accepted invitation whose
 * owner is verified and whose statement verifies (each of the invitee's
 * online devices does this for itself, decision M3), after the signed
 * acceptance the owner checks before adding anyone. This device signs that
 * acceptance only for an invitation the person accepted on it (the link
 * opened here, or the in-app confirmation); one the server merely lists,
 * which no device of this account signed, is skipped: nothing is signed
 * or published for it. The leaf is certified from the group's current
 * epoch as the invitation reports it. An invitation this device already
 * published for, but without an acceptance (an older app version), only
 * gets its acceptance, after the same confirmation.
 */
export async function publishInvitationKeyPackages(
  ctx: InvitationContext,
  invitations?: readonly InviteeInvitation[]
): Promise<string[]> {
  const listed = invitations ?? (await acceptedInvitations(ctx));
  const ready = listed.filter((entry) => entry.state === 'ready');
  if (ready.length === 0) return [];
  const { device, listed: own } = certifiedDevice(ctx);
  const userId = ctx.groups.account.userId;
  const recent = await recentlyPublished(ctx, now(ctx));
  const intents = await intentsOf(ctx);
  const published: string[] = [];
  for (const { record } of ready) {
    // Callers may supply a cached listing. Recheck its signed, recipient-bound
    // intent and current contact pin before persisting the independent owner.
    const owner = await ctx.people.inspect(record.inviterUserId);
    if (owner?.status !== 'verified' || !owner.list || !ctx.email) {
      throw new InvitationError(
        'not-verified',
        'Verify the project owner and invitation recipient before joining.'
      );
    }
    const statement = await verifiedStatement(record, owner.list, now(ctx), {
      inviteeEmail: ctx.email
    });
    // Signed here only on the person's own intent on this device; without
    // it, only another device's valid acceptance lets this one publish.
    const accepted = await acceptedHere(
      record,
      statement,
      ctx.groups.account.list
    );
    if (!accepted && !(await intendedHere(intents, record))) continue;
    await rememberExpectedProjectOwner(
      ctx.groups,
      record.projectId,
      owner.list
    );
    if (!accepted) {
      const acceptance = await signInvitationAcceptance(
        device.signing.privateKey,
        {
          projectId: record.projectId,
          invitationId: record.invitationId,
          invitationHash: await invitationStatementHash(
            fromBase64Url(record.statement)
          ),
          inviteeUserId: userId,
          inviteeIdentityKeyHash: ctx.groups.account.list.identityKeyHash,
          inviteeEmailHash: statement.inviteeEmailHash,
          acceptedAt: now(ctx),
          signerDeviceId: device.deviceId,
          signerKeyHash: await publicKeyHash(own.signingKey)
        }
      );
      await ctx.api.publishAcceptance(record.projectId, record.invitationId, {
        statement: toBase64Url(acceptance.statement),
        signature: toBase64Url(acceptance.signature)
      });
    }
    if (recent.has(record.invitationId)) {
      // Published before, by an app version that signed no acceptance.
      published.push(record.invitationId);
      continue;
    }
    const ref = {
      userId,
      deviceId: device.deviceId,
      projectId: record.projectId
    };
    const keyPackage = await ctx.groups.sessions.keyPackage(
      ref,
      device,
      Math.max(0, record.groupEpoch ?? 0)
    );
    const leaf = (await ctx.groups.sessions.leaf(ref))!;
    try {
      await ctx.api.publishKeyPackage(record.projectId, {
        invitationId: record.invitationId,
        deviceId: device.deviceId,
        keyPackage: toBase64Url(keyPackage),
        leaf: {
          leafKey: toBase64Url(leaf.signatureKey),
          certification: toBase64Url(leaf.certification)
        }
      });
    } catch (error) {
      // Already added: nothing to publish, the Welcome waits.
      if (!isApiError(error, 'E2EE_KEY_PACKAGE_CONSUMED')) throw error;
    }
    await ctx.store
      .markPublished(userId, {
        projectId: record.projectId,
        invitationId: record.invitationId,
        deviceId: device.deviceId,
        publishedAt: now(ctx)
      })
      .catch(() => undefined);
    published.push(record.invitationId);
  }
  return published;
}

/**
 * Join every project this device published a KeyPackage for whose Welcome
 * has arrived. One that has none yet stays remembered; one that joined is
 * forgotten. Resolves to the project ids joined.
 */
export async function joinWelcomedProjects(
  ctx: InvitationContext
): Promise<string[]> {
  const device = ctx.groups.device;
  if (!device) return [];
  const userId = ctx.groups.account.userId;
  const joined: string[] = [];
  for (const entry of await ctx.store.published(userId).catch(() => [])) {
    if (entry.deviceId !== device.deviceId) continue;
    try {
      if (await joinProjectByWelcome(ctx.groups, entry.projectId)) {
        joined.push(entry.projectId);
        await ctx.store.dropPublished(userId, entry.projectId);
      }
    } catch {
      // Not added yet, or history to retry with: stays remembered.
    }
  }
  return joined;
}

/**
 * One pass of everything a session does about invitations: the invitee's
 * KeyPackages (only for invitations accepted on this device, or signed by
 * another of its devices) and Welcome joins, and the owner's ready Adds.
 * Each step is independent; failures are returned, not thrown.
 */
export async function syncInvitations(ctx: InvitationContext): Promise<{
  readonly incoming: InviteeInvitation[];
  readonly outgoing: OwnerInvitation[];
  readonly joined: string[];
  readonly added: string[];
  readonly errors: unknown[];
}> {
  const errors: unknown[] = [];
  let incoming: InviteeInvitation[] = [];
  let outgoing: OwnerInvitation[] = [];
  let joined: string[] = [];
  let added: string[] = [];
  try {
    incoming = await acceptedInvitations(ctx);
    if (
      await publishInvitationKeyPackages(ctx, incoming).then(
        (published) => published.length > 0
      )
    ) {
      incoming = await acceptedInvitations(ctx);
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    joined = await joinWelcomedProjects(ctx);
  } catch (error) {
    errors.push(error);
  }
  try {
    outgoing = await sentInvitations(ctx);
    const result = await completeReadyInvitations(ctx, outgoing);
    added = result.added;
    errors.push(...result.failed.map((failure) => failure.error));
    if (added.length) outgoing = await sentInvitations(ctx);
  } catch (error) {
    errors.push(error);
  }
  return { incoming, outgoing, joined, added, errors };
}
