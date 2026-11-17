/**
 * Invitations to end-to-end encrypted projects in the browser (ADR-024
 * Phase 5, slice 5-3b; roadmap L11), over the routes and Add gate of slice
 * 5-3a (`createE2eeInvitationsApi`).
 *
 * - **Owner: invite.** This device makes the emailed link's token and signs
 *   the invitation statement ("OZI" version 2: project, invitation id,
 *   owner, a hash of the invitee's email, the role, seven days of validity,
 *   this device and its key hash, and a hash of the link's token) and posts
 *   it with the email and token, which the Worker mails and forgets (it
 *   keeps hashes). This browser keeps the email for the pending list. Only
 *   when the owner explicitly picks a verified contact, shown by the
 *   contact code Contacts shows (`invitableContacts` offers those listed
 *   under the address typed; the label is the server's word), does the
 *   statement (version 3) also name that contact's identity key: only they
 *   are then added without asking. An address alone never binds anyone.
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
 *   emailed link opened there, when the statement the server answers with
 *   names that link's token (`acceptEncryptedInvitation`), or the in-app
 *   confirmation that shows the inviter, by the contact code Contacts
 *   shows for them, and the role and project the verified statement names
 *   (`confirmEncryptedInvitation`; a statement that names no link always
 *   needs it, and so does a link an older version recorded without its
 *   token). An invitation the server merely lists
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
 *   server names. The server delivers the email, so whoever accepted is
 *   added without asking only when the statement names their identity
 *   (the owner invited that verified contact) and this browser has seen
 *   every removal from the project since its group began; otherwise the
 *   owner confirms the contact who accepted, shown by the contact code
 *   Contacts shows (`confirm-add`), or declines. An account this browser
 *   saw removed from the project is added back only on the owner's
 *   explicit confirmation (`confirm-re-add`). That check runs
 *   again on every attempt of the Add Commit, after catching up, so a
 *   removal another device of the owner made meanwhile stops it. A Commit
 *   advances this browser's state of the project only inside a durable
 *   removal check that every tab reads (`invitationRemovalChecks`): until
 *   its removals are written down, no tab adds anyone to that project
 *   automatically.
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
  contactVerificationCode,
  decodeInvitationAcceptance,
  decodeProjectInvitation,
  fromBase64Url,
  invitationEmailHash,
  invitationLinkTokenHash,
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
  type ProjectGroupState,
  type RemovalChecks
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
  /**
   * The verified contacts Contacts lists under `email`. The address is the
   * server's label, so a match is only offered to the owner, by contact
   * code, never bound by itself.
   */
  verifiedContacts?(email: string): Promise<InvitationPerson[]>;
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
  const inspect = async (
    book: Awaited<ReturnType<typeof loadContacts>>,
    userId: string
  ): Promise<InvitationPerson | null> => {
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
  };
  return {
    async inspect(userId) {
      return inspect(await loadContacts(contacts, account), userId);
    },
    async verifiedContacts(email) {
      const address = email.trim().toLowerCase();
      const book = await loadContacts(contacts, account);
      const out: InvitationPerson[] = [];
      for (const contact of book.contacts) {
        if (
          contact.standing !== 'verified' ||
          contact.email?.trim().toLowerCase() !== address
        ) {
          continue;
        }
        const person = await inspect(book, contact.userId);
        if (person?.status === 'verified' && person.list) out.push(person);
      }
      return out;
    }
  };
}

/**
 * The contact code Contacts shows for `list` (their identity key with
 * their device-list head): how the invitations name a verified contact.
 */
