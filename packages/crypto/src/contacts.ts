import {
  ByteReader,
  ByteWriter,
  copyBytes,
  equalBytes,
  isUint,
  type Bytes
} from './bytes';
import {
  chainEntryHash,
  checkChain,
  checkNextLink,
  type ChainLink,
  type ChainOptions
} from './chain';
import {
  currentEncryptionKey,
  signIdentityStatement,
  verifyIdentityStatement,
  type VerifiedDeviceList
} from './devices';
import { E2eeError } from './errors';
import { HASH_BYTES, isEnvelopeId } from './header';

/**
 * A contacts list holds a user's verified pins of other people's identity
 * keys, as identity-signed, hash-chained entries. It lives in its own chain
 * rather than in encrypted settings so a server cannot roll a pin back: every
 * device pins the newest entry and refuses an older or forked list.
 */
export const CONTACT_ACTIONS = [
  'verify',
  'replace',
  'distrust',
  'advance'
] as const;
export type ContactAction = (typeof CONTACT_ACTIONS)[number];

export interface ContactsListEntry {
  /** Whose list this is. */
  readonly ownerUserId: string;
  /** 0 for the first entry, then +1 per entry. */
  readonly sequence: number;
  /** `contactsEntryHash` of the previous entry; null for the first. */
  readonly previousEntryHash: Uint8Array | null;
  /**
   * `verify`: the user compared and trusts `identityKeyHash` together with
   * the contact's device-list head `deviceListHead`.
   * `advance`: the pinned device-list head moves forward to `deviceListHead`
   * (a newer head that chains from the pinned one).
   * `replace`: the verified `identityKeyHash` was replaced by
   * `replacementKeyHash`, which stays unverified until a new `verify`.
   * `distrust`: the verified `identityKeyHash` is no longer trusted.
   */
  readonly action: ContactAction;
  readonly contactUserId: string;
  /** Identity key hash (`identityFingerprint(...).hash`) the action is about. */
  readonly identityKeyHash: Uint8Array;
  /** `deviceListEntryHash` of the contact's list head, for `verify` and `advance`. */
  readonly deviceListHead: Uint8Array | null;
  /** The new key, for `replace` only; null otherwise. */
  readonly replacementKeyHash: Uint8Array | null;
}

export interface SignedContactsEntry {
  /** Canonical `encodeContactsEntry` bytes. */
  readonly entry: Bytes;
  /** `u8 version | 64-byte r || s` by the owner's identity key. */
  readonly signature: Bytes;
}

const CONTACTS_MAGIC = [0x4f, 0x5a, 0x43]; // "OZC"
const CONTACTS_VERSION_1 = 1;
const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

function isHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === HASH_BYTES;
}

function checkContactsEntry(
  entry: ContactsListEntry,
  code: 'invalid-argument' | 'malformed'
): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (!isEnvelopeId(entry.ownerUserId)) fail('ownerUserId is not an id');
  if (!isEnvelopeId(entry.contactUserId)) fail('contactUserId is not an id');
  if (entry.ownerUserId === entry.contactUserId) {
    fail('A contacts list does not pin its owner');
  }
  if (!isUint(entry.sequence, 0xffffffff)) fail('sequence must be a u32');
  if ((entry.sequence === 0) !== (entry.previousEntryHash === null)) {
    fail('Only the first entry (sequence 0) has no previous entry');
  }
  if (entry.previousEntryHash !== null && !isHash(entry.previousEntryHash)) {
    fail('previousEntryHash must be 32 bytes');
  }
  if (!CONTACT_ACTIONS.includes(entry.action)) fail('Unknown contact action');
  if (!isHash(entry.identityKeyHash)) fail('identityKeyHash must be 32 bytes');
  const needsHead = entry.action === 'verify' || entry.action === 'advance';
  if (
    needsHead ? !isHash(entry.deviceListHead) : entry.deviceListHead !== null
  ) {
    fail('Only verify and advance name a 32-byte device-list head');
  }
  if (entry.action === 'replace') {
    if (
      !isHash(entry.replacementKeyHash) ||
      equalBytes(entry.replacementKeyHash, entry.identityKeyHash)
    ) {
      fail('A replacement names a different 32-byte key hash');
    }
  } else if (entry.replacementKeyHash !== null) {
    fail('Only a replacement names a replacement key');
  }
}

/**
 * Canonical bytes: "OZC" | u8 version | u32 sequence | u8 previous-hash
 * length (0|32) + hash | u8 length + owner id | u8 action (1 verify,
 * 2 replace, 3 distrust, 4 advance) | u8 length + contact id | 32-byte
 * identity key hash | u8 length (0|32) + device-list head | u8 length
 * (0|32) + replacement key hash.
 */
