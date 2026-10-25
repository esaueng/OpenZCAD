import {
  ByteReader,
  ByteWriter,
  concatBytes,
  copyBytes,
  equalBytes,
  isUint,
  label,
  type Bytes
} from './bytes';
import { publicKeyHash } from './codes';
import {
  signStatement,
  statementValid,
  verifyingKey,
  type DeviceListPin
} from './devices';
import { E2eeError, type E2eeErrorCode } from './errors';
import { HASH_BYTES, isEnvelopeId } from './header';
import { sha256 } from './primitives';
import type { SigningPrivateKey } from './external-keys';

/**
 * The identity-signed contacts list (ADR-024, Version integrity: "Pins must
 * not roll back"). A user's verified pins for other people's keys live in
 * a hash-chained list of entries signed by the user's identity key, so a
 * server that serves an older copy cannot revive a verified pin for a key
 * that has since been replaced. Every device pins the newest entry it has
 * accepted and refuses an older or forked list, with the same rule as
 * versions and device lists.
 *
 * Each entry records one change for one contact:
 *
 * - `verify`: the user compared the contact's identity key together with
 *   the head of the contact's device list (`contactVerificationCode`) and
 *   pins both;
 * - `advance`: moves a verified contact's pinned device-list head forward
 *   (the browser checks that the newer head chains from the pinned one);
 * - `key-changed`: the verified identity key was replaced, so the contact
 *   drops back to unverified until verified again;
 * - `untrust`: the user withdraws a verification.
 *
 * Only a verified contact can advance, change or be untrusted, and only
 * under the identity it was verified with, so the list's state follows from
 * its entries alone.
 */

export const CONTACTS_ENTRY_VERSION_1 = 1;
const CONTACTS_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x4b); // "OZK"
const MAX_U32 = 0xffffffff;

/** Most entries one contacts list (one identity) holds. */
export const MAX_CONTACTS_ENTRIES = 1024;
/** Largest canonical entry: two 128-byte ids and every optional field. */
export const MAX_CONTACTS_ENTRY_BYTES = 512;

export const CONTACT_ACTIONS = Object.freeze([
  'verify',
  'advance',
  'key-changed',
  'untrust'
] as const);
export type ContactAction = (typeof CONTACT_ACTIONS)[number];

const ACTION_CODES: Record<ContactAction, number> = {
  verify: 1,
  advance: 2,
  'key-changed': 3,
  untrust: 4
};

/** A device-list head: the entry a verified contact's keys are pinned to. */
export interface ContactDeviceListHead {
  readonly sequence: number;
  /** `deviceListEntryHash` of that entry. */
  readonly entryHash: Uint8Array;
}

export interface ContactsEntry {
  /** Whose list this is: the user whose identity key signs it. */
  readonly userId: string;
  /** 0 for the first entry, then +1 per entry. */
  readonly sequence: number;
  /** `contactsEntryHash` of the previous entry; null for the first. */
  readonly previousEntryHash: Uint8Array | null;
  /** Unix milliseconds; the signer's claim, not proof of time. */
  readonly issuedAt: number;
  readonly action: ContactAction;
  readonly contactUserId: string;
  /** `publicKeyHash` of the contact's identity key (their fingerprint). */
  readonly identityKeyHash: Uint8Array;
  /** `verify` and `advance` only: the device-list head pinned with it. */
  readonly deviceListHead: ContactDeviceListHead | null;
}

export interface SignedContactsEntry {
  /** Canonical `encodeContactsEntry` bytes. */
  readonly entry: Uint8Array;
  /** `u8 version = 1 | 64-byte r || s` by the identity key. */
  readonly signature: Uint8Array;
}

/** The newest contacts entry a browser has accepted for its own account. */
export interface ContactsListPin {
  readonly identityKeyHash: Uint8Array;
  readonly sequence: number;
  readonly entryHash: Uint8Array;
}

export type ContactRecordStatus = 'verified' | 'key-changed' | 'untrusted';

