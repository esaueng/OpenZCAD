import {
  ByteReader,
  ByteWriter,
  asBytes,
  concatBytes,
  copyBytes,
  equalBytes,
  isUint,
  label,
  utf8,
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
import {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  hkdfBaseKey,
  sha256,
  subtle,
  systemRandom,
  type RandomSource
} from './primitives';
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
  /**
   * The sealed record chain the entries arrived in (amendment 2026-11-14),
   * which the next sealed record extends; null for a plaintext list from
   * before sealing, which must be resealed before it can grow.
   */
  readonly sealed: SealedContactsHead | null;
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
  // Copy the chain before the first await, so a caller editing it
  // meanwhile cannot change what is verified.
  const captured = captureChain(chain);
  const signaturesFrom = options.signaturesFrom ?? 0;
  if (!isUint(signaturesFrom, MAX_CONTACTS_ENTRIES)) {
    throw new E2eeError('invalid-argument', 'signaturesFrom is not an index');
  }
  const pin = options.pin;
  if (pin !== undefined) checkPin(pin);
  const { key, raw: identityKey } = await verifyingKey(identityPublicKey);
  const identityKeyHash = await publicKeyHash(identityKey);
  checkPinnedIdentity(pin, identityKeyHash);
  const decoded: DecodedEntry[] = [];
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
    decoded.push({ bytes: signed.entry, entry });
  }
  return checkEntries(identityKey, identityKeyHash, decoded, pin, null);
}

function checkPinnedIdentity(
  pin: ContactsListPin | undefined,
  identityKeyHash: Uint8Array
): void {
  if (pin && !equalBytes(pin.identityKeyHash, identityKeyHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The identity key is not the one this browser pinned'
    );
  }
}

interface DecodedEntry {
  /** Canonical entry bytes, authenticated by the caller. */
  readonly bytes: Uint8Array;
  readonly entry: ContactsEntry;
}

/**
 * The list's rules over authenticated entries, oldest first: the chain
 * starts at sequence 0 and links by hash, every entry names the same user,
 * every change is allowed, and the list contains `pin`.
 */
async function checkEntries(
  identityKey: Bytes,
  identityKeyHash: Bytes,
  decoded: readonly DecodedEntry[],
  pin: ContactsListPin | undefined,
  sealed: SealedContactsHead | null
): Promise<VerifiedContactsList> {
  const entries: { entry: ContactsEntry; hash: Bytes }[] = [];
  const contacts = new Map<string, ContactRecord>();
  for (const { bytes, entry } of decoded) {
    const hash = await contactsEntryHash(bytes);
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
    },
    sealed
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

// --- Sealed contacts list (ADR-024 amendment 2026-11-14) -------------------

/**
 * The contacts list is the account's social graph: who it verified, their
 * fingerprints and device-list heads, and when. So each entry travels
 * sealed under the account key, and the server stores only ciphertext.
 *
 * A sealed record wraps exactly one canonical entry above, unchanged: the
 * entry chain, its hashes, every list rule and every pin (including the
 * contacts head the device-approval exchange carries) are the entries',
 * so sealing an existing plaintext list keeps every pin valid.
 *
 * Layout, big-endian:
 *
 *   "OZC" | u8 version = 1 | u32 sequence | u8 (0|32) + previous record
 *   hash | u32 account-key sequence | 12-byte IV | AES-256-GCM ciphertext
 *   and tag of a fixed 384-byte plaintext
 *
 * The plaintext is `u16 length | canonical entry | zero padding`, so every
 * record of a list has the same size whatever its action or contact id.
 * The key is HKDF-SHA-256 of the account key named by the account-key
 * sequence (`accountKeySequence` of the device list), with an empty salt
 * and `CONTACTS_LIST_KEY_INFO`. The additional data is
 * `SEALED_CONTACTS_AAD_LABEL`, the user id, a NUL and every byte before the
 * ciphertext, so no header field can change and no record can move to
 * another account. The identity key signs the whole record ("sealed
 * contacts list" statement), and records chain by `sealedContactsRecordHash`,
 * so the Worker can check order, links and signatures without the key.
 *
 * Account-key rotation reseals nothing: the account-key history keeps every
 * replaced key reachable from its successor, so a device opens an older
 * record's key by walking it (`openAccountKeyChain`). Records only move
 * forward through account keys, and a writer always seals under the current
 * one, so a removed device reads nothing written after its removal.
 */
export const SEALED_CONTACTS_RECORD_VERSION_1 = 1;
/** HKDF info: distinct from every other account-key derivation. */
export const CONTACTS_LIST_KEY_INFO = 'OpenZCAD E2EE v1 contacts list key';
const SEALED_CONTACTS_AAD_LABEL = 'OpenZCAD E2EE v1 sealed contacts entry\0';
const SEALED_CONTACTS_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x43); // "OZC"
/** Every sealed record's plaintext: room for the largest canonical entry. */
export const SEALED_CONTACTS_PLAINTEXT_BYTES = 384;
const FIXED_HEADER_BYTES = 3 + 1 + 4 + 1;
const SEALED_BODY_BYTES =
  4 + GCM_IV_BYTES + SEALED_CONTACTS_PLAINTEXT_BYTES + GCM_TAG_BYTES;
