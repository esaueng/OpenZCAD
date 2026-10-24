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
 * - **Owner: verify and add.** The owner's next session lists accepted
 *   invitations: "waiting for keys" until KeyPackages arrive, "waiting for
 *   you to verify" until the invitee is a verified contact. Only then, and
 *   only for a statement this account's device signed, are the KeyPackages
 *   claimed (once; kept locally until the Add lands), each checked (the
 *   invitee's account, a device of their verified list, its leaf
 *   certification), and one Add Commit with the statement's role travels
 *   with the Welcome and the owner's wraps of the new epoch
 *   (`addInvitee`).
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
  decodeProjectInvitation,
  fromBase64Url,
  invitationEmailHash,
  MAX_PROJECT_INVITATION_LIFETIME_MS,
  publicKeyHash,
  signProjectInvitation,
  toBase64Url,
  toHex,
  verifyProjectInvitation,
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
import type { InvitationStore } from './invitationStore';

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
  | 'device-not-certified';

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
  const { invitation } = await ctx.api.create(projectId, {
    email: address,
    statement: toBase64Url(signed.statement),
    signature: toBase64Url(signed.signature)
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

/** Where an invitation stands, as the owner's sharing dialog shows it. */
export type OwnerInvitationState =
  /** Sent; the invitee has not accepted it yet. */
  | 'invited'
  /** Accepted; no device of the invitee has published a KeyPackage yet. */
  | 'waiting-for-keys'
  /** KeyPackages are waiting; the invitee is not a verified contact yet. */
  | 'waiting-for-verification'
  /** Verified, with KeyPackages: this browser adds them. */
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
  verified: boolean,
  claimedHere: boolean
): OwnerInvitationState {
  if (record.completedAt) return 'completed';
  if (record.revokedAt) return 'revoked';
  if (record.expiresAt <= at) return 'expired';
  if (!record.acceptedByUserId) return 'invited';
  const waiting =
    (record.keyPackages ?? 0) +
    (claimedHere ? (record.claimedKeyPackages ?? 0) : 0);
  if (waiting === 0) return 'waiting-for-keys';
  return verified ? 'ready' : 'waiting-for-verification';
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
  const out: OwnerInvitation[] = [];
  for (const record of records) {
    const person = record.acceptedByUserId
      ? await ctx.people.inspect(record.acceptedByUserId).catch(() => null)
      : null;
    const claimed = await ctx.store
      .claim(userId, record.invitationId)
      .catch(() => null);
    out.push({
      record,
      state: ownerState(
        record,
        at,
        person?.status === 'verified',
        claimed !== null
      ),
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
 * added, whatever the server says); their KeyPackages are claimed once (or
 * taken from this browser's earlier claim), each checked, and added in one
 * Commit with the statement's role. The claim is dropped once the Add lands.
 */
export async function addInvitedMember(
  ctx: InvitationContext,
  invitation: E2eeInvitationRecord
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
  for (const record of claimed.keyPackages) {
    keyPackages.push(
      await checkedKeyPackage(ctx, record, invitation, person.list, group.epoch)
    );
  }
  let state: ProjectGroupState;
  try {
    state = await addInvitee(ctx.groups, invitation.projectId, {
      invitationId: invitation.invitationId,
      userId: invitee,
      role: statement.role,
      list: person.list,
      keyPackages
    });
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
  return state;
}

/**
 * Add every invitee of `invitations` who is ready (verified, with
 * KeyPackages). One that fails stays pending and is reported; the rest
 * still go ahead.
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

/** Accept the emailed link: binds this account; no membership yet. */
export async function acceptEncryptedInvitation(
  ctx: Pick<InvitationContext, 'api'>,
  token: string
): Promise<E2eeInvitationRecord> {
  return (await ctx.api.accept({ token })).invitation;
}

/** Where an accepted invitation stands for the invitee. */
export type InviteeInvitationState =
  /** Compare codes with the owner first (the mutual verification). */
  | 'verify-owner'
  /** The statement does not verify against the owner's device list. */
  | 'invalid'
  /** This device published its KeyPackage; the owner adds it next. */
  | 'waiting-for-owner'
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

/** The invitations this account accepted that no Add completed yet. */
export async function acceptedInvitations(
  ctx: InvitationContext
): Promise<InviteeInvitation[]> {
  const { invitations } = await ctx.api.accepted();
  const userId = ctx.groups.account.userId;
  const device = ctx.groups.device;
  const at = now(ctx);
  const published = new Set(
    (await ctx.store.published(userId).catch(() => []))
      .filter(
        (entry) =>
          entry.deviceId === device?.deviceId &&
          at - entry.publishedAt < KEY_PACKAGE_REFRESH_MS
      )
      .map((entry) => entry.invitationId)
  );
  const out: InviteeInvitation[] = [];
  for (const record of invitations) {
    const owner = await ctx.people
      .inspect(record.inviterUserId)
      .catch(() => null);
    let state: InviteeInvitationState;
    if (!owner?.list) state = 'invalid';
    else {
      try {
        await verifiedStatement(record, owner.list, now(ctx), {
          inviteeEmail: ctx.email ?? null
        });
        state =
          owner.status !== 'verified'
            ? 'verify-owner'
            : !device
              ? 'no-device'
              : published.has(record.invitationId)
                ? 'waiting-for-owner'
                : 'ready';
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
 * online devices does this for itself, decision M3). The leaf is certified
 * from the group's current epoch as the invitation reports it.
 */
export async function publishInvitationKeyPackages(
  ctx: InvitationContext,
  invitations?: readonly InviteeInvitation[]
): Promise<string[]> {
  const listed = invitations ?? (await acceptedInvitations(ctx));
  const ready = listed.filter((entry) => entry.state === 'ready');
  if (ready.length === 0) return [];
  const { device } = certifiedDevice(ctx);
  const userId = ctx.groups.account.userId;
  const published: string[] = [];
  for (const { record } of ready) {
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
 * KeyPackages and Welcome joins, and the owner's ready Adds. Each step is
 * independent; failures are returned, not thrown.
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