/** What the list says about one contact after its newest entry. */
export interface ContactRecord {
  readonly contactUserId: string;
  readonly status: ContactRecordStatus;
  /** The identity key hash the contact was verified with. */
  readonly identityKeyHash: Bytes;
  /** The newest pinned device-list head for that identity. */
  readonly deviceListHead: {
    readonly sequence: number;
    readonly entryHash: Bytes;
  };
  /** Sequence of the entry that verified this identity. */
  readonly verifiedAt: number;
  /** Sequence of the contact's newest entry. */
  readonly updatedAt: number;
}

export interface VerifiedContactsList {
  readonly userId: string;
  /** The raw identity public key the list was verified against. */
  readonly identityKey: Bytes;
  readonly identityKeyHash: Bytes;
  readonly entries: readonly {
    readonly entry: ContactsEntry;
    readonly hash: Bytes;
  }[];
  readonly head: ContactsEntry;
  readonly headHash: Bytes;
  /** Every contact the list names, by user id. */
  readonly contacts: ReadonlyMap<string, ContactRecord>;
  /** The pin to keep after accepting this list. */
  readonly pin: ContactsListPin;
}

function isHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === HASH_BYTES;
}

const carriesHead = (action: ContactAction) =>
  action === 'verify' || action === 'advance';

function checkEntry(entry: ContactsEntry, code: E2eeErrorCode): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (entry === null || typeof entry !== 'object') fail('Expected an entry');
  if (!isEnvelopeId(entry.userId)) fail('Contacts list userId is not an id');
  if (!isUint(entry.sequence, MAX_U32)) fail('sequence must be a u32');
  if ((entry.sequence === 0) !== (entry.previousEntryHash === null)) {
    fail('Only the first entry (sequence 0) has no previous entry');
  }
  if (entry.previousEntryHash !== null && !isHash(entry.previousEntryHash)) {
    fail('previousEntryHash must be 32 bytes');
  }
  if (!isUint(entry.issuedAt, Number.MAX_SAFE_INTEGER)) {
    fail('issuedAt must be Unix milliseconds');
  }
  if (!CONTACT_ACTIONS.includes(entry.action)) fail('Unknown contact action');
  if (!isEnvelopeId(entry.contactUserId)) fail('contactUserId is not an id');
  if (entry.contactUserId === entry.userId) {
    fail('A contacts list does not name its own user');
  }
  if (!isHash(entry.identityKeyHash)) {
    fail('identityKeyHash must be 32 bytes');
  }
  if (carriesHead(entry.action)) {
    const head = entry.deviceListHead;
    if (
      head === null ||
      typeof head !== 'object' ||
      !isUint(head.sequence, MAX_U32) ||
      !isHash(head.entryHash)
    ) {
      fail(`A ${entry.action} entry pins a device-list head`);
    }
  } else if (entry.deviceListHead !== null) {
    fail(`A ${entry.action} entry pins no device-list head`);
  }
}

const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

function writeId(writer: ByteWriter, id: string): void {
  writer.u8(id.length).bytes(ascii.encode(id));
}

function readId(reader: ByteReader): string {
  return asciiDecoder.decode(reader.bytes(reader.u8()));
}

/**
 * Canonical bytes: `"OZK" | u8 version = 1 | u32 sequence | u8 (0|32) +
 * previous entry hash | u8 length + user id | u64 issuedAt | u8 action
 * (1 verify, 2 advance, 3 key-changed, 4 untrust) | u8 length + contact
 * user id | 32-byte contact identity key hash`, then for `verify` and
 * `advance` only `u32 device-list sequence | 32-byte device-list entry
 * hash`.
 */