export function encodeContactsEntry(entry: ContactsListEntry): Bytes {
  checkContactsEntry(entry, 'invalid-argument');
  return new ByteWriter()
    .bytes(Uint8Array.from(CONTACTS_MAGIC))
    .u8(CONTACTS_VERSION_1)
    .u32(entry.sequence)
    .u8(entry.previousEntryHash?.byteLength ?? 0)
    .bytes(entry.previousEntryHash ?? new Uint8Array())
    .u8(entry.ownerUserId.length)
    .bytes(ascii.encode(entry.ownerUserId))
    .u8(CONTACT_ACTIONS.indexOf(entry.action) + 1)
    .u8(entry.contactUserId.length)
    .bytes(ascii.encode(entry.contactUserId))
    .bytes(entry.identityKeyHash)
    .u8(entry.deviceListHead?.byteLength ?? 0)
    .bytes(entry.deviceListHead ?? new Uint8Array())
    .u8(entry.replacementKeyHash?.byteLength ?? 0)
    .bytes(entry.replacementKeyHash ?? new Uint8Array())
    .finish();
}

export function decodeContactsEntry(bytes: Uint8Array): ContactsListEntry {
  const reader = new ByteReader(bytes, 'Contacts entry');
  if (!equalBytes(reader.bytes(3), Uint8Array.from(CONTACTS_MAGIC))) {
    throw new E2eeError('malformed', 'Not a contacts entry');
  }
  const version = reader.u8();
  if (version !== CONTACTS_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Contacts version ${version} is not supported`
    );
  }
  const sequence = reader.u32();
  const previousLength = reader.u8();
  const previousEntryHash =
    previousLength === 0 ? null : copyBytes(reader.bytes(previousLength));
  const ownerUserId = asciiDecoder.decode(reader.bytes(reader.u8()));
  const action = CONTACT_ACTIONS[reader.u8() - 1];
  if (action === undefined) {
    throw new E2eeError('malformed', 'Unknown contact action');
  }
  const contactUserId = asciiDecoder.decode(reader.bytes(reader.u8()));
  const identityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const headLength = reader.u8();
  const deviceListHead =
    headLength === 0 ? null : copyBytes(reader.bytes(headLength));
  const replacementLength = reader.u8();
  const replacementKeyHash =
    replacementLength === 0 ? null : copyBytes(reader.bytes(replacementLength));
  reader.end();
  const entry = {
    ownerUserId,
    sequence,
    previousEntryHash,
    action,
    contactUserId,
    identityKeyHash,
    deviceListHead,
    replacementKeyHash
  };
  checkContactsEntry(entry, 'malformed');
  if (!equalBytes(encodeContactsEntry(entry), bytes)) {
    throw new E2eeError('malformed', 'Contacts entry is not in canonical form');
  }
  return entry;
}

export async function contactsEntryHash(entry: Uint8Array): Promise<Bytes> {
  return chainEntryHash('contacts', entry);
}

/** The owner's identity key signs a contacts entry. */
export async function signContactsEntry(
  identityPrivateKey: CryptoKey,
  entry: ContactsListEntry
): Promise<SignedContactsEntry> {
  const bytes = encodeContactsEntry(entry);
  return {
    entry: bytes,
    signature: await signIdentityStatement(
      identityPrivateKey,
      'contacts',
      bytes
    )
  };
}

export type ContactStatus = 'verified' | 'replaced' | 'distrusted';

export interface ContactPin {
  readonly userId: string;
  readonly status: ContactStatus;
  /** The verified key, or the key that was replaced or distrusted. */
  readonly identityKeyHash: Bytes;
  /** For `verified`: the pinned device-list head, at least this new. */
  readonly deviceListHead: Bytes | null;
  /** For `replaced`: the new key, seen but not verified. */
  readonly replacementKeyHash: Bytes | null;
  /** Sequence of the entry that set this state. */
  readonly sequence: number;
}

export interface VerifiedContactsList {
  readonly ownerUserId: string;
  readonly latestSequence: number;
  /** Pin this; the next list must contain it. */
  readonly latestHash: Bytes;
  readonly contacts: readonly ContactPin[];
}

/**
 * Verifies a whole contacts list, oldest first, against the owner's
 * identity key: identity-signed canonical entries from sequence 0, linked
 * by hash, containing `pinnedEntryHash` when given. An `advance`,
 * `replace` or `distrust` must name the key currently verified for that
 * contact. Whether an advanced head really chains forward is checked
 * against the device list itself (`checkContactDeviceList`).
 */
export async function verifyContactsList(
  identityPublicKey: Uint8Array | CryptoKey,
  chain: readonly SignedContactsEntry[],
  options: ChainOptions = {}
): Promise<VerifiedContactsList> {
  const links: ChainLink[] = [];
  const pins = new Map<string, ContactPin>();
  let ownerUserId: string | null = null;
  for (const signed of chain) {
    const entry = decodeContactsEntry(signed.entry);
    await verifyIdentityStatement(
      identityPublicKey,
      'contacts',
      signed.entry,
      signed.signature,
      entry.sequence
    );
    if (ownerUserId !== null && entry.ownerUserId !== ownerUserId) {
      throw new E2eeError('chain-broken', 'Contacts list changes owner');
    }
    ownerUserId = entry.ownerUserId;
    links.push({
      sequence: entry.sequence,
      previousEntryHash: entry.previousEntryHash,
      hash: await contactsEntryHash(signed.entry)
    });
    checkNextLink('Contacts list', links.at(-1)!, links.at(-2));
    const current = pins.get(entry.contactUserId);
    if (entry.action !== 'verify') {
      if (
        current?.status !== 'verified' ||
        !equalBytes(current.identityKeyHash, entry.identityKeyHash)
      ) {
        throw new E2eeError(
          'chain-broken',
          `Contacts entry ${entry.sequence} does not name the verified key of ${entry.contactUserId}`
        );
      }
    }
    pins.set(entry.contactUserId, {
      userId: entry.contactUserId,
      status:
        entry.action === 'verify' || entry.action === 'advance'
          ? 'verified'
          : entry.action === 'replace'
            ? 'replaced'
            : 'distrusted',
      deviceListHead: entry.deviceListHead
        ? copyBytes(entry.deviceListHead)
        : null,
      identityKeyHash: copyBytes(entry.identityKeyHash),
      replacementKeyHash: entry.replacementKeyHash
        ? copyBytes(entry.replacementKeyHash)
        : null,
      sequence: entry.sequence
    });
  }
  checkChain('Contacts list', links, { ...options, fromGenesis: true });
  const latest = links.at(-1)!;
  return {
    ownerUserId: ownerUserId!,
    latestSequence: latest.sequence,
    latestHash: copyBytes(latest.hash),
    contacts: [...pins.values()]
  };
}

/** True only if the list currently verifies exactly this identity key. */
export function isVerifiedContact(
  list: VerifiedContactsList,
  userId: string,
  identityKeyHash: Uint8Array
): boolean {
  const pin = list.contacts.find((contact) => contact.userId === userId);
  return (
    pin?.status === 'verified' &&
    equalBytes(pin.identityKeyHash, identityKeyHash)
  );
}

/** True if `list` contains `pinnedHead`, so its newest entry chains from it. */
export function deviceListChainsFrom(
  list: VerifiedDeviceList,
  pinnedHead: Uint8Array
): boolean {
  return list.entries.some(({ hash }) => equalBytes(hash, pinnedHead));
}

export interface ContactDeviceListCheck {
  /** The encryption key to wrap project keys to. */
  readonly encryptionKey: Bytes;
  /** The list's newest head: newer than the pin when `advanced`. */
  readonly latestHead: Bytes;
  /** True when the pin should move forward (sign an `advance` entry). */
  readonly advanced: boolean;
}

/**
 * The check before wrapping a project key to a verified contact: the device
 * list belongs to the verified identity and chains forward from the pinned
 * head, so a server cannot pair the right identity with an old list whose
 * encryption key a removed device still holds. Throws `context-mismatch`
 * for an unverified pin or another identity, and `chain-broken` for a list
 * that does not contain the pinned head.
 */
export function checkContactDeviceList(
  pin: ContactPin,
  list: VerifiedDeviceList
): ContactDeviceListCheck {
  if (
    pin.status !== 'verified' ||
    pin.deviceListHead === null ||
    !equalBytes(pin.identityKeyHash, list.identityKeyHash)
  ) {
    throw new E2eeError(
      'context-mismatch',
      `${pin.userId}'s device list is not for the verified identity`
    );
  }
  if (!deviceListChainsFrom(list, pin.deviceListHead)) {
    throw new E2eeError(
      'chain-broken',
      `${pin.userId}'s device list does not chain from the pinned head`
    );
  }
  return {
    encryptionKey: currentEncryptionKey(list),
    latestHead: copyBytes(list.latestHash),
    advanced: !equalBytes(list.latestHash, pin.deviceListHead)
  };
}