export async function contactCodeOf(list: VerifiedDeviceList): Promise<string> {
  return (await contactVerificationCode(list.identityKey, list.headHash)).code;
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
   * owner's explicit confirmation (`confirmedIdentity`).
   */
  | 'removed-member'
  /**
   * The owner confirms this Add first (`confirmedIdentity`): the
   * invitation names no identity, or this browser has not seen every
   * removal from the project.
   */
  | 'needs-confirmation';

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
  // What the server lists beside the statement must be what it signs.
  if (record.role !== decoded.role) {
    throw new InvitationError(
      'statement-invalid',
      'The server lists another role than the invitation statement names.'
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
 * The accounts (per store) for which this page could not write a removal
 * record, or even the removal check before a Commit: until the page
 * reloads, the sweep adds nobody of theirs and the owner confirms each
 * Add. The durable, shared counterpart is the store's removal checks,
 * which every tab reads; this covers a store that cannot write at all.
 */
const unrecordedRemovals = new WeakMap<InvitationStore, Set<string>>();

function latchPage(store: InvitationStore, accountUserId: string): void {
  const latched = unrecordedRemovals.get(store) ?? new Set<string>();
  latched.add(accountUserId);
  unrecordedRemovals.set(store, latched);
}

/**
 * The removal checks of `accountUserId`'s owner pages in this browser
 * (`ProjectGroupContext.removalChecks`): a mark in the shared store before
 * a Commit advances a project's state, ended once its removals are
 * recorded. A mark that cannot be written latches this page and throws, so
 * the Commit is not processed or confirmed here.
 */
export function invitationRemovalChecks(
  store: InvitationStore,
  accountUserId: string
): RemovalChecks {
  return {
    async begin(projectId) {
      const checkId = randomId('chk_');
      try {
        await store.beginRemovalCheck(accountUserId, {
          projectId,
          checkId,
          startedAt: Date.now()
        });
      } catch {
        latchPage(store, accountUserId);
        throw new Error(
          'This browser could not note a change to the project before processing it, so it stopped. Reload and try again.'
        );
      }
      return {
        end: () => store.endRemovalCheck(accountUserId, projectId, checkId)
      };
    },
    async historyEstablished(projectId) {
      await store.establishRemovalHistory(accountUserId, {
        projectId,
        since: Date.now()
      });
    },
    async historyUnknown(projectId) {
      try {
        await store.forgetRemovalHistory(accountUserId, projectId);
      } catch {
        // A mark this browser cannot delete must not vouch for a history
        // it no longer saw whole: an open check stops every tab instead.
        latchPage(store, accountUserId);
        try {
          await store.beginRemovalCheck(accountUserId, {
            projectId,
            checkId: randomId('history_'),
            startedAt: Date.now()
          });
        } catch {
          throw new Error(
            'This browser could not note that it is joining the project from its history, so it stopped. Reload and try again.'
          );
        }
      }
    }
  };
}

/**
 * Records that `removal.userIds` left `removal.projectId` (the owner's
 * removal, before its Commit is sent, or a Commit this device processed):
 * the invitation sweep never adds them back. Awaited, so the record is
 * there before any Add this page builds next. A write that fails resolves
 * false and leaves a removal check open for the project in the shared
 * store, so no tab adds anyone to it automatically (and latches this page,
 * should even that write fail); it never throws, since the removal itself
 * must go ahead.
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
    await store
      .beginRemovalCheck(accountUserId, {
        projectId: removal.projectId,
        checkId: randomId('unrecorded_'),
        startedAt: removedAt
      })
      .catch(() => latchPage(store, accountUserId));
  }
  return recorded;
}

interface RemovalView {
  readonly removed: readonly RemovedMember[];
  /** Projects with an open removal check, in any tab of this browser. */
  readonly unsettled: ReadonlySet<string>;
  /** Projects whose every removal this browser saw (it made the group). */
  readonly known: ReadonlySet<string>;
}

/**
 * The accounts this browser saw removed from projects, the projects whose
 * removals may not be written down yet and those whose whole removal
 * history it saw, or null when its store cannot say (a read failed, or
 * this page could not write): then the sweep adds nobody and the owner
 * confirms each Add (fail closed).
 */
async function removedMembers(
  ctx: InvitationContext
): Promise<RemovalView | null> {
  const userId = ctx.groups.account.userId;
  if (unrecordedRemovals.get(ctx.store)?.has(userId)) return null;
  try {
    const [removed, checks, history] = await Promise.all([
      ctx.store.removedMembers(userId),
      ctx.store.removalChecks(userId),
      ctx.store.removalHistory(userId)
    ]);
    return {
      removed,
      unsettled: new Set(checks.map((check) => check.projectId)),
      known: new Set(history.map((mark) => mark.projectId))
    };
  } catch {
    return null;
  }
}

/**
 * How an Add of `memberUserId` to `projectId` may go ahead: `removed`
 * (this browser saw them removed: the owner confirms adding them back),
 * `confirm` (the owner confirms: the invitation names no identity, or this
 * browser cannot vouch that it saw every removal from the project), or
 * `automatic`.
 */
function addGate(
  view: RemovalView | null,
  projectId: string,
  memberUserId: string,
  bound: boolean
): 'removed' | 'confirm' | 'automatic' {
  if (
    view?.removed.some(
      (entry) => entry.projectId === projectId && entry.userId === memberUserId
    )
  ) {
    return 'removed';
  }
  return !bound ||
    view === null ||
    view.unsettled.has(projectId) ||
    !view.known.has(projectId)
    ? 'confirm'
    : 'automatic';
}

// --- Owner ------------------------------------------------------------------

/**
 * A verified contact the owner may invite by identity: named by the
 * contact code Contacts shows, which is what the owner checks. `email` is
 * the address Contacts lists them under, the server's word.
 */
export interface InvitableContact {
  readonly userId: string;
  /** Hex `publicKeyHash` of their identity key. */
  readonly identityKeyHash: string;
  readonly code: string;
  readonly email: string | null;
}

/**
 * The verified contacts listed under `email`, offered to the owner as an
 * explicit choice when inviting. The server labels contacts with their
 * addresses, so it could list another contact under this one: the owner
 * picks by contact code, and the default stays an email-only invitation.
 */
export async function invitableContacts(
  ctx: InvitationContext,
  email: string
): Promise<InvitableContact[]> {
  const address = email.trim().toLowerCase();
  if (!address || !ctx.people.verifiedContacts) return [];
  const people = await ctx.people.verifiedContacts(address).catch(() => []);
  const out: InvitableContact[] = [];
  for (const person of people) {
    if (person.status !== 'verified' || !person.list) continue;
    out.push({
      userId: person.userId,
      identityKeyHash: toHex(person.list.identityKeyHash),
      code: await contactCodeOf(person.list),
      email: person.email
    });
  }
  return out;
}

/**
 * Invite `email` to an encrypted project this account owns, as `role`: this
 * device signs the statement, the Worker mails the link. The email stays in
 * this browser only. Without `options.contact` the statement names no
 * identity, and the owner confirms whoever accepts. With it (the owner's
 * explicit pick of a verified contact, by the identity its code showed),
 * the statement names that identity key: only an acceptance by them is
 * added without the owner's confirmation.
 */
export async function inviteToEncryptedProject(
  ctx: InvitationContext,
  projectId: string,
  email: string,
  role: E2eeInvitationRole,
  options: {
    readonly contact?: {
      readonly userId: string;
      readonly identityKeyHash: string;
    };
  } = {}
): Promise<E2eeInvitationRecord> {
  const address = email.trim().toLowerCase();
  // The link's token is made here and signed into the statement, so the
  // invitee's browser can tell the server answered its link with it.
  const token = randomToken();
  let identity: Uint8Array | undefined;
  if (options.contact) {
    // The contact the owner picked, still verified with the very identity
    // the code they saw stood for.
    const person = await ctx.people.inspect(options.contact.userId);
    if (
      person?.status !== 'verified' ||
      !person.list ||
      toHex(person.list.identityKeyHash) !== options.contact.identityKeyHash
    ) {
      throw new InvitationError(
        'not-verified',
        'This contact changed since you picked them. Nothing was sent; check their code and try again.'
      );
    }
    identity = person.list.identityKeyHash;
  }
  const signed = await signInvitationStatement(ctx, projectId, address, role, {
    linkToken: token,
    ...(identity ? { inviteeIdentityKeyHash: identity } : {})
  });
  const { invitation } = await ctx.api.create(projectId, {
    email: address,
    statement: signed.statement,
    signature: signed.signature,
    token
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

/** An emailed link's token: 32 random bytes, base64url (43 characters). */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * This device signs an invitation statement for `email` as `role` (seven
 * days of validity), base64url-encoded with its signature: version 2,
 * naming `options.linkToken`'s hash, for an emailed invitation; version 1
 * without one; version 3 when `options.inviteeIdentityKeyHash` names the
 * verified contact invited. Shared by {@link inviteToEncryptedProject} and
 * slice 7-4's re-add invitations of a shared plaintext project's existing
 * members, which have no link (their members confirm in the app).
 */
export async function signInvitationStatement(
  ctx: InvitationContext,
  projectId: string,
  email: string,
  role: E2eeInvitationRole,
  options: {
    readonly linkToken?: string;
    readonly inviteeIdentityKeyHash?: Uint8Array;
  } = {}
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
    signerKeyHash: await publicKeyHash(listed.signingKey),
    ...(options.linkToken !== undefined
      ? { linkTokenHash: await invitationLinkTokenHash(options.linkToken) }
      : {}),
    ...(options.inviteeIdentityKeyHash !== undefined
      ? { inviteeIdentityKeyHash: options.inviteeIdentityKeyHash }
      : {})
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
   * Verified and accepted, but this browser saw them removed from this
   * project before: only the owner's explicit confirmation adds them back.
   */
  | 'confirm-re-add'
  /**
   * A verified contact accepted, with KeyPackages, but the invitation names
   * no identity (the server delivered the email), or this browser has not
   * seen every removal from the project: the owner confirms the contact
   * shown (`acceptor`) or declines.
   */
  | 'confirm-add'
  /**
   * The invitation names a verified contact, but another account accepted
   * it: never added. Revoke it and invite again.
   */
  | 'accepted-by-other'
  /**
   * Verified, accepted by the very contact the invitation names, with
   * KeyPackages, and every removal from the project seen here: this
   * browser adds them.
   */
  | 'ready'
  | 'completed'
  | 'revoked'
  | 'expired';

/**
 * The verified contact whose device signed an invitation's acceptance, as
 * the owner's confirmation names them: from their verified device list,
 * never from the server's listing.
 */
export interface InvitationAcceptor {
  readonly userId: string;
  /** Hex `publicKeyHash` of their identity key. */
  readonly identityKeyHash: string;
  /** Their contact code, as Contacts shows it. */
  readonly code: string;
  /** The address Contacts lists them under: the server's word. */
  readonly email: string | null;
}

export interface OwnerInvitation {
  readonly record: E2eeInvitationRecord;
  readonly state: OwnerInvitationState;
  /** The address this browser sent it to, or the accepted invitee's. */
  readonly email: string | null;
  /**
   * This account's statement, verified against its own device list: the
   * role and project a confirmation shows. Null when it does not verify.
   */
  readonly statement: ProjectInvitation | null;
  /** Who accepted, once their signed acceptance verifies; else null. */
  readonly acceptor: InvitationAcceptor | null;
}

function ownerState(
  record: E2eeInvitationRecord,
  at: number,
  standing: {
    readonly verified: boolean;
    readonly claimedHere: boolean;
    readonly accepted: boolean;
    readonly otherAccepted: boolean;
    readonly gate: ReturnType<typeof addGate>;
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
  if (standing.otherAccepted) return 'accepted-by-other';
  return standing.gate === 'removed'
    ? 'confirm-re-add'
    : standing.gate === 'confirm'
      ? 'confirm-add'
      : 'ready';
}

/**
 * `record`'s statement, when this account's device signed it, and the
 * verified contact `person` whose device signed a valid acceptance of it:
 * what `addInvitedMember` checks again.
 */
async function acceptedBy(
  ctx: InvitationContext,
  record: E2eeInvitationRecord,
  person: InvitationPerson | null,
  at: number
): Promise<{
  statement: ProjectInvitation | null;
  acceptor: InvitationAcceptor | null;
}> {
  let statement: ProjectInvitation;
  try {
    statement = await verifiedStatement(record, ctx.groups.account.list, at);
  } catch {
    return { statement: null, acceptor: null };
  }
  if (!record.acceptance || person?.status !== 'verified' || !person.list) {
    return { statement, acceptor: null };
  }
  try {
    await verifiedAcceptance(record, statement, person.list);
  } catch {
    return { statement, acceptor: null };
  }
  return {
    statement,
    acceptor: {
      userId: person.userId,
      identityKeyHash: toHex(person.list.identityKeyHash),
      code: await contactCodeOf(person.list),
      email: person.email
    }
  };
}

/**
 * `record`'s statement, when this account's device signed it, and the
 * verified contact whose device signed a valid acceptance of it (looked up
 * now): what the owner reviews before confirming an Add, as the migration
 * cutover's member approval does. `options.at` checks the statement's
 * validity at another time than now: when an Add completed it, for the
 * migration's review of a member already added (the signature is what
 * names them; freshness mattered when they were added).
 */
export async function reviewAcceptance(
  ctx: InvitationContext,
  record: E2eeInvitationRecord,
  options: { readonly at?: number } = {}
): Promise<{
  statement: ProjectInvitation | null;
  acceptor: InvitationAcceptor | null;
}> {
  const person = record.acceptedByUserId
    ? await ctx.people.inspect(record.acceptedByUserId).catch(() => null)
    : null;
  return acceptedBy(ctx, record, person, options.at ?? now(ctx));
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
    const { statement, acceptor } = await acceptedBy(ctx, record, person, at);
    const named = statement?.inviteeIdentityKeyHash;
    const bound =
      named !== undefined &&
      acceptor !== null &&
      toHex(named) === acceptor.identityKeyHash;
    out.push({
      record,
      state: ownerState(record, at, {
        verified: person?.status === 'verified',
        claimedHere: claimed !== null,
        accepted: acceptor !== null,
        otherAccepted: named !== undefined && acceptor !== null && !bound,
        gate: addGate(
          removed,
          record.projectId,
          record.acceptedByUserId ?? '',
          bound
        )
      }),
      email: emails.get(record.invitationId) ?? person?.email ?? null,
      statement,
      acceptor
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
 * acceptance of exactly this statement as the recipient of its email hash,
 * and, when the statement names an identity, with that identity.
 *
 * Without `confirmedIdentity` (the sweep), it goes ahead only for a
 * statement that names the accepting identity, in a project whose every
 * removal this browser saw, for an account it never saw removed from it
 * (`needs-confirmation`, `removed-member`). `confirmedIdentity` is the
 * owner's explicit confirmation of the hex identity key hash the
 * confirmation showed (`OwnerInvitation.acceptor`; the migration cutover
 * names each verified member's): the acceptance must be by exactly it.
 * `projectId`, when given, is the project the caller means to add to (the
 * migration's): both the record and its verified statement must name it,
 * or nothing is added. The KeyPackages are claimed once (or taken from
 * this browser's earlier claim), each checked, and added in one Commit
 * with the statement's role. The claim is dropped once the Add lands.
 */
export async function addInvitedMember(
  ctx: InvitationContext,
  invitation: E2eeInvitationRecord,
  options: {
    readonly confirmedIdentity?: string;
    readonly projectId?: string;
  } = {}
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
  if (
    options.projectId !== undefined &&
    (invitation.projectId !== options.projectId ||
      statement.projectId !== options.projectId)
  ) {
    throw new InvitationError(
      'statement-invalid',
      'The server offered an invitation to another project. Nothing was added.'
    );
  }
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
  const identity = toHex(person.list.identityKeyHash);
  const named = statement.inviteeIdentityKeyHash;
  if (named !== undefined && toHex(named) !== identity) {
    throw new InvitationError(
      'acceptance-invalid',
      'Someone other than the contact you invited accepted this invitation. Nothing was added.'
    );
  }
  const confirmed = options.confirmedIdentity;
  if (confirmed !== undefined && confirmed !== identity) {
    throw new InvitationError(
      'acceptance-invalid',
      'Someone other than the contact you confirmed accepted this invitation. Nothing was added.'
    );
  }
  // Asked before claiming anything, and again on every attempt of the
  // Commit after catching up: a removal processed there stops the Add.
  const authorize = async () => {
    if (confirmed !== undefined) return;
    const gate = addGate(
      await removedMembers(ctx),
      invitation.projectId,
      invitee,
      named !== undefined
    );
    if (gate === 'removed') {
      throw new InvitationError(
        'removed-member',
        'This person was removed from the project. Confirm adding them back in the project’s sharing settings.'
      );
    }
    if (gate === 'confirm') {
      throw new InvitationError(
        'needs-confirmation',
        'Confirm adding this person in the project’s sharing settings.'
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
  if (confirmed !== undefined) {
    await ctx.store
      .forgetRemoved(userId, invitation.projectId, invitee)
      .catch(() => undefined);
  }
  return state;
}

/**
 * The owner declines an accepted invitation (or revokes one): the Worker
 * closes it and drops its KeyPackages, and this browser forgets its claim.
 * Nobody is added.
 */
export async function declineInvitation(
  ctx: InvitationContext,
  projectId: string,
  invitationId: string
): Promise<void> {
  await ctx.api.revoke(projectId, invitationId);
  await ctx.store
    .dropClaim(ctx.groups.account.userId, invitationId)
    .catch(() => undefined);
}

/**
 * Add every invitee of `invitations` who is ready (verified, accepted by
 * signature by the contact the invitation names, with KeyPackages, in a
 * project whose every removal this browser saw, never removed from it).
 * Everyone else waits for the owner. One that fails stays pending and is
 * reported; the rest still go ahead.
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

/**
 * Records that the person accepted the invitation `statement` (decoded
 * from the bytes hashing to `statementHash`) on this device.
 */
async function rememberIntent(
  ctx: Pick<InvitationContext, 'groups' | 'store' | 'now'>,
  statement: ProjectInvitation,
  statementHash: string,
  source: InvitationIntent['source'],
  linkTokenHash?: string
): Promise<void> {
  await ctx.store.rememberIntent(ctx.groups.account.userId, {
    projectId: statement.projectId,
    invitationId: statement.invitationId,
    inviterUserId: statement.inviterUserId,
    statementHash,
    source,
    ...(linkTokenHash !== undefined ? { linkTokenHash } : {}),
    intendedAt: (ctx.now ?? Date.now)()
  });
}

/** What accepting an emailed link did on this device. */
export interface AcceptedLink {
  readonly invitation: E2eeInvitationRecord;
  /**
   * The statement names the link's token, so the person's intent is
   * recorded here. False for a version 1 statement (an older app's
   * invitation, which names no link): it is joined only once the person
   * confirms it in the app.
   */
  readonly linked: boolean;
}

/**
 * Accept the emailed link: binds this account (no membership yet) and,
 * when the owner-signed statement the server answers with names this
 * link's token, records on this device that the person accepted exactly
 * that statement, which is what lets this device sign the acceptance later
 * (after the statement's signature is checked against the owner's device
 * list). A statement that names another link is refused and nothing is
 * recorded: the server answered the link with another invitation. One that
 * names no link (version 1) is recorded neither; the in-app confirmation,
 * which shows what the verified statement says, does it. A record that
 * cannot be written leaves the confirmation to do it too.
 */
export async function acceptEncryptedInvitation(
  ctx: Pick<InvitationContext, 'api' | 'groups' | 'store' | 'now'>,
  token: string
): Promise<AcceptedLink> {
  const { invitation } = await ctx.api.accept({ token });
  let statement: ProjectInvitation;
  try {
    statement = decodeProjectInvitation(fromBase64Url(invitation.statement));
  } catch {
    throw new InvitationError(
      'statement-invalid',
      'The invitation statement is malformed.'
    );
  }
  if (
    statement.projectId !== invitation.projectId ||
    statement.invitationId !== invitation.invitationId ||
    statement.inviterUserId !== invitation.inviterUserId ||
    statement.role !== invitation.role
  ) {
    throw new InvitationError(
      'statement-invalid',
      'The server described this invitation differently from its signed statement.'
    );
  }
  if (!statement.linkTokenHash) return { invitation, linked: false };
  const opened = await invitationLinkTokenHash(token);
  if (toHex(opened) !== toHex(statement.linkTokenHash)) {
    throw new InvitationError(
      'statement-invalid',
      'The server answered this invitation link with another invitation. Nothing was accepted on this device.'
    );
  }
  const linked = await rememberIntent(
    ctx,
    statement,
    await statementHashOf(invitation),
    'link',
    toHex(opened)
  ).then(
    () => true,
    () => false
  );
  return { invitation, linked };
}

/**
 * The person's explicit confirmation, in this app, of an invitation listed
 * for their account that they did not open by link on this device (an
 * older app version or a version 1 statement, the owner's migration bound
 * it, or it was accepted on another device that has not signed). Takes the
 * listing the person reviewed: only an invitation in the `confirm` state,
 * whose statement verified against the owner's pinned device list, and it
 * records exactly the statement hash that listing verified and showed.
 */
export async function confirmEncryptedInvitation(
  ctx: Pick<InvitationContext, 'groups' | 'store' | 'now'>,
  reviewed: InviteeInvitation
): Promise<void> {
  if (
    reviewed.state !== 'confirm' ||
    !reviewed.statement ||
    !reviewed.statementHash
  ) {
    throw new InvitationError(
      'statement-invalid',
      'Only a verified invitation waiting for your confirmation can be joined.'
    );
  }
  await rememberIntent(
    ctx,
    reviewed.statement,
    reviewed.statementHash,
    'confirmed'
  );
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
  /** The server's word for the owner's address: never a trusted label. */
  readonly ownerEmail: string | null;
  /**
   * The owner-signed statement, verified against the owner's device list
   * and matching the record; null when it does not verify. What a Join
   * shows (role, project) comes from here, never from `record`.
   */
  readonly statement: ProjectInvitation | null;
  /** Hex `invitationStatementHash` of that statement; null with it. */
  readonly statementHash: string | null;
  /**
   * The owner's contact code, as Contacts shows it, from the device list
   * this browser checked (and compared codes over, once verified): how a
   * Join names the inviter. Null with `statement`.
   */
  readonly ownerCode: string | null;
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
 * Whether the person accepted exactly `record`'s statement on this device:
 * the in-app confirmation, or the link they opened here, which counts only
 * when `statement` names that very link's token. A link intent kept
 * without its token (an older version), or for a statement that names no
 * link, counts for nothing: that invitation needs the explicit Join.
 */
async function intendedHere(
  intents: readonly InvitationIntent[],
  record: E2eeInvitationRecord,
  statement: ProjectInvitation
): Promise<boolean> {
  const hash = await statementHashOf(record);
  const link =
    statement.linkTokenHash !== undefined
      ? toHex(statement.linkTokenHash)
      : null;
  return intents.some(
    (intent) =>
      intent.invitationId === record.invitationId &&
      intent.projectId === record.projectId &&
      intent.inviterUserId === record.inviterUserId &&
      intent.statementHash === hash &&
      (intent.source === 'confirmed' ||
        (intent.source === 'link' &&
          link !== null &&
          intent.linkTokenHash === link))
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
    let verified: ProjectInvitation | null = null;
    if (!owner?.list) state = 'invalid';
    else {
      try {
        const statement = await verifiedStatement(
          record,
          owner.list,
          now(ctx),
          { inviteeEmail: ctx.email ?? null }
        );
        verified = statement;
        if (owner.status !== 'verified') state = 'verify-owner';
        else if (!device) state = 'no-device';
        else {
          const accepted = await acceptedHere(
            record,
            statement,
            ctx.groups.account.list
          );
          state =
            !accepted && !(await intendedHere(intents, record, statement))
              ? 'confirm'
              : published.has(record.invitationId) && accepted
                ? 'waiting-for-owner'
                : 'ready';
        }
      } catch {
        state = 'invalid';
        verified = null;
      }
    }
    out.push({
      record,
      state,
      ownerEmail: owner?.email ?? null,
      statement: verified,
      statementHash: verified ? await statementHashOf(record) : null,
      ownerCode:
        verified && owner?.list ? await contactCodeOf(owner.list) : null
    });
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
    if (!accepted && !(await intendedHere(intents, record, statement))) {
      continue;
    }
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