/** A first record (no previous hash) and every later one. */
export const SEALED_CONTACTS_RECORD_BYTES = Object.freeze({
  first: FIXED_HEADER_BYTES + SEALED_BODY_BYTES,
  next: FIXED_HEADER_BYTES + HASH_BYTES + SEALED_BODY_BYTES
});

/** What anyone, the Worker included, can read of a sealed record. */
export interface SealedContactsHeader {
  readonly sequence: number;
  /** `sealedContactsRecordHash` of the previous record; null for the first. */
  readonly previousRecordHash: Bytes | null;
  /** The device-list `accountKeySequence` of the key that sealed it. */
  readonly accountKeySequence: number;
}

/** The newest record of a sealed chain: what the next record extends. */
export interface SealedContactsHead {
  readonly sequence: number;
  readonly recordHash: Bytes;
  readonly accountKeySequence: number;
}

/** Whether `bytes` claims to be a sealed record (it may still be invalid). */
export function isSealedContactsRecord(bytes: Uint8Array): boolean {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= SEALED_CONTACTS_MAGIC.byteLength &&
    equalBytes(
      bytes.subarray(0, SEALED_CONTACTS_MAGIC.byteLength),
      SEALED_CONTACTS_MAGIC
    )
  );
}

function headerLength(previous: boolean): number {
  return FIXED_HEADER_BYTES + (previous ? HASH_BYTES : 0) + 4;
}

