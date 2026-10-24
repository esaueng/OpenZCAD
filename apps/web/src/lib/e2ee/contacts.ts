import {
  E2eeError,
  contactDeviceListPin,
  contactVerificationCode,
  contactsEntryHash,
  fromBase64Url,
  fromHex,
  identityFingerprint,
  isE2eeError,
  nextContactsEntry,
  signContactsEntry,
  toBase64Url,
  toHex,
  verifyContactsList,
  verifyDeviceList,
  type Bytes,
  type ContactsChange,
  type DeviceListPin,
  type SignedContactsEntry,
  type SignedDeviceListEntry,
  type VerifiedContactsList,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeAppendContactsRequest,
  E2eeContactDeviceListResponse,
  E2eeContactPerson,
  E2eeContactsEntryRecord,
  E2eeContactsResponse
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import {
  withIdentityKey,
  type AccountView,
  type E2eeContext,
  type UnlockAuthorization
} from './accountKeys';
import { callE2eeRoute, type E2eeFetch } from './e2eeApi';
import {
  contactPins,
  type ContactPin,
  type ContactPinStore
} from './contactPins';

/**
 * Contacts and verified pins in the browser (ADR-024 Phase 5, slice 5-1).
 *
 * Two kinds of pin for other people's keys:
 *
 * - **Seen**: what this browser was shown, kept locally (`contactPins.ts`).
 *   Displayed with a warning; never a key to wrap a project key to.
 * - **Verified**: the user compared the contact's code (their identity key
 *   with their current device-list head) outside OpenZCAD, by digit groups
 *   or QR, and signed it into their contacts list with the identity key
 *   (a passkey or the recovery key). The list is identity-signed and
 *   hash-chained; every browser pins its newest entry, so the server cannot
 *   roll a verification back to a key that was since replaced.
 *
 * A contact's device list must extend both the head the signed list pinned
 * for them and the newest head this browser accepted, or it is refused as a
 * rollback or fork. A verified contact whose identity key changed drops back
 * to seen at once (`keyChanged`); the browser keeps that downgrade until the
 * user signs the key change, and only a verified contact yields a key to
 * wrap to (`verifiedEncryptionKey`).
 */

export interface ContactsApi {
  contacts(): Promise<E2eeContactsResponse>;
  appendContacts(
    request: E2eeAppendContactsRequest
  ): Promise<E2eeContactsResponse>;
  deviceList(userId: string): Promise<E2eeContactDeviceListResponse>;
}

export function createContactsApi(
  fetcher: E2eeFetch = desktopFetch
): ContactsApi {
  return {
    contacts: () => callE2eeRoute(fetcher, '/api/e2ee/contacts'),
    appendContacts: (request) =>
      callE2eeRoute(fetcher, '/api/e2ee/contacts', 'POST', request),
    deviceList: (userId) =>
      callE2eeRoute(
        fetcher,
        `/api/e2ee/users/${encodeURIComponent(userId)}/device-list`
      )
  };
}

export type ContactsErrorCode =
  /** The server showed an older or forked list than this browser accepted. */
  | 'fork'
  /** What the server returned does not verify. */
  | 'invalid'
  /** The account's keys changed meanwhile; reload. */
  | 'stale'
  /** The contact has no keys, or no verified key to act on. */
  | 'not-verifiable';

export class ContactsError extends Error {
  constructor(
    readonly code: ContactsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ContactsError';
  }
}

export interface ContactsContext {
  /** The account's key context: user, passkeys, session checks. */
  readonly keys: E2eeContext;
  readonly api: ContactsApi;
  readonly pins: ContactPinStore;
  readonly now?: () => number;
}

export function contactsContext(
  keys: E2eeContext,
  api: ContactsApi = createContactsApi(),
  pins: ContactPinStore = contactPins()
): ContactsContext {
  return { keys, api, pins };
}

export type ContactStanding =
  'verified' | 'key-changed' | 'untrusted' | 'seen' | 'not-checked';

/** One row of the Contacts list, from the signed list and local pins. */
export interface ContactSummary {
  readonly userId: string;
  readonly email: string | null;
  readonly standing: ContactStanding;
}

/** The account's verified contacts list and the people it may look up. */
export interface ContactsBook {
  readonly userId: string;
  readonly generation: number | null;
  /** Null until the first entry is signed. */
  readonly list: VerifiedContactsList | null;
  readonly people: readonly E2eeContactPerson[];
  readonly contacts: readonly ContactSummary[];
}

/** One contact as checked now against the server's copy of their keys. */
export interface ContactView {
  readonly userId: string;
  readonly email: string | null;
  /** `verified` only under the identity and head the signed list pinned. */
  readonly status: 'verified' | 'seen' | 'no-keys';
  /**
   * A verified identity was replaced (or a seen one changed): the contact
   * is unverified, and no key is wrapped to them until verified again.
   */
  readonly keyChanged: boolean;
  /** The signed list still verifies the replaced key: sign the change. */
  readonly keyChangeUnsigned: boolean;
  readonly list: VerifiedDeviceList | null;
  /** What the contact reads out: 40 digits over identity and head. */
  readonly code: string | null;
  /** The same as a 32-byte QR payload. */
  readonly codeHash: Bytes | null;
  /** Their identity fingerprint, which survives device changes. */
  readonly fingerprint: string | null;
}

const now = (ctx: ContactsContext) => (ctx.now ?? Date.now)();

function requireActive(ctx: ContactsContext): void {
  ctx.keys.assertActive?.();
  if (ctx.keys.isCurrent && !ctx.keys.isCurrent()) {
    throw new ContactsError('stale', 'The account session ended.');
  }
}

function signedOf(record: E2eeContactsEntryRecord): SignedContactsEntry {
  return {
    entry: fromBase64Url(record.entry),
    signature: fromBase64Url(record.signature)
  };
}

function refused(error: unknown, what: string): never {
  if (isE2eeError(error, 'chain-broken')) {
    throw new ContactsError(
      'fork',
      `The server showed an older or different ${what} than this browser already accepted. Nothing was changed.`
    );
  }
  if (isE2eeError(error)) {
    throw new ContactsError(
      'invalid',
      `The ${what} did not verify: ${error.message}`
    );
  }
  throw error;
}

/**
 * Verifies the server's copy of this account's contacts list against the
 * account's identity and this browser's pin, then moves the pin forward.
 */
async function acceptList(
  ctx: ContactsContext,
  account: AccountView,
  response: E2eeContactsResponse
): Promise<VerifiedContactsList | null> {
  const userId = ctx.keys.userId;
  if (response.generation !== account.generation) {
    throw new ContactsError(
      'stale',
      'Your encryption keys changed meanwhile. Reload and try again.'
    );
  }
  const identityHash = toHex(account.list.identityKeyHash);
  const stored = await ctx.pins.readList(userId);
  const pin =
    stored && stored.identityKeyHash === identityHash
      ? {
          identityKeyHash: account.list.identityKeyHash,
          sequence: stored.sequence,
          entryHash: fromHex(stored.entryHash)
        }
      : undefined;
  if (response.entries.length === 0) {
    // An empty list under the pinned identity hides every entry.
    if (pin) refused(new E2eeError('chain-broken', 'empty'), 'contacts list');
    return null;
  }
  let list: VerifiedContactsList;
  try {
    list = await verifyContactsList(
      account.list.identityKey,
      response.entries.map(signedOf),
      pin ? { pin } : {}
    );
  } catch (error) {
    refused(error, 'contacts list');
  }
  if (list.userId !== userId) {
    throw new ContactsError('invalid', 'The contacts list names another user.');
  }
  requireActive(ctx);
  await ctx.pins.advanceList(userId, {
    identityKeyHash: identityHash,
    sequence: list.pin.sequence,
    entryHash: toHex(list.pin.entryHash)
  });
  return list;
}

function standingOf(
  list: VerifiedContactsList | null,
  pin: ContactPin | undefined,
  contactUserId: string
): ContactStanding {
  const record = list?.contacts.get(contactUserId);
  if (record?.status === 'verified') {
    return pin?.keyChanged &&
      pin.identityKeyHash !== toHex(record.identityKeyHash)
      ? 'key-changed'
      : 'verified';
  }
  if (record?.status === 'key-changed' || pin?.keyChanged) return 'key-changed';
  if (record?.status === 'untrusted') return 'untrusted';
  return pin ? 'seen' : 'not-checked';
}

/**
 * The account's contacts: its signed list (verified against the pin),
 * everyone it may look up, and the contacts this browser has seen.
 */
export async function loadContacts(
  ctx: ContactsContext,
  account: AccountView
): Promise<ContactsBook> {
  requireActive(ctx);
  const response = await ctx.api.contacts();
  requireActive(ctx);
  const list = await acceptList(ctx, account, response);
  const seen = new Map(
    (await ctx.pins.listContacts(ctx.keys.userId)).map((pin) => [
      pin.contactUserId,
      pin
    ])
  );
  const emails = new Map(response.people.map((p) => [p.userId, p.email]));
  const ids = new Set<string>([
    ...response.people.map((p) => p.userId),
    ...(list?.contacts.keys() ?? []),
    ...seen.keys()
  ]);
  ids.delete(ctx.keys.userId);
  return {
    userId: ctx.keys.userId,
    generation: response.generation,
    list,
    people: response.people,
    contacts: [...ids].sort().map((id) => ({
      userId: id,
      email: emails.get(id) ?? null,
      standing: standingOf(list, seen.get(id), id)
    }))
  };
}

/** What this account's contacts compare about it: its identity and head. */
export async function ownVerificationCode(
  account: AccountView
): Promise<{ hash: Bytes; code: string }> {
  return contactVerificationCode(
    account.list.identityKey,
    account.list.headHash
  );
}

const CONTACT_SCAN_PREFIX = 'OZC1:';

/** The QR text for a contact verification hash. */
export function contactScanText(hash: Uint8Array): string {
  return `${CONTACT_SCAN_PREFIX}${toHex(hash)}`;
}

/** The 32-byte hash in a scanned or pasted contact code, or null. */
export function parseContactScan(text: string): Bytes | null {
  const compact = text.trim();
  const body = compact.toUpperCase().startsWith(CONTACT_SCAN_PREFIX)
    ? compact.slice(CONTACT_SCAN_PREFIX.length)
    : compact;
  return /^[0-9a-fA-F]{64}$/.test(body) ? fromHex(body.toLowerCase()) : null;
}

/**
 * Fetches a contact's identity and device list and checks it against the
 * signed contacts list and this browser's seen pin. A list that rolls back
 * or forks behind either is refused (`fork`) and no pin moves; otherwise the
 * seen pin moves to the new head. A verified identity that was replaced
 * comes back `seen` with `keyChanged`, and that downgrade is kept locally.
 */
export async function inspectContact(
  ctx: ContactsContext,
  book: ContactsBook,
  contactUserId: string
): Promise<ContactView> {
  requireActive(ctx);
  const userId = ctx.keys.userId;
  const email =
    book.people.find((p) => p.userId === contactUserId)?.email ?? null;
  const response = await ctx.api.deviceList(contactUserId);
  requireActive(ctx);
  const record = book.list?.contacts.get(contactUserId);
  const pin = await ctx.pins.readContact(userId, contactUserId);
  if (response.userId !== contactUserId) {
    throw new ContactsError('invalid', 'The server answered for another user.');
  }
  if (!response.identity) {
    return {
      userId: contactUserId,
      email,
      status: 'no-keys',
      keyChanged: record?.status === 'key-changed' || Boolean(pin?.keyChanged),
      keyChangeUnsigned: false,
      list: null,
      code: null,
      codeHash: null,
      fingerprint: null
    };
  }
  let identityKey: Bytes;
  let chain: SignedDeviceListEntry[];
  try {
    identityKey = fromBase64Url(response.identity.identityKey);
    chain = response.identity.entries.map((entry) => ({
      entry: fromBase64Url(entry.entry),
      signature: fromBase64Url(entry.signature)
    }));
  } catch (error) {
    throw new ContactsError(
      'invalid',
      `The contact's keys are malformed: ${String(error)}`
    );
  }
  let list: VerifiedDeviceList;
  try {
    list = await verifyDeviceList(identityKey, chain);
  } catch (error) {
    refused(error, 'device list');
  }
  if (list.userId !== contactUserId) {
    throw new ContactsError('invalid', 'The device list names another user.');
  }
  const identityHash = toHex(list.identityKeyHash);
  const verifiedSame =
    record?.status === 'verified' &&
    toHex(record.identityKeyHash) === identityHash;
  // Fork consistency: the list must extend the signed verification and
  // whatever newer head this browser accepted for the same identity.
  const pins: DeviceListPin[] = [];
  if (verifiedSame) pins.push(contactDeviceListPin(record));
  if (pin && pin.identityKeyHash === identityHash) {
    pins.push({
      identityKeyHash: list.identityKeyHash,
      sequence: pin.sequence,
      entryHash: fromHex(pin.entryHash)
    });
  }
  for (const each of pins) {
    try {
      await verifyDeviceList(identityKey, chain, { pin: each });
    } catch (error) {
      refused(error, 'device list');
    }
  }
  const replacedVerified = record?.status === 'verified' && !verifiedSame;
  const keyChanged =
    !verifiedSame &&
    (replacedVerified ||
      record?.status === 'key-changed' ||
      Boolean(pin?.keyChanged) ||
      (pin !== null && pin.identityKeyHash !== identityHash));
  requireActive(ctx);
  await ctx.pins.advanceContact(
    userId,
    {
      contactUserId,
      identityKeyHash: identityHash,
      sequence: list.pin.sequence,
      entryHash: toHex(list.headHash),
      keyChanged,
      seenAt: now(ctx)
    },
    // A replaced identity is surfaced as `keyChanged` before it is pinned.
    { replaceIdentity: true }
  );
  const { hash, code } = await contactVerificationCode(
    identityKey,
    list.headHash
  );
  return {
    userId: contactUserId,
    email,
    status: verifiedSame ? 'verified' : 'seen',
    keyChanged,
    keyChangeUnsigned: replacedVerified,
    list,
    code,
    codeHash: hash,
    fingerprint: (await identityFingerprint(identityKey)).code
  };
}

/**
 * The encryption key a project key may be wrapped to for this contact:
 * only a verified contact's, from the device list checked against the
 * verified pin. Null for anyone seen, changed or without keys.
 */
export function verifiedEncryptionKey(view: ContactView): Uint8Array | null {
  return view.status === 'verified' && !view.keyChanged && view.list
    ? view.list.head.encryptionKey
    : null;
}

/**
 * Signs `changes` into the contacts list one entry at a time, each checked
 * against the list the server returns: it must extend the pin this browser
 * held and hold the exact entry just signed. Returns the updated book.
 */
async function signEntries(
  ctx: ContactsContext,
  account: AccountView,
  book: ContactsBook,
  changes: readonly Omit<ContactsChange, 'issuedAt'>[],
  authorization: UnlockAuthorization
): Promise<ContactsBook> {
  if (
    book.generation !== account.generation ||
    book.userId !== ctx.keys.userId
  ) {
    throw new ContactsError('stale', 'Reload your contacts and try again.');
  }
  const userId = ctx.keys.userId;
  await withIdentityKey(ctx.keys, account, authorization, async (identity) => {
    let list = book.list;
    for (const change of changes) {
      const entry = nextContactsEntry(list, userId, {
        issuedAt: now(ctx),
        ...change
      });
      const signed = await signContactsEntry(identity, entry);
      requireActive(ctx);
      const response = await ctx.api.appendContacts({
        generation: account.generation,
        entry: toBase64Url(signed.entry),
        signature: toBase64Url(signed.signature)
      });
      requireActive(ctx);
      const accepted = await acceptList(ctx, account, response);
      const written = accepted?.entries[entry.sequence];
      if (
        !accepted ||
        !written ||
        toHex(written.hash) !== toHex(await contactsEntryHash(signed.entry))
      ) {
        throw new ContactsError(
          'invalid',
          'The server answered without the contacts entry just signed.'
        );
      }
      list = accepted;
    }
  });
  return loadContacts(ctx, account);
}

/**
 * Records a verification after the user compared the contact's code (digit
 * groups or QR) outside OpenZCAD. Under a verified identity this moves the
 * pinned head forward; a replaced identity first gets its key change
 * signed. Asks for a passkey or the recovery key.
 */
export async function verifyContact(
  ctx: ContactsContext,
  account: AccountView,
  book: ContactsBook,
  view: ContactView,
  authorization: UnlockAuthorization
): Promise<ContactsBook> {
  if (!view.list || view.userId === ctx.keys.userId) {
    throw new ContactsError(
      'not-verifiable',
      'This contact has no keys to verify.'
    );
  }
  const record = book.list?.contacts.get(view.userId);
  const identityKeyHash = view.list.identityKeyHash;
  const head = {
    sequence: view.list.pin.sequence,
    entryHash: view.list.headHash
  };
  const changes: Omit<ContactsChange, 'issuedAt'>[] = [];
  if (record?.status === 'verified') {
    if (toHex(record.identityKeyHash) === toHex(identityKeyHash)) {
      if (head.sequence > record.deviceListHead.sequence) {
        changes.push({
          action: 'advance',
          contactUserId: view.userId,
          identityKeyHash,
          deviceListHead: head
        });
      }
    } else {
      changes.push(
        {
          action: 'key-changed',
          contactUserId: view.userId,
          identityKeyHash: record.identityKeyHash
        },
        {
          action: 'verify',
          contactUserId: view.userId,
          identityKeyHash,
          deviceListHead: head
        }
      );
    }
  } else {
    changes.push({
      action: 'verify',
      contactUserId: view.userId,
      identityKeyHash,
      deviceListHead: head
    });
  }
  const next =
    changes.length > 0
      ? await signEntries(ctx, account, book, changes, authorization)
      : book;
  // The comparison covered this identity and head: clear the downgrade.
  await ctx.pins.advanceContact(
    ctx.keys.userId,
    {
      contactUserId: view.userId,
      identityKeyHash: toHex(identityKeyHash),
      sequence: head.sequence,
      entryHash: toHex(head.entryHash),
      keyChanged: false,
      seenAt: now(ctx)
    },
    { replaceIdentity: true }
  );
  return next === book ? loadContacts(ctx, account) : next;
}

/** Signs that a verified contact's key was replaced; they become unverified. */
export async function recordKeyChange(
  ctx: ContactsContext,
  account: AccountView,
  book: ContactsBook,
  contactUserId: string,
  authorization: UnlockAuthorization
): Promise<ContactsBook> {
  return withdraw(
    ctx,
    account,
    book,
    contactUserId,
    'key-changed',
    authorization
  );
}

/** Withdraws a verification; the contact is unverified until verified again. */
export async function untrustContact(
  ctx: ContactsContext,
  account: AccountView,
  book: ContactsBook,
  contactUserId: string,
  authorization: UnlockAuthorization
): Promise<ContactsBook> {
  return withdraw(ctx, account, book, contactUserId, 'untrust', authorization);
}

async function withdraw(
  ctx: ContactsContext,
  account: AccountView,
  book: ContactsBook,
  contactUserId: string,
  action: 'key-changed' | 'untrust',
  authorization: UnlockAuthorization
): Promise<ContactsBook> {
  const record = book.list?.contacts.get(contactUserId);
  if (record?.status !== 'verified') {
    throw new ContactsError('not-verifiable', 'This contact is not verified.');
  }
  return signEntries(
    ctx,
    account,
    book,
    [{ action, contactUserId, identityKeyHash: record.identityKeyHash }],
    authorization
  );
}