export function encodeContactsEntry(entry: ContactsEntry): Bytes {
  checkEntry(entry, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(CONTACTS_MAGIC)
    .u8(CONTACTS_ENTRY_VERSION_1)
    .u32(entry.sequence);
  writer.u8(entry.previousEntryHash?.byteLength ?? 0);
  if (entry.previousEntryHash) writer.bytes(entry.previousEntryHash);
  writeId(writer, entry.userId);
  writer.u64(entry.issuedAt).u8(ACTION_CODES[entry.action]);
  writeId(writer, entry.contactUserId);
  writer.bytes(entry.identityKeyHash);
  if (entry.deviceListHead) {
    writer
      .u32(entry.deviceListHead.sequence)
      .bytes(entry.deviceListHead.entryHash);
  }
  return writer.finish();
}

/** Decodes canonical entry bytes; anything else is `malformed`. */
export function decodeContactsEntry(bytes: Uint8Array): ContactsEntry {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Entry must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_CONTACTS_ENTRY_BYTES) {
    throw new E2eeError('limit-exceeded', 'Contacts entry is too large');
  }
  const reader = new ByteReader(bytes, 'Contacts entry');
  if (!equalBytes(reader.bytes(3), CONTACTS_MAGIC)) {
    throw new E2eeError('malformed', 'Not a contacts entry');
  }
  const version = reader.u8();
  if (version !== CONTACTS_ENTRY_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Contacts entry version ${version} is not supported`
    );
  }
  const sequence = reader.u32();
  const previousLength = reader.u8();
  const previousEntryHash =
    previousLength === 0 ? null : copyBytes(reader.bytes(previousLength));
  const userId = readId(reader);
  const issuedAt = reader.u64();
  const code = reader.u8();
  const action = CONTACT_ACTIONS.find((a) => ACTION_CODES[a] === code);
  if (!action) {
    throw new E2eeError('malformed', `Unknown contact action ${code}`);
  }
  const contactUserId = readId(reader);
  const identityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const deviceListHead = carriesHead(action)
    ? {
        sequence: reader.u32(),
        entryHash: copyBytes(reader.bytes(HASH_BYTES))
      }
    : null;
  reader.end();
  const entry: ContactsEntry = {
    userId,
    sequence,
    previousEntryHash,
    issuedAt,
    action,
    contactUserId,
    identityKeyHash,
    deviceListHead
  };
  checkEntry(entry, 'malformed');
  if (!equalBytes(encodeContactsEntry(entry), bytes)) {
    throw new E2eeError('malformed', 'Contacts entry is not in canonical form');
  }
  return entry;
}

/** What the next entry and every pin name. */
export async function contactsEntryHash(entry: Uint8Array): Promise<Bytes> {
  return sha256(concatBytes(label('v1 contacts entry hash'), entry));
}

/** The identity key signs a contacts entry; ask for a passkey or the recovery key. */
export async function signContactsEntry(
  identityPrivateKey: SigningPrivateKey,
  entry: ContactsEntry
): Promise<SignedContactsEntry> {
  const bytes = encodeContactsEntry(entry);
  return {
    entry: bytes,
    signature: await signStatement(identityPrivateKey, 'contacts list', bytes)
  };
}

/** The change one new entry makes; `nextContactsEntry` fills in the chain. */
export interface ContactsChange {
  readonly issuedAt: number;
  readonly action: ContactAction;
  readonly contactUserId: string;
  readonly identityKeyHash: Uint8Array;
  readonly deviceListHead?: ContactDeviceListHead | null;
}

/**
 * The entry that follows `list` (or the first entry of `userId`'s list when
 * `list` is null), checked against the list's rules before it is signed.
 */
export function nextContactsEntry(
  list: VerifiedContactsList | null,
  userId: string,
  change: ContactsChange
): ContactsEntry {
  if (list && list.userId !== userId) {
    throw new E2eeError(
      'invalid-argument',
      'The contacts list belongs to another user'
    );
  }
  const entry: ContactsEntry = {
    userId,
    sequence: list ? list.head.sequence + 1 : 0,
    previousEntryHash: list ? list.headHash : null,
    issuedAt: change.issuedAt,
    action: change.action,
    contactUserId: change.contactUserId,
    identityKeyHash: change.identityKeyHash,
    deviceListHead: change.deviceListHead ?? null
  };
  checkEntry(entry, 'invalid-argument');
  const contacts = new Map(list?.contacts ?? []);
  try {
    applyEntry(contacts, entry);
  } catch (error) {
    if (error instanceof E2eeError) {
      throw new E2eeError('invalid-argument', error.message, { cause: error });
    }
    throw error;
  }
  return entry;
}

function broken(message: string): never {
  throw new E2eeError('chain-broken', message);
}

/** Applies one entry's change; refuses one the list's state does not allow. */
function applyEntry(
  contacts: Map<string, ContactRecord>,
  entry: ContactsEntry
): void {
  const at = `Contacts entry ${entry.sequence}`;
  const current = contacts.get(entry.contactUserId);
  const verifiedSame =
    current?.status === 'verified' &&
    equalBytes(current.identityKeyHash, entry.identityKeyHash);
  const base = {
    contactUserId: entry.contactUserId,
    identityKeyHash: copyBytes(entry.identityKeyHash),
    updatedAt: entry.sequence
  };
  switch (entry.action) {
    case 'verify': {
      if (current?.status === 'verified') {
        broken(
          verifiedSame
            ? `${at} verifies a contact that is already verified`
            : `${at} verifies a new key before recording the key change`
        );
      }
      const head = entry.deviceListHead!;
      contacts.set(entry.contactUserId, {
        ...base,
        status: 'verified',
        deviceListHead: {
          sequence: head.sequence,
          entryHash: copyBytes(head.entryHash)
        },
        verifiedAt: entry.sequence
      });
      return;
    }
    case 'advance': {
      if (!verifiedSame) {
        broken(`${at} moves the head of a key that is not verified`);
      }
      const head = entry.deviceListHead!;
      if (head.sequence <= current.deviceListHead.sequence) {
        broken(`${at} moves a device-list head backwards`);
      }
      contacts.set(entry.contactUserId, {
        ...current,
        updatedAt: entry.sequence,
        deviceListHead: {
          sequence: head.sequence,
          entryHash: copyBytes(head.entryHash)
        }
      });
      return;
    }
    case 'key-changed':
    case 'untrust': {
      if (!verifiedSame) {
        broken(`${at} withdraws a key that is not verified`);
      }
      contacts.set(entry.contactUserId, {
        ...current,
        status: entry.action === 'untrust' ? 'untrusted' : 'key-changed',
        updatedAt: entry.sequence
      });
      return;
    }
  }
}

function checkPin(pin: ContactsListPin): void {
  if (
    pin === null ||
    typeof pin !== 'object' ||
    !isHash(pin.identityKeyHash) ||
    !isHash(pin.entryHash) ||
    !isUint(pin.sequence, MAX_U32)
  ) {
    throw new E2eeError('invalid-argument', 'Not a contacts list pin');
  }
}

export interface VerifyContactsListOptions {
  /** The newest entry this browser accepted: the list must contain it. */
  readonly pin?: ContactsListPin;
  /**
   * Entries before this index are not signature-checked. Only for a store
   * that checked each signature when it accepted the entry (the Worker
   * appending one entry); browsers never pass it.
   */
  readonly signaturesFrom?: number;
}

/**
 * Verifies a user's whole contacts list, oldest first, against their
 * identity key: every entry is canonical and identity-signed, the chain
 * starts at sequence 0 and links by hash, every entry names the same user,
 * and every change follows the rules above.
 *
 * With `pin`, the identity must be the pinned one (`context-mismatch`
 * otherwise) and the chain must contain the pinned entry, so a rolled-back
 * or forked list fails with `chain-broken`. Accepting the result moves the
 * pin to `result.pin`.
 */
export async function verifyContactsList(
  identityPublicKey: Uint8Array | CryptoKey,
  chain: readonly SignedContactsEntry[],
  options: VerifyContactsListOptions = {}
): Promise<VerifiedContactsList> {
  if (!Array.isArray(chain) || chain.length === 0) {
    broken('Contacts list is empty');
  }
  if (chain.length > MAX_CONTACTS_ENTRIES) {
    throw new E2eeError(
      'limit-exceeded',
      `A contacts list holds at most ${MAX_CONTACTS_ENTRIES} entries`
    );
  }
  const signaturesFrom = options.signaturesFrom ?? 0;
  if (!isUint(signaturesFrom, MAX_CONTACTS_ENTRIES)) {
    throw new E2eeError('invalid-argument', 'signaturesFrom is not an index');
  }
  const pin = options.pin;
  if (pin !== undefined) checkPin(pin);
  // Copy the chain before the first await, so a caller editing it
  // meanwhile cannot change what is verified.
  const captured = (chain as readonly SignedContactsEntry[]).map((signed) => {
    if (
      signed === null ||
      typeof signed !== 'object' ||
      !(signed.entry instanceof Uint8Array) ||
      !(signed.signature instanceof Uint8Array)
    ) {
      throw new E2eeError('invalid-argument', 'Not a signed contacts entry');
    }
    return {
      entry: copyBytes(signed.entry),
      signature: copyBytes(signed.signature)
    };
  });
  const { key, raw: identityKey } = await verifyingKey(identityPublicKey);
  const identityKeyHash = await publicKeyHash(identityKey);
  if (pin && !equalBytes(pin.identityKeyHash, identityKeyHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The identity key is not the one this browser pinned'
    );
  }
  const entries: { entry: ContactsEntry; hash: Bytes }[] = [];
  const contacts = new Map<string, ContactRecord>();
  for (const [index, signed] of captured.entries()) {
    const entry = decodeContactsEntry(signed.entry);
    if (
      index >= signaturesFrom &&
      !(await statementValid(
        key,
        'contacts list',
        signed.entry,
        signed.signature
      ))
    ) {
      throw new E2eeError(
        'authentication-failed',
        `Contacts entry ${entry.sequence} is not signed by the identity key`
      );
    }
    const hash = await contactsEntryHash(signed.entry);
    const before = entries.at(-1);
    if (!before) {
      if (entry.sequence !== 0) {
        broken('Contacts list must start at its first entry');
      }
    } else {
      if (entry.userId !== before.entry.userId) {
        broken('Contacts list changes user');
      }
      if (
        entry.sequence !== before.entry.sequence + 1 ||
        entry.previousEntryHash === null ||
        !equalBytes(entry.previousEntryHash, before.hash)
      ) {
        broken(
          `Contacts entry ${entry.sequence} does not follow its predecessor`
        );
      }
    }
    applyEntry(contacts, entry);
    entries.push({ entry, hash });
  }
  const last = entries.at(-1)!;
  if (pin) {
    const pinned = entries[pin.sequence];
    if (!pinned || !equalBytes(pinned.hash, pin.entryHash)) {
      broken(
        'Contacts list does not contain the entry this browser pinned: rolled back or forked'
      );
    }
  }
  return {
    userId: last.entry.userId,
    identityKey,
    identityKeyHash,
    entries,
    head: last.entry,
    headHash: last.hash,
    contacts,
    pin: {
      identityKeyHash,
      sequence: last.entry.sequence,
      entryHash: last.hash
    }
  };
}

/**
 * The device-list pin a verified contact's keys must extend: their identity
 * key hash with the head this list pinned for them. Pass it to
 * `verifyDeviceList` (with the contact's identity key) and a list that
 * rolled back or forked behind the verified head fails with
 * `chain-broken`; another identity fails with `context-mismatch`.
 */
export function contactDeviceListPin(record: ContactRecord): DeviceListPin {
  return {
    identityKeyHash: record.identityKeyHash,
    sequence: record.deviceListHead.sequence,
    entryHash: record.deviceListHead.entryHash
  };
}