/** The header of a sealed record, checked for canonical form and size. */
export function readSealedContactsHeader(
  record: Uint8Array
): SealedContactsHeader {
  if (!(record instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'A record must be a Uint8Array');
  }
  if (record.byteLength > SEALED_CONTACTS_RECORD_BYTES.next) {
    throw new E2eeError(
      'limit-exceeded',
      'Sealed contacts record is too large'
    );
  }
  const reader = new ByteReader(record, 'Sealed contacts record');
  if (!equalBytes(reader.bytes(3), SEALED_CONTACTS_MAGIC)) {
    throw new E2eeError('malformed', 'Not a sealed contacts record');
  }
  const version = reader.u8();
  if (version !== SEALED_CONTACTS_RECORD_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Sealed contacts record version ${version} is not supported`
    );
  }
  const sequence = reader.u32();
  const previousLength = reader.u8();
  if (previousLength !== 0 && previousLength !== HASH_BYTES) {
    throw new E2eeError('malformed', 'Previous record hash must be 32 bytes');
  }
  if ((sequence === 0) !== (previousLength === 0)) {
    throw new E2eeError(
      'malformed',
      'Only the first sealed record (sequence 0) has no previous record'
    );
  }
  const previousRecordHash =
    previousLength === 0 ? null : copyBytes(reader.bytes(previousLength));
  const accountKeySequence = reader.u32();
  if (sequence >= MAX_CONTACTS_ENTRIES) {
    throw new E2eeError('limit-exceeded', 'Sealed contacts record sequence');
  }
  if (
    record.byteLength !==
    (previousRecordHash
      ? SEALED_CONTACTS_RECORD_BYTES.next
      : SEALED_CONTACTS_RECORD_BYTES.first)
  ) {
    throw new E2eeError('malformed', 'Sealed contacts record has a bad size');
  }
  return { sequence, previousRecordHash, accountKeySequence };
}

/** What the next sealed record and the Worker's stored head name. */
export async function sealedContactsRecordHash(
  record: Uint8Array
): Promise<Bytes> {
  return sha256(concatBytes(label('v1 sealed contacts record hash'), record));
}

async function contactsListKey(accountKey: Uint8Array): Promise<CryptoKey> {
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: utf8(CONTACTS_LIST_KEY_INFO)
    },
    await hkdfBaseKey(accountKey, 'An account key'),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function sealedAdditionalData(userId: string, header: Uint8Array): Bytes {
  return concatBytes(
    utf8(SEALED_CONTACTS_AAD_LABEL),
    utf8(userId),
    new Uint8Array([0]),
    header
  );
}

export interface SealContactsEntryInput {
  readonly userId: string;
  /** The device-list `accountKeySequence` of `accountKey`. */
  readonly accountKeySequence: number;
  /** The record this one follows; null for the list's first. */
  readonly previous: SealedContactsHead | null;
  readonly entry: ContactsEntry;
}

/** `sealContactsEntry` with an injected random source, for fixed vectors. */
export async function sealContactsEntryWith(
  random: RandomSource,
  accountKey: Uint8Array,
  input: SealContactsEntryInput
): Promise<Bytes> {
  const { userId, accountKeySequence, previous, entry } = input;
  const inner = encodeContactsEntry(entry);
  if (entry.userId !== userId) {
    throw new E2eeError(
      'invalid-argument',
      'The contacts entry names another user'
    );
  }
  if (!isUint(accountKeySequence, MAX_U32)) {
    throw new E2eeError('invalid-argument', 'accountKeySequence must be a u32');
  }
  if (
    previous
      ? previous.sequence + 1 !== entry.sequence ||
        !(previous.recordHash instanceof Uint8Array) ||
        previous.recordHash.byteLength !== HASH_BYTES ||
        accountKeySequence < previous.accountKeySequence
      : entry.sequence !== 0
  ) {
    throw new E2eeError(
      'invalid-argument',
      'A sealed record must follow the previous one, under the same or a newer account key'
    );
  }
  const header = new ByteWriter()
    .bytes(SEALED_CONTACTS_MAGIC)
    .u8(SEALED_CONTACTS_RECORD_VERSION_1)
    .u32(entry.sequence)
    .u8(previous ? HASH_BYTES : 0);
  if (previous) header.bytes(previous.recordHash);
  header.u32(accountKeySequence);
  // A fresh random IV per record: a list holds at most 1024 records per
  // account key, far below the 2^32 random-IV bound for AES-GCM.
  const iv = random(GCM_IV_BYTES);
  const headerBytes = concatBytes(header.finish(), iv);
  const plaintext = new Uint8Array(SEALED_CONTACTS_PLAINTEXT_BYTES);
  new DataView(plaintext.buffer).setUint16(0, inner.byteLength);
  plaintext.set(inner, 2);
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: asBytes(iv),
        additionalData: sealedAdditionalData(userId, headerBytes)
      },
      await contactsListKey(accountKey),
      plaintext
    )
  );
  return concatBytes(headerBytes, ciphertext);
}

/** Seals one entry under the account key `accountKeySequence` names. */
export function sealContactsEntry(
  accountKey: Uint8Array,
  input: SealContactsEntryInput
): Promise<Bytes> {
  return sealContactsEntryWith(systemRandom, accountKey, input);
}

/**
 * Opens a sealed record with the account key its header names. Fails with
 * `authentication-failed` for another key, another account or altered
 * bytes, and `malformed` when the padded entry inside is not canonical or
 * does not match the header.
 */
export async function openSealedContactsRecord(
  accountKey: Uint8Array | CryptoKey,
  userId: string,
  record: Uint8Array
): Promise<{
  readonly header: SealedContactsHeader;
  readonly bytes: Bytes;
  readonly entry: ContactsEntry;
}> {
  const header = readSealedContactsHeader(record);
  const bytes = asBytes(record);
  const split = headerLength(header.previousRecordHash !== null) + GCM_IV_BYTES;
  const key =
    accountKey instanceof Uint8Array
      ? await contactsListKey(accountKey)
      : accountKey;
  let plaintext: Bytes;
  try {
    plaintext = new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.subarray(split - GCM_IV_BYTES, split),
          additionalData: sealedAdditionalData(userId, bytes.subarray(0, split))
        },
        key,
        bytes.subarray(split)
      )
    );
  } catch {
    throw new E2eeError(
      'authentication-failed',
      `Sealed contacts record ${header.sequence} failed authentication: wrong account key or altered bytes`
    );
  }
  const length = new DataView(plaintext.buffer).getUint16(0);
  if (
    length > SEALED_CONTACTS_PLAINTEXT_BYTES - 2 ||
    plaintext.subarray(2 + length).some((byte) => byte !== 0)
  ) {
    throw new E2eeError('malformed', 'Sealed contacts record padding');
  }
  const inner = copyBytes(plaintext.subarray(2, 2 + length));
  plaintext.fill(0);
  const entry = decodeContactsEntry(inner);
  if (entry.sequence !== header.sequence || entry.userId !== userId) {
    throw new E2eeError(
      'malformed',
      'The sealed contacts entry does not match its record'
    );
  }
  return { header, bytes: inner, entry };
}

/** The identity key signs a sealed record; ask for a passkey or the recovery key. */
export async function signSealedContactsRecord(
  identityPrivateKey: SigningPrivateKey,
  record: Uint8Array
): Promise<SignedContactsEntry> {
  readSealedContactsHeader(record);
  const bytes = copyBytes(record);
  return {
    entry: bytes,
    signature: await signStatement(
      identityPrivateKey,
      'sealed contacts list',
      bytes
    )
  };
}

/**
 * Seals and signs `entries` as the records after `previous` (null for a
 * whole list from its first entry: a new list, or a plaintext list being
 * resealed), each under `accountKey`.
 */
export async function sealContactsEntries(
  identityPrivateKey: SigningPrivateKey,
  accountKey: Uint8Array,
  input: {
    readonly userId: string;
    readonly accountKeySequence: number;
    readonly previous: SealedContactsHead | null;
    readonly entries: readonly ContactsEntry[];
  }
): Promise<SignedContactsEntry[]> {
  const signed: SignedContactsEntry[] = [];
  let previous = input.previous;
  for (const entry of input.entries) {
    const record = await sealContactsEntry(accountKey, {
      userId: input.userId,
      accountKeySequence: input.accountKeySequence,
      previous,
      entry
    });
    signed.push(await signSealedContactsRecord(identityPrivateKey, record));
    previous = {
      sequence: entry.sequence,
      recordHash: await sealedContactsRecordHash(record),
      accountKeySequence: input.accountKeySequence
    };
  }
  return signed;
}

export interface VerifiedSealedContactsChain {
  readonly identityKey: Bytes;
  readonly identityKeyHash: Bytes;
  readonly records: readonly {
    readonly header: SealedContactsHeader;
    readonly hash: Bytes;
  }[];
  readonly head: SealedContactsHead;
}

function captureChain(
  chain: readonly SignedContactsEntry[]
): SignedContactsEntry[] {
  if (!Array.isArray(chain) || chain.length === 0) {
    broken('Contacts list is empty');
  }
  if (chain.length > MAX_CONTACTS_ENTRIES) {
    throw new E2eeError(
      'limit-exceeded',
      `A contacts list holds at most ${MAX_CONTACTS_ENTRIES} entries`
    );
  }
  return (chain as readonly SignedContactsEntry[]).map((signed) => {
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
}

/**
 * What can be checked of a sealed list without the account key, so the
 * Worker checks it too: every record is canonical and identity-signed, the
 * chain starts at sequence 0 and links by record hash, and records never
 * move back to an older account key. A plaintext entry anywhere fails
 * (`malformed`): a list is sealed whole or not at all.
 */
export async function verifySealedContactsChain(
  identityPublicKey: Uint8Array | CryptoKey,
  chain: readonly SignedContactsEntry[],
  options: Pick<VerifyContactsListOptions, 'signaturesFrom'> = {}
): Promise<VerifiedSealedContactsChain> {
  const captured = captureChain(chain);
  const signaturesFrom = options.signaturesFrom ?? 0;
  if (!isUint(signaturesFrom, MAX_CONTACTS_ENTRIES)) {
    throw new E2eeError('invalid-argument', 'signaturesFrom is not an index');
  }
  const { key, raw: identityKey } = await verifyingKey(identityPublicKey);
  const identityKeyHash = await publicKeyHash(identityKey);
  const records: { header: SealedContactsHeader; hash: Bytes }[] = [];
  for (const [index, signed] of captured.entries()) {
    const header = readSealedContactsHeader(signed.entry);
    if (
      index >= signaturesFrom &&
      !(await statementValid(
        key,
        'sealed contacts list',
        signed.entry,
        signed.signature
      ))
    ) {
      throw new E2eeError(
        'authentication-failed',
        `Sealed contacts record ${header.sequence} is not signed by the identity key`
      );
    }
    const before = records.at(-1);
    if (
      header.sequence !== index ||
      (before &&
        (!equalBytes(header.previousRecordHash!, before.hash) ||
          header.accountKeySequence < before.header.accountKeySequence))
    ) {
      broken(
        `Sealed contacts record ${header.sequence} does not follow its predecessor`
      );
    }
    records.push({
      header,
      hash: await sealedContactsRecordHash(signed.entry)
    });
  }
  const last = records.at(-1)!;
  return {
    identityKey,
    identityKeyHash,
    records,
    head: {
      sequence: last.header.sequence,
      recordHash: last.hash,
      accountKeySequence: last.header.accountKeySequence
    }
  };
}

export interface VerifySealedContactsListOptions {
  /** The account the list belongs to; bound into every record. */
  readonly userId: string;
  /**
   * The account key a device-list `accountKeySequence` names, from the
   * account-key history for an older one. Asked once per key; the bytes
   * are zeroed once the record key is derived.
   */
  openKey(accountKeySequence: number): Promise<Uint8Array>;
  /** The newest entry this browser accepted: the list must contain it. */
  readonly pin?: ContactsListPin;
}

/**
 * `verifyContactsList` for a sealed list: the record chain as
 * `verifySealedContactsChain` checks it, every record opened under the
 * account key it names, and the entries inside under every rule and pin of
 * a plaintext list. The result's pin names entry hashes, as before.
 */
export async function verifySealedContactsList(
  identityPublicKey: Uint8Array | CryptoKey,
  chain: readonly SignedContactsEntry[],
  options: VerifySealedContactsListOptions
): Promise<VerifiedContactsList> {
  const pin = options.pin;
  if (pin !== undefined) checkPin(pin);
  const captured = captureChain(chain);
  const outer = await verifySealedContactsChain(identityPublicKey, captured);
  checkPinnedIdentity(pin, outer.identityKeyHash);
  const keys = new Map<number, CryptoKey>();
  const decoded: DecodedEntry[] = [];
  for (const signed of captured) {
    const { accountKeySequence } = readSealedContactsHeader(signed.entry);
    let key = keys.get(accountKeySequence);
    if (!key) {
      const raw = await options.openKey(accountKeySequence);
      try {
        key = await contactsListKey(raw);
      } finally {
        raw.fill(0);
      }
      keys.set(accountKeySequence, key);
    }
    const { bytes, entry } = await openSealedContactsRecord(
      key,
      options.userId,
      signed.entry
    );
    decoded.push({ bytes, entry });
  }
  return checkEntries(
    outer.identityKey,
    outer.identityKeyHash,
    decoded,
    pin,
    outer.head
  );
}
