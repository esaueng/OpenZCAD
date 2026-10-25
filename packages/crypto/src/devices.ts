import {
  ByteReader,
  ByteWriter,
  asBytes,
  concatBytes,
  copyBytes,
  equalBytes,
  fromBase64Url,
  isUint,
  label,
  toHex,
  utf8,
  type Bytes
} from './bytes';
import { publicKeyHash } from './codes';
import { E2eeError, type E2eeErrorCode } from './errors';
import { HASH_BYTES, MAX_ID_BYTES, isEnvelopeId } from './header';
import {
  P256_PUBLIC_KEY_BYTES,
  exportPublicKey,
  importSigningPublicKey,
  isP256Key
} from './keys';
import { KEY_BYTES, sha256, subtle } from './primitives';
import { ecdsaSign, type SigningPrivateKey } from './external-keys';

/**
 * The identity-signed device list (ADR-024, Key hierarchy and Unlock and
 * devices). Each entry is a full snapshot of what the user's identity key
 * certifies right now: every live device (its signing key and its unlock
 * key), every unlock method's public-key target (the recovery key and any
 * passkeys), the current encryption public key and a commitment to the
 * current account key. Entries chain by hash from a first entry, and a
 * browser pins the newest one it has seen, so a hidden revocation or a
 * forked list is refused (fork consistency).
 *
 * Removal is explicit: an entry that drops a device or target names it in
 * `revoked`, and must rotate the encryption key and the account key in the
 * same entry. A revoked id or key never returns. The recovery-key target is
 * fixed for the life of an identity: replacing the recovery key replaces
 * the identity and starts a fresh list.
 *
 * A device revocation may name the device that replaces it (`replacedBy`),
 * which must be live in the same entry. Entries that name one use format
 * version 2; every other entry keeps version 1, byte for byte, so lists
 * signed before version 2 existed verify unchanged.
 */

export const DEVICE_LIST_VERSION_1 = 1;
/** Version 1 plus a replacement device id on each revocation. */
export const DEVICE_LIST_VERSION_2 = 2;
const DEVICE_LIST_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x44); // "OZD"
const TRANSITION_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x54); // "OZT"
const GRANT_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x47); // "OZG"
const CUTOFFS_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x52); // "OZR"
const RESET_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x58); // "OZX"
const STATEMENT_VERSION_1 = 1;
const SIGNATURE_BYTES = 1 + 64;
const MAX_U32 = 0xffffffff;

export const MAX_LISTED_DEVICES = 64;
export const MAX_UNLOCK_TARGETS = 16;
export const MAX_DEVICE_LABEL_BYTES = 64;
/** Most entries one `verifyDeviceList` call accepts. */
export const MAX_DEVICE_LIST_ENTRIES = 1024;
/** Largest canonical entry: 64 devices and 16 targets with long ids. */
export const MAX_DEVICE_LIST_ENTRY_BYTES = 32 * 1024;

export const UNLOCK_TARGET_KINDS = Object.freeze([
  'recovery-key',
  'passkey'
] as const);
export type UnlockTargetKind = (typeof UNLOCK_TARGET_KINDS)[number];
export type RevocationKind = 'device' | 'unlock-target';

/** A device the identity key certifies. */
export interface ListedDevice {
  /** Printable ASCII, 1–128 bytes; unique in the list, never reused. */
  readonly deviceId: string;
  /** What the user calls it ("Chrome on macOS"); 1–64 bytes of UTF-8. */
  readonly label: string;
  /** Raw ECDSA P-256 public key that signs versions and roster entries. */
  readonly signingKey: Uint8Array;
  /** Raw ECDH P-256 public key the account key is sealed to. */
  readonly unlockKey: Uint8Array;
  /** Unix milliseconds, as the certifying browser recorded it. */
  readonly addedAt: number;
}

/** An unlock method's ECDH target; its private half sits under the method's secret. */
export interface UnlockTarget {
  readonly kind: UnlockTargetKind;
  readonly targetId: string;
  readonly publicKey: Uint8Array;
  readonly addedAt: number;
}

export interface Revocation {
  readonly kind: RevocationKind;
  readonly id: string;
  /**
   * For a device: the device that replaces it, live in the same entry. It
   * is the device the MLS last-leaf exception lets rejoin a project whose
   * only leaf of this user was the revoked device. Absent otherwise.
   */
  readonly replacedBy?: string;
}

export interface DeviceListEntry {
  readonly userId: string;
  /** 0 for the first entry, then +1 per entry. */
  readonly sequence: number;
  /** `deviceListEntryHash` of the previous entry; null for the first. */
  readonly previousEntryHash: Uint8Array | null;
  /** Unix milliseconds; the signer's claim, not proof of time. */
  readonly issuedAt: number;
  /**
   * On a first entry made by replacing an identity: `publicKeyHash` of the
   * identity it replaces. Informational only; it proves nothing.
   */
  readonly previousIdentityKeyHash: Uint8Array | null;
  /** Raw ECDH P-256 public key that receives project keys. */
  readonly encryptionKey: Uint8Array;
  /** `accountKeyCommitment` of the current account key. */
  readonly accountKeyCommitment: Uint8Array;
  readonly devices: readonly ListedDevice[];
  readonly unlockTargets: readonly UnlockTarget[];
  /** What this entry removes from the previous one; empty otherwise. */
  readonly revoked: readonly Revocation[];
}

export interface SignedDeviceListEntry {
  /** Canonical `encodeDeviceListEntry` bytes. */
  readonly entry: Uint8Array;
  /** `u8 version = 1 | 64-byte r || s` by the identity key. */
  readonly signature: Uint8Array;
}

/** The newest entry a browser has accepted for a user. */
export interface DeviceListPin {
  readonly identityKeyHash: Uint8Array;
  readonly sequence: number;
  readonly entryHash: Uint8Array;
}

const TARGET_CODES: Record<UnlockTargetKind, number> = {
  'recovery-key': 1,
  passkey: 2
};
const REVOCATION_CODES: Record<RevocationKind, number> = {
  device: 1,
  'unlock-target': 2
};

const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === HASH_BYTES;
}

function isRawPublicKey(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    value.byteLength === P256_PUBLIC_KEY_BYTES &&
    value[0] === 0x04
  );
}

/** Labels are what people read: no control characters, no empty text. */
function isDeviceLabel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  let bytes: Bytes;
  try {
    bytes = utf8(value);
  } catch {
    return false;
  }
  return bytes.byteLength <= MAX_DEVICE_LABEL_BYTES;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function checkEntry(entry: DeviceListEntry, code: E2eeErrorCode): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (entry === null || typeof entry !== 'object') fail('Expected an entry');
  if (!isEnvelopeId(entry.userId)) fail('Device list userId is not an id');
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
  if (entry.previousIdentityKeyHash !== null) {
    if (!isHash(entry.previousIdentityKeyHash)) {
      fail('previousIdentityKeyHash must be 32 bytes');
    }
    if (entry.sequence !== 0) {
      fail('Only a first entry names the identity it replaces');
    }
  }
  if (!isRawPublicKey(entry.encryptionKey)) {
    fail('encryptionKey must be a raw P-256 public key');
  }
  if (!isHash(entry.accountKeyCommitment)) {
    fail('accountKeyCommitment must be 32 bytes');
  }
  if (
    !Array.isArray(entry.devices) ||
    entry.devices.length === 0 ||
    entry.devices.length > MAX_LISTED_DEVICES
  ) {
    fail(`A device list certifies 1..${MAX_LISTED_DEVICES} devices`);
  }
  if (
    !Array.isArray(entry.unlockTargets) ||
    entry.unlockTargets.length === 0 ||
    entry.unlockTargets.length > MAX_UNLOCK_TARGETS
  ) {
    fail(`A device list certifies 1..${MAX_UNLOCK_TARGETS} unlock targets`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>([toHex(entry.encryptionKey)]);
  const claim = (id: unknown, what: string): void => {
    if (!isEnvelopeId(id)) fail(`${what} id is not an id`);
    if (ids.has(id as string)) fail('Device and target ids must be unique');
    ids.add(id as string);
  };
  const claimKey = (key: unknown, what: string): void => {
    if (!isRawPublicKey(key)) fail(`${what} must be a raw P-256 public key`);
    const hex = toHex(key as Uint8Array);
    if (keys.has(hex)) fail('Every certified public key must be distinct');
    keys.add(hex);
  };
  for (const device of entry.devices) {
    claim(device?.deviceId, 'Device');
    if (!isDeviceLabel(device.label)) {
      fail(`Device labels are 1..${MAX_DEVICE_LABEL_BYTES} bytes of text`);
    }
    claimKey(device.signingKey, 'signingKey');
    claimKey(device.unlockKey, 'unlockKey');
    if (!isUint(device.addedAt, Number.MAX_SAFE_INTEGER)) {
      fail('addedAt must be Unix milliseconds');
    }
  }
  let recoveryTargets = 0;
  for (const target of entry.unlockTargets) {
    if (!UNLOCK_TARGET_KINDS.includes(target?.kind)) {
      fail('Unknown unlock target kind');
    }
    if (target.kind === 'recovery-key') recoveryTargets += 1;
    claim(target.targetId, 'Unlock target');
    claimKey(target.publicKey, 'Unlock target key');
    if (!isUint(target.addedAt, Number.MAX_SAFE_INTEGER)) {
      fail('addedAt must be Unix milliseconds');
    }
  }
  if (recoveryTargets !== 1) {
    fail('A device list certifies exactly one recovery-key target');
  }
  if (
    !Array.isArray(entry.revoked) ||
    entry.revoked.length > MAX_LISTED_DEVICES + MAX_UNLOCK_TARGETS
  ) {
    fail('Too many revocations in one entry');
  }
  if (entry.sequence === 0 && entry.revoked.length > 0) {
    fail('A first entry revokes nothing');
  }
  const revoked = new Set<string>();
  const liveDevices = new Set(entry.devices.map((device) => device.deviceId));
  for (const revocation of entry.revoked) {
    if (!Object.hasOwn(REVOCATION_CODES, revocation?.kind)) {
      fail('Unknown revocation kind');
    }
    if (!isEnvelopeId(revocation.id)) fail('Revocation id is not an id');
    if (revoked.has(revocation.id) || ids.has(revocation.id)) {
      fail('A revoked id is listed once and is not live in the same entry');
    }
    revoked.add(revocation.id);
    if (revocation.replacedBy !== undefined) {
      if (revocation.kind !== 'device') {
        fail('Only a device revocation names a replacement');
      }
      if (!isEnvelopeId(revocation.replacedBy)) {
        fail('Replacement device id is not an id');
      }
      if (!liveDevices.has(revocation.replacedBy)) {
        fail('A replacement device is live in the same entry');
      }
    }
  }
}

/** Version 2 exactly when some revocation names a replacement. */
function entryVersion(entry: DeviceListEntry): number {
  return entry.revoked.some((r) => r.replacedBy !== undefined)
    ? DEVICE_LIST_VERSION_2
    : DEVICE_LIST_VERSION_1;
}

function writeId(writer: ByteWriter, id: string): void {
  writer.u8(id.length).bytes(ascii.encode(id));
}

function readId(reader: ByteReader): string {
  return asciiDecoder.decode(reader.bytes(reader.u8()));
}

function writeOptionalHash(writer: ByteWriter, hash: Uint8Array | null): void {
  writer.u8(hash?.byteLength ?? 0);
  if (hash) writer.bytes(hash);
}

function readOptionalHash(reader: ByteReader): Bytes | null {
  const length = reader.u8();
  return length === 0 ? null : copyBytes(reader.bytes(length));
}

/**
 * Canonical bytes: `"OZD" | u8 version | u32 sequence | u8 (0|32) +
 * previous entry hash | u8 length + user id | u64 issuedAt | u8 (0|32) +
 * previous identity key hash | 65-byte encryption key | 32-byte account key
 * commitment | u16 count + devices by id (u8 length + id, u8 length + UTF-8
 * label, 65-byte signing key, 65-byte unlock key, u64 addedAt) | u16 count +
 * unlock targets by id (u8 kind, u8 length + id, 65-byte key, u64 addedAt) |
 * u16 count + revocations by kind then id (u8 kind, u8 length + id)`.
 *
 * Version 2 is the same with `u8 length + replacement device id` (0 for
 * none) after each revocation's id, and is used exactly when at least one
 * revocation names a replacement, so every entry has one encoding.
 */
export function encodeDeviceListEntry(entry: DeviceListEntry): Bytes {
  checkEntry(entry, 'invalid-argument');
  const version = entryVersion(entry);
  const writer = new ByteWriter()
    .bytes(DEVICE_LIST_MAGIC)
    .u8(version)
    .u32(entry.sequence);
  writeOptionalHash(writer, entry.previousEntryHash);
  writeId(writer, entry.userId);
  writer.u64(entry.issuedAt);
  writeOptionalHash(writer, entry.previousIdentityKeyHash);
  writer
    .bytes(entry.encryptionKey)
    .bytes(entry.accountKeyCommitment)
    .u16(entry.devices.length);
  for (const device of [...entry.devices].sort((a, b) =>
    byId(a.deviceId, b.deviceId)
  )) {
    const labelBytes = utf8(device.label);
    writeId(writer, device.deviceId);
    writer
      .u8(labelBytes.byteLength)
      .bytes(labelBytes)
      .bytes(device.signingKey)
      .bytes(device.unlockKey)
      .u64(device.addedAt);
  }
  writer.u16(entry.unlockTargets.length);
  for (const target of [...entry.unlockTargets].sort((a, b) =>
    byId(a.targetId, b.targetId)
  )) {
    writer.u8(TARGET_CODES[target.kind]);
    writeId(writer, target.targetId);
    writer.bytes(target.publicKey).u64(target.addedAt);
  }
  writer.u16(entry.revoked.length);
  for (const revocation of [...entry.revoked].sort(
    (a, b) =>
      REVOCATION_CODES[a.kind] - REVOCATION_CODES[b.kind] || byId(a.id, b.id)
  )) {
    writer.u8(REVOCATION_CODES[revocation.kind]);
    writeId(writer, revocation.id);
    if (version === DEVICE_LIST_VERSION_2) {
      if (revocation.replacedBy === undefined) writer.u8(0);
      else writeId(writer, revocation.replacedBy);
    }
  }
  const bytes = writer.finish();
  // The same bound the decoder enforces, so nothing is signed that no
  // verifier will accept.
  if (bytes.byteLength > MAX_DEVICE_LIST_ENTRY_BYTES) {
    throw new E2eeError('limit-exceeded', 'Device list entry is too large');
  }
  return bytes;
}

function kindFor<K extends string>(
  codes: Record<K, number>,
  value: number,
  what: string
): K {
  const kind = (Object.keys(codes) as K[]).find((key) => codes[key] === value);
  if (!kind) throw new E2eeError('malformed', `Unknown ${what} kind ${value}`);
  return kind;
}

/** Decodes canonical entry bytes; anything else is `malformed`. */
export function decodeDeviceListEntry(bytes: Uint8Array): DeviceListEntry {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Entry must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_DEVICE_LIST_ENTRY_BYTES) {
    throw new E2eeError('limit-exceeded', 'Device list entry is too large');
  }
  const reader = new ByteReader(bytes, 'Device list entry');
  if (!equalBytes(reader.bytes(3), DEVICE_LIST_MAGIC)) {
    throw new E2eeError('malformed', 'Not a device list entry');
  }
  const version = reader.u8();
  if (version !== DEVICE_LIST_VERSION_1 && version !== DEVICE_LIST_VERSION_2) {
    throw new E2eeError(
      'unsupported-version',
      `Device list version ${version} is not supported`
    );
  }
  const sequence = reader.u32();
  const previousEntryHash = readOptionalHash(reader);
  const userId = readId(reader);
  const issuedAt = reader.u64();
  const previousIdentityKeyHash = readOptionalHash(reader);
  const encryptionKey = copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES));
  const accountKeyCommitment = copyBytes(reader.bytes(HASH_BYTES));
  const devices: ListedDevice[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const deviceId = readId(reader);
    let deviceLabel: string;
    try {
      deviceLabel = utf8Decoder.decode(reader.bytes(reader.u8()));
    } catch (cause) {
      if (cause instanceof E2eeError) throw cause;
      throw new E2eeError('malformed', 'Device label is not UTF-8', { cause });
    }
    devices.push({
      deviceId,
      label: deviceLabel,
      signingKey: copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES)),
      unlockKey: copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES)),
      addedAt: reader.u64()
    });
  }
  const unlockTargets: UnlockTarget[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const kind = kindFor(TARGET_CODES, reader.u8(), 'unlock target');
    unlockTargets.push({
      kind,
      targetId: readId(reader),
      publicKey: copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES)),
      addedAt: reader.u64()
    });
  }
  const revoked: Revocation[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const kind = kindFor(REVOCATION_CODES, reader.u8(), 'revocation');
    const id = readId(reader);
    const replacedBy = version === DEVICE_LIST_VERSION_2 ? readId(reader) : '';
    revoked.push(replacedBy ? { kind, id, replacedBy } : { kind, id });
  }
  reader.end();
  const entry: DeviceListEntry = {
    userId,
    sequence,
    previousEntryHash,
    issuedAt,
    previousIdentityKeyHash,
    encryptionKey,
    accountKeyCommitment,
    devices,
    unlockTargets,
    revoked
  };
  checkEntry(entry, 'malformed');
  if (!equalBytes(encodeDeviceListEntry(entry), bytes)) {
    throw new E2eeError(
      'malformed',
      'Device list entry is not in canonical form'
    );
  }
  return entry;
}

/** What the next entry and every pin name. */
export async function deviceListEntryHash(entry: Uint8Array): Promise<Bytes> {
  return sha256(concatBytes(label('v1 device list entry hash'), entry));
}

/**
 * Commits to the account key without revealing it: the key has full
 * entropy, so its labelled hash cannot be inverted. Every unlock checks the
 * opened account key against the commitment the identity key certified, so
 * a server that seals a key of its own to a device's public key is caught.
 */
export async function accountKeyCommitment(
  accountKey: Uint8Array
): Promise<Bytes> {
  if (!(accountKey instanceof Uint8Array) || accountKey.byteLength !== 32) {
    throw new E2eeError('invalid-argument', 'An account key is 32 bytes');
  }
  return sha256(
    concatBytes(label('v1 account key commitment'), copyBytes(accountKey))
  );
}

// --- Statements signed by the identity key or a device key ----------------

/** @internal What an identity- or device-signed statement is, for its label. */
export type StatementKind =
  | 'device list'
  | 'identity transition'
  | 'device approval grant'
  | 'revocation cutoffs'
  | 'group reset'
  | 'contacts list'
  | 'share delegation'
  | 'share authority'
  | 'share link grant'
  | 'share link tombstone'
  | 'project invitation';

/** @internal `u8 1 | r || s` over `label "v1 <kind> signature" | statement`. */
export async function signStatement(
  privateKey: SigningPrivateKey,
  kind: StatementKind,
  statement: Uint8Array
): Promise<Bytes> {
  const rs = await ecdsaSign(
    privateKey,
    concatBytes(label(`v1 ${kind} signature`), statement)
  );
  return concatBytes(Uint8Array.of(STATEMENT_VERSION_1), rs);
}

/** @internal A public key to verify with, and its raw bytes. */
export async function verifyingKey(publicKey: Uint8Array | CryptoKey): Promise<{
  key: CryptoKey;
  raw: Bytes;
}> {
  if (publicKey instanceof Uint8Array) {
    const raw = copyBytes(publicKey);
    return { key: await importSigningPublicKey(raw), raw };
  }
  if (!isP256Key(publicKey, 'ECDSA', 'public')) {
    throw new E2eeError(
      'invalid-argument',
      'Expected a P-256 ECDSA public key'
    );
  }
  return { key: publicKey, raw: await exportPublicKey(publicKey) };
}

/** @internal Whether `signature` is `kind`'s signature over `statement`. */
export async function statementValid(
  key: CryptoKey,
  kind: StatementKind,
  statement: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
    throw new E2eeError('malformed', `${kind} signature is empty`);
  }
  if (signature[0] !== STATEMENT_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `${kind} signature version ${signature[0]} is not supported`
    );
  }
  if (signature.byteLength !== SIGNATURE_BYTES) {
    throw new E2eeError('malformed', `${kind} signature has the wrong length`);
  }
  try {
    return await subtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      asBytes(signature.subarray(1)),
      concatBytes(label(`v1 ${kind} signature`), statement)
    );
  } catch {
    // Engines differ on out-of-range r or s: Node returns false, others may
    // throw. Either way the signature is not valid.
    return false;
  }
}

/** The identity key signs a device-list entry: a certification or removal. */
export async function signDeviceListEntry(
  identityPrivateKey: CryptoKey,
  entry: DeviceListEntry
): Promise<SignedDeviceListEntry> {
  const bytes = encodeDeviceListEntry(entry);
  return {
    entry: bytes,
    signature: await signStatement(identityPrivateKey, 'device list', bytes)
  };
}

// --- Verified device lists ------------------------------------------------

export interface DeviceRecord extends ListedDevice {
  /** `publicKeyHash` of the signing key: how signatures name the device. */
  readonly signingKeyHash: Bytes;
  /** Sequence of the first entry that certified it. */
  readonly certifiedAt: number;
}

export interface RevokedRecord {
  readonly kind: RevocationKind;
  readonly id: string;
  /** Sequence of the entry that removed it. */
  readonly revokedAt: number;
  /** Set for a device: what it was, so its signatures can be refused. */
  readonly device?: DeviceRecord;
  readonly target?: UnlockTarget;
  /** For a device: the device its revocation named as replacement. */
  readonly replacedBy?: string;
}

export interface VerifiedDeviceList {
  readonly userId: string;
  /** The raw identity public key the list was verified against. */
  readonly identityKey: Bytes;
  /** `publicKeyHash` of the identity key: the user's fingerprint. */
  readonly identityKeyHash: Bytes;
  readonly entries: readonly {
    readonly entry: DeviceListEntry;
    readonly hash: Bytes;
  }[];
  readonly head: DeviceListEntry;
  readonly headHash: Bytes;
  /** Live devices of the newest entry. */
  readonly devices: readonly DeviceRecord[];
  /** Unlock targets of the newest entry. */
  readonly unlockTargets: readonly UnlockTarget[];
  /** Everything ever removed, oldest first. */
  readonly revoked: readonly RevokedRecord[];
  /** The pin to keep after accepting this list. */
  readonly pin: DeviceListPin;
}

function sameDevice(a: ListedDevice, b: ListedDevice): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.label === b.label &&
    a.addedAt === b.addedAt &&
    equalBytes(a.signingKey, b.signingKey) &&
    equalBytes(a.unlockKey, b.unlockKey)
  );
}

function sameTarget(a: UnlockTarget, b: UnlockTarget): boolean {
  return (
    a.kind === b.kind &&
    a.targetId === b.targetId &&
    a.addedAt === b.addedAt &&
    equalBytes(a.publicKey, b.publicKey)
  );
}

function broken(message: string): never {
  throw new E2eeError('chain-broken', message);
}

/**
 * Checks one step of the list: what the identity key may change between
 * consecutive entries.
 */
function checkTransition(
  previous: DeviceListEntry,
  next: DeviceListEntry,
  seen: { ids: Set<string>; keys: Set<string>; rotated: Set<string> }
): void {
  const at = `Device list entry ${next.sequence}`;
  const revoked = new Map(next.revoked.map((r) => [r.id, r.kind]));
  const nextDevices = new Map(next.devices.map((d) => [d.deviceId, d]));
  const nextTargets = new Map(next.unlockTargets.map((t) => [t.targetId, t]));
  for (const device of previous.devices) {
    const kept = nextDevices.get(device.deviceId);
    if (kept) {
      if (!sameDevice(device, kept)) broken(`${at} changes a live device`);
    } else if (revoked.get(device.deviceId) !== 'device') {
      broken(`${at} drops device ${device.deviceId} without revoking it`);
    }
  }
  for (const target of previous.unlockTargets) {
    const kept = nextTargets.get(target.targetId);
    if (kept) {
      if (!sameTarget(target, kept)) broken(`${at} changes an unlock target`);
    } else if (target.kind === 'recovery-key') {
      broken(
        `${at} removes the recovery key; replacing it replaces the identity`
      );
    } else if (revoked.get(target.targetId) !== 'unlock-target') {
      broken(
        `${at} drops unlock target ${target.targetId} without revoking it`
      );
    }
  }
  const previousIds = new Set([
    ...previous.devices.map((d) => d.deviceId),
    ...previous.unlockTargets.map((t) => t.targetId)
  ]);
  for (const revocation of next.revoked) {
    if (!previousIds.has(revocation.id)) {
      broken(`${at} revokes ${revocation.id}, which was not live`);
    }
  }
  for (const device of next.devices) {
    if (!previous.devices.some((d) => d.deviceId === device.deviceId)) {
      if (
        seen.ids.has(device.deviceId) ||
        seen.keys.has(toHex(device.signingKey)) ||
        seen.keys.has(toHex(device.unlockKey))
      ) {
        broken(`${at} brings back a removed or reused device`);
      }
    }
  }
  for (const target of next.unlockTargets) {
    if (!previous.unlockTargets.some((t) => t.targetId === target.targetId)) {
      if (target.kind === 'recovery-key') {
        broken(`${at} adds a second recovery key`);
      }
      if (
        seen.ids.has(target.targetId) ||
        seen.keys.has(toHex(target.publicKey))
      ) {
        broken(`${at} brings back a removed or reused unlock target`);
      }
    }
  }
  const encryptionChanged = !equalBytes(
    previous.encryptionKey,
    next.encryptionKey
  );
  const accountChanged = !equalBytes(
    previous.accountKeyCommitment,
    next.accountKeyCommitment
  );
  if (encryptionChanged !== accountChanged) {
    broken(`${at} must rotate the account and encryption keys together`);
  }
  if (next.revoked.length > 0 && !(encryptionChanged && accountChanged)) {
    broken(
      `${at} removes access without rotating the account and encryption keys`
    );
  }
  if (encryptionChanged && seen.rotated.has(toHex(next.encryptionKey))) {
    broken(`${at} brings back a replaced encryption key`);
  }
  if (accountChanged && seen.rotated.has(toHex(next.accountKeyCommitment))) {
    broken(`${at} brings back a replaced account key`);
  }
}

/** Every id and key an entry names, for the never-return rules. */
function noteEntry(
  entry: DeviceListEntry,
  seen: { ids: Set<string>; keys: Set<string>; rotated: Set<string> }
): void {
  for (const device of entry.devices) {
    seen.ids.add(device.deviceId);
    seen.keys.add(toHex(device.signingKey));
    seen.keys.add(toHex(device.unlockKey));
  }
  for (const target of entry.unlockTargets) {
    seen.ids.add(target.targetId);
    seen.keys.add(toHex(target.publicKey));
  }
  seen.rotated.add(toHex(entry.encryptionKey));
  seen.rotated.add(toHex(entry.accountKeyCommitment));
}

function checkPin(pin: DeviceListPin): void {
  if (
    pin === null ||
    typeof pin !== 'object' ||
    !isHash(pin.identityKeyHash) ||
    !isHash(pin.entryHash) ||
    !isUint(pin.sequence, MAX_U32)
  ) {
    throw new E2eeError('invalid-argument', 'Not a device list pin');
  }
}

/**
 * Verifies a user's whole device list, oldest first, against an identity
 * key: every entry is canonical and identity-signed, the chain starts at
 * sequence 0 and links by hash, every change follows the rules above, and
 * every public key is a real P-256 point.
 *
 * With `pin` (the newest entry this browser accepted), the identity must be
 * the pinned one (`context-mismatch` otherwise: the identity was replaced)
 * and the chain must contain the pinned entry, so a rolled-back or forked
 * list fails with `chain-broken`. Accepting the result moves the pin to
 * `result.pin`.
 */
export async function verifyDeviceList(
  identityPublicKey: Uint8Array | CryptoKey,
  chain: readonly SignedDeviceListEntry[],
  options: { readonly pin?: DeviceListPin } = {}
): Promise<VerifiedDeviceList> {
  if (!Array.isArray(chain) || chain.length === 0) {
    broken('Device list is empty');
  }
  if (chain.length > MAX_DEVICE_LIST_ENTRIES) {
    throw new E2eeError(
      'limit-exceeded',
      `A device list holds at most ${MAX_DEVICE_LIST_ENTRIES} entries`
    );
  }
  const pin = options.pin;
  if (pin !== undefined) checkPin(pin);
  const { key, raw: identityKey } = await verifyingKey(identityPublicKey);
  const identityKeyHash = await publicKeyHash(identityKey);
  if (pin && !equalBytes(pin.identityKeyHash, identityKeyHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The identity key is not the one this browser pinned'
    );
  }
  // Copy the chain before the first await below, so a caller editing it
  // meanwhile cannot change what is verified.
  const captured = (chain as readonly SignedDeviceListEntry[]).map(
    (signed) => ({
      entry: copyBytes(signed.entry),
      signature: copyBytes(signed.signature)
    })
  );
  const entries: { entry: DeviceListEntry; hash: Bytes }[] = [];
  const certifiedAt = new Map<string, number>();
  const revoked: RevokedRecord[] = [];
  const seen = {
    ids: new Set<string>(),
    keys: new Set<string>(),
    rotated: new Set<string>()
  };
  const pointsChecked = new Set<string>();
  for (const signed of captured) {
    const entry = decodeDeviceListEntry(signed.entry);
    if (
      !(await statementValid(
        key,
        'device list',
        signed.entry,
        signed.signature
      ))
    ) {
      throw new E2eeError(
        'authentication-failed',
        `Device list entry ${entry.sequence} is not signed by the identity key`
      );
    }
    const hash = await deviceListEntryHash(signed.entry);
    const before = entries.at(-1);
    if (!before) {
      if (entry.sequence !== 0)
        broken('Device list must start at its first entry');
    } else {
      if (entry.userId !== before.entry.userId) {
        broken('Device list changes user');
      }
      if (
        entry.sequence !== before.entry.sequence + 1 ||
        entry.previousEntryHash === null ||
        !equalBytes(entry.previousEntryHash, before.hash)
      ) {
        broken(
          `Device list entry ${entry.sequence} does not follow its predecessor`
        );
      }
      checkTransition(before.entry, entry, seen);
      for (const revocation of entry.revoked) {
        const device = before.entry.devices.find(
          (d) => d.deviceId === revocation.id
        );
        const target = before.entry.unlockTargets.find(
          (t) => t.targetId === revocation.id
        );
        revoked.push({
          kind: revocation.kind,
          id: revocation.id,
          revokedAt: entry.sequence,
          ...(device
            ? {
                device: {
                  ...device,
                  signingKeyHash: await publicKeyHash(device.signingKey),
                  certifiedAt: certifiedAt.get(device.deviceId) ?? 0
                }
              }
            : {}),
          ...(target ? { target } : {}),
          ...(revocation.replacedBy === undefined
            ? {}
            : { replacedBy: revocation.replacedBy })
        });
      }
    }
    // Every key people or code will rely on must be a real point; check each
    // new one once (publicKeyHash imports it).
    for (const point of [
      entry.encryptionKey,
      ...entry.devices.flatMap((d) => [d.signingKey, d.unlockKey]),
      ...entry.unlockTargets.map((t) => t.publicKey)
    ]) {
      const hex = toHex(point);
      if (!pointsChecked.has(hex)) {
        try {
          await publicKeyHash(point);
        } catch (cause) {
          throw new E2eeError('malformed', 'Device list names an invalid key', {
            cause
          });
        }
        pointsChecked.add(hex);
      }
    }
    for (const device of entry.devices) {
      if (!certifiedAt.has(device.deviceId)) {
        certifiedAt.set(device.deviceId, entry.sequence);
      }
    }
    noteEntry(entry, seen);
    entries.push({ entry, hash });
  }
  const last = entries.at(-1)!;
  if (pin) {
    const pinned = entries[pin.sequence];
    if (!pinned || !equalBytes(pinned.hash, pin.entryHash)) {
      broken(
        'Device list does not contain the entry this browser pinned: rolled back or forked'
      );
    }
  }
  const devices: DeviceRecord[] = [];
  for (const device of last.entry.devices) {
    devices.push({
      ...device,
      signingKeyHash: await publicKeyHash(device.signingKey),
      certifiedAt: certifiedAt.get(device.deviceId)!
    });
  }
  return {
    userId: last.entry.userId,
    identityKey,
    identityKeyHash,
    entries,
    head: last.entry,
    headHash: last.hash,
    devices,
    unlockTargets: last.entry.unlockTargets,
    revoked,
    pin: {
      identityKeyHash,
      sequence: last.entry.sequence,
      entryHash: last.hash
    }
  };
}

/** The recovery-key target of a verified list (there is always exactly one). */
export function recoveryTarget(list: VerifiedDeviceList): UnlockTarget {
  return list.unlockTargets.find((target) => target.kind === 'recovery-key')!;
}

/**
 * Names an account key within one identity's list: the sequence of the
 * entry that first committed to it (0 for the identity's first key). A
 * replaced commitment never returns, so each key covers one run of entries.
 * This is the `keySequence` of the key's `previous-account-key` wrap.
 *
 * Returns the key current at entry `at` (the head by default), or every
 * key the list has committed to, oldest first, with `accountKeySequences`.
 */
export function accountKeySequence(
  list: Pick<VerifiedDeviceList, 'entries'>,
  at: number = list.entries.length - 1
): number {
  if (!Number.isSafeInteger(at) || at < 0 || at >= list.entries.length) {
    throw new E2eeError('invalid-argument', `Entry ${at} is not in the list`);
  }
  let first = at;
  const commitment = list.entries[at]!.entry.accountKeyCommitment;
  while (
    first > 0 &&
    equalBytes(list.entries[first - 1]!.entry.accountKeyCommitment, commitment)
  ) {
    first -= 1;
  }
  return list.entries[first]!.entry.sequence;
}

export function accountKeySequences(
  list: Pick<VerifiedDeviceList, 'entries'>
): number[] {
  return list.entries
    .filter(
      ({ entry }, index) =>
        index === 0 ||
        !equalBytes(
          list.entries[index - 1]!.entry.accountKeyCommitment,
          entry.accountKeyCommitment
        )
    )
    .map(({ entry }) => entry.sequence);
}

export interface DeviceListChange {
  readonly issuedAt: number;
  readonly addDevices?: readonly ListedDevice[];
  readonly removeDeviceIds?: readonly string[];
  /** A device live in the new entry that replaces every removed device. */
  readonly replacedBy?: string;
  readonly addUnlockTargets?: readonly UnlockTarget[];
  readonly removeUnlockTargetIds?: readonly string[];
  /** A new encryption key; required whenever anything is removed. */
  readonly encryptionKey?: Uint8Array;
  /** The new account key's commitment; required with a new encryption key. */
  readonly accountKeyCommitment?: Uint8Array;
}

/**
 * The entry that follows a verified list's head: the head's devices and
 * targets with the change applied. Removing anything requires the rotated
 * keys, which `verifyDeviceList` enforces as well.
 */
export function nextDeviceListEntry(
  list: VerifiedDeviceList,
  change: DeviceListChange
): DeviceListEntry {
  const removeDevices = new Set(change.removeDeviceIds ?? []);
  const removeTargets = new Set(change.removeUnlockTargetIds ?? []);
  for (const id of removeDevices) {
    if (!list.head.devices.some((d) => d.deviceId === id)) {
      throw new E2eeError('invalid-argument', `Device ${id} is not live`);
    }
  }
  for (const id of removeTargets) {
    const target = list.head.unlockTargets.find((t) => t.targetId === id);
    if (!target) {
      throw new E2eeError(
        'invalid-argument',
        `Unlock target ${id} is not live`
      );
    }
    if (target.kind === 'recovery-key') {
      throw new E2eeError(
        'invalid-argument',
        'Replace the recovery key by replacing the identity'
      );
    }
  }
  const removes = removeDevices.size + removeTargets.size > 0;
  if (removes && !(change.encryptionKey && change.accountKeyCommitment)) {
    throw new E2eeError(
      'invalid-argument',
      'Removing access rotates the account and encryption keys'
    );
  }
  if (Boolean(change.encryptionKey) !== Boolean(change.accountKeyCommitment)) {
    throw new E2eeError(
      'invalid-argument',
      'The account and encryption keys rotate together'
    );
  }
  const replacedBy = change.replacedBy;
  if (replacedBy !== undefined) {
    if (removeDevices.size === 0) {
      throw new E2eeError(
        'invalid-argument',
        'A replacement names the device that replaces a removed one'
      );
    }
    const live =
      (list.head.devices.some((d) => d.deviceId === replacedBy) &&
        !removeDevices.has(replacedBy)) ||
      (change.addDevices ?? []).some((d) => d.deviceId === replacedBy);
    if (!live) {
      throw new E2eeError(
        'invalid-argument',
        `Replacement device ${replacedBy} is not live in the new entry`
      );
    }
  }
  return {
    userId: list.userId,
    sequence: list.head.sequence + 1,
    previousEntryHash: copyBytes(list.headHash),
    issuedAt: change.issuedAt,
    previousIdentityKeyHash: null,
    encryptionKey: change.encryptionKey ?? list.head.encryptionKey,
    accountKeyCommitment:
      change.accountKeyCommitment ?? list.head.accountKeyCommitment,
    devices: [
      ...list.head.devices.filter((d) => !removeDevices.has(d.deviceId)),
      ...(change.addDevices ?? [])
    ],
    unlockTargets: [
      ...list.head.unlockTargets.filter((t) => !removeTargets.has(t.targetId)),
      ...(change.addUnlockTargets ?? [])
    ],
    revoked: [
      ...[...removeDevices].map((id) => ({
        kind: 'device' as const,
        id,
        ...(replacedBy === undefined ? {} : { replacedBy })
      })),
      ...[...removeTargets].map((id) => ({
        kind: 'unlock-target' as const,
        id
      }))
    ]
  };
}

// --- Identity transition --------------------------------------------------

export type TransitionSigner = 'identity' | 'device';

/**
 * Accompanies a replaced identity (ADR-024, Key lifecycle). Signed by the
 * old identity key when it can still be opened, otherwise by a device key
 * the old identity certified and never revoked. It proves nothing to anyone
 * else, since an attacker holding either could sign one too; contacts verify
 * the new identity outside OpenZCAD.
 */
export interface IdentityTransition {
  readonly userId: string;
  readonly oldIdentityKeyHash: Uint8Array;
  readonly newIdentityKey: Uint8Array;
  /** `deviceListEntryHash` of the new identity's first entry. */
  readonly newGenesisHash: Uint8Array;
  readonly signer: TransitionSigner;
  /** `publicKeyHash` of the signing key. */
  readonly signerKeyHash: Uint8Array;
  readonly signedAt: number;
}

export interface SignedStatement {
  readonly statement: Uint8Array;
  readonly signature: Uint8Array;
}

function encodeTransition(value: IdentityTransition): Bytes {
  if (
    !isEnvelopeId(value?.userId) ||
    !isHash(value.oldIdentityKeyHash) ||
    !isRawPublicKey(value.newIdentityKey) ||
    !isHash(value.newGenesisHash) ||
    (value.signer !== 'identity' && value.signer !== 'device') ||
    !isHash(value.signerKeyHash) ||
    !isUint(value.signedAt, Number.MAX_SAFE_INTEGER)
  ) {
    throw new E2eeError('invalid-argument', 'Not an identity transition');
  }
  const writer = new ByteWriter().bytes(TRANSITION_MAGIC).u8(1);
  writeId(writer, value.userId);
  return writer
    .bytes(value.oldIdentityKeyHash)
    .bytes(value.newIdentityKey)
    .bytes(value.newGenesisHash)
    .u8(value.signer === 'identity' ? 1 : 2)
    .bytes(value.signerKeyHash)
    .u64(value.signedAt)
    .finish();
}

export function decodeIdentityTransition(
  bytes: Uint8Array
): IdentityTransition {
  const reader = new ByteReader(bytes, 'Identity transition');
  if (!equalBytes(reader.bytes(3), TRANSITION_MAGIC)) {
    throw new E2eeError('malformed', 'Not an identity transition');
  }
  const version = reader.u8();
  if (version !== 1) {
    throw new E2eeError(
      'unsupported-version',
      `Identity transition version ${version} is not supported`
    );
  }
  const userId = readId(reader);
  const oldIdentityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const newIdentityKey = copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES));
  const newGenesisHash = copyBytes(reader.bytes(HASH_BYTES));
  const signerCode = reader.u8();
  const signerKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const signedAt = reader.u64();
  reader.end();
  if (signerCode !== 1 && signerCode !== 2) {
    throw new E2eeError('malformed', 'Unknown transition signer');
  }
  const value: IdentityTransition = {
    userId,
    oldIdentityKeyHash,
    newIdentityKey,
    newGenesisHash,
    signer: signerCode === 1 ? 'identity' : 'device',
    signerKeyHash,
    signedAt
  };
  try {
    encodeTransition(value);
  } catch (cause) {
    throw new E2eeError('malformed', 'Not an identity transition', { cause });
  }
  return value;
}

export async function signIdentityTransition(
  signerPrivateKey: SigningPrivateKey,
  value: IdentityTransition
): Promise<SignedStatement> {
  const statement = encodeTransition(value);
  return {
    statement,
    signature: await signStatement(
      signerPrivateKey,
      'identity transition',
      statement
    )
  };
}

/**
 * Decodes a transition and checks its signature against `signerPublicKey`,
 * which must be the key the statement names. Choosing which key that may be
 * (the old identity, or a device it certified) is the caller's job.
 */
export async function verifyIdentityTransition(
  signed: SignedStatement,
  signerPublicKey: Uint8Array | CryptoKey
): Promise<IdentityTransition> {
  const statement = copyBytes(signed.statement);
  const value = decodeIdentityTransition(statement);
  const { key, raw } = await verifyingKey(signerPublicKey);
  if (!equalBytes(await publicKeyHash(raw), value.signerKeyHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The transition names a different signer'
    );
  }
  if (
    !(await statementValid(
      key,
      'identity transition',
      statement,
      signed.signature
    ))
  ) {
    throw new E2eeError(
      'authentication-failed',
      'Identity transition signature is not valid'
    );
  }
  return value;
}

// --- Device approval grant ------------------------------------------------

/**
 * What an approving device tells the device it approved, signed with its
 * own device key: which identity and device-list head the new device
 * should pin, and whether it was certified there. In the compare form the
 * approver's key is authenticated by the six-digit code, so the new device
 * pins this head without trusting the server for it.
 */
export interface DeviceApprovalGrant {
  readonly userId: string;
  /** `deviceKeysHash` of the approved device: what was compared or scanned. */
  readonly deviceKeysHash: Uint8Array;
  readonly deviceId: string;
  readonly identityKeyHash: Uint8Array;
  readonly headSequence: number;
  readonly headHash: Uint8Array;
  /** True when the head certifies the device; false for read-only approval. */
  readonly certified: boolean;
  /** `publicKeyHash` of the approver's signing key. */
  readonly approverKeyHash: Uint8Array;
  readonly issuedAt: number;
}

function encodeGrant(value: DeviceApprovalGrant): Bytes {
  if (
    !isEnvelopeId(value?.userId) ||
    !isHash(value.deviceKeysHash) ||
    !isEnvelopeId(value.deviceId) ||
    !isHash(value.identityKeyHash) ||
    !isUint(value.headSequence, MAX_U32) ||
    !isHash(value.headHash) ||
    typeof value.certified !== 'boolean' ||
    !isHash(value.approverKeyHash) ||
    !isUint(value.issuedAt, Number.MAX_SAFE_INTEGER)
  ) {
    throw new E2eeError('invalid-argument', 'Not a device approval grant');
  }
  const writer = new ByteWriter().bytes(GRANT_MAGIC).u8(1);
  writeId(writer, value.userId);
  writer.bytes(value.deviceKeysHash);
  writeId(writer, value.deviceId);
  return writer
    .bytes(value.identityKeyHash)
    .u32(value.headSequence)
    .bytes(value.headHash)
    .u8(value.certified ? 1 : 0)
    .bytes(value.approverKeyHash)
    .u64(value.issuedAt)
    .finish();
}

export function decodeDeviceApprovalGrant(
  bytes: Uint8Array
): DeviceApprovalGrant {
  const reader = new ByteReader(bytes, 'Device approval grant');
  if (!equalBytes(reader.bytes(3), GRANT_MAGIC)) {
    throw new E2eeError('malformed', 'Not a device approval grant');
  }
  const version = reader.u8();
  if (version !== 1) {
    throw new E2eeError(
      'unsupported-version',
      `Device approval grant version ${version} is not supported`
    );
  }
  const userId = readId(reader);
  const deviceKeysHash = copyBytes(reader.bytes(HASH_BYTES));
  const deviceId = readId(reader);
  const identityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const headSequence = reader.u32();
  const headHash = copyBytes(reader.bytes(HASH_BYTES));
  const certifiedCode = reader.u8();
  const approverKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const issuedAt = reader.u64();
  reader.end();
  if (certifiedCode > 1) {
    throw new E2eeError('malformed', 'Grant certified flag is not 0 or 1');
  }
  const value: DeviceApprovalGrant = {
    userId,
    deviceKeysHash,
    deviceId,
    identityKeyHash,
    headSequence,
    headHash,
    certified: certifiedCode === 1,
    approverKeyHash,
    issuedAt
  };
  try {
    encodeGrant(value);
  } catch (cause) {
    throw new E2eeError('malformed', 'Not a device approval grant', { cause });
  }
  return value;
}

export async function signDeviceApprovalGrant(
  approverSigningKey: SigningPrivateKey,
  value: DeviceApprovalGrant
): Promise<SignedStatement> {
  const statement = encodeGrant(value);
  return {
    statement,
    signature: await signStatement(
      approverSigningKey,
      'device approval grant',
      statement
    )
  };
}

/** Decodes a grant and checks it is signed by `approverPublicKey`. */
export async function verifyDeviceApprovalGrant(
  signed: SignedStatement,
  approverPublicKey: Uint8Array | CryptoKey
): Promise<DeviceApprovalGrant> {
  const statement = copyBytes(signed.statement);
  const value = decodeDeviceApprovalGrant(statement);
  const { key, raw } = await verifyingKey(approverPublicKey);
  if (!equalBytes(await publicKeyHash(raw), value.approverKeyHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The grant names a different approver'
    );
  }
  if (
    !(await statementValid(
      key,
      'device approval grant',
      statement,
      signed.signature
    ))
  ) {
    throw new E2eeError(
      'authentication-failed',
      'Device approval grant signature is not valid'
    );
  }
  return value;
}

// --- Per-project revocation cutoffs ---------------------------------------

export const REVOCATION_CUTOFFS_VERSION_1 = 1;
/** Version 1 plus each project's cutoff head (slice 4-10). */
export const REVOCATION_CUTOFFS_VERSION_2 = 2;
/** Most projects one cutoff statement names. */
export const MAX_REVOCATION_CUTOFFS = 4096;
const CUTOFFS_FIXED_BYTES =
  3 + 1 + 1 + MAX_ID_BYTES + 4 + 4 + HASH_BYTES + 8 + 2;
/** Largest canonical version 1 statement: every project id at its longest. */
export const MAX_REVOCATION_CUTOFFS_V1_BYTES =
  CUTOFFS_FIXED_BYTES + MAX_REVOCATION_CUTOFFS * (1 + MAX_ID_BYTES + 8);
/** Largest canonical statement of any version (version 2, with heads). */
export const MAX_REVOCATION_CUTOFFS_BYTES =
  CUTOFFS_FIXED_BYTES +
  MAX_REVOCATION_CUTOFFS * (1 + MAX_ID_BYTES + 8 + 8 + HASH_BYTES);

/**
 * The newest document version of a project the revoking browser had
 * accepted (ADR-024, Key lifecycle): the revoked device's signatures are
 * accepted only on this version or earlier ones.
 */
export interface RevocationCutoffHead {
  /** At least 1: a document's first version is 1. */
  readonly documentVersion: number;
  /** `versionHash` of that version's envelope. */
  readonly versionHash: Uint8Array;
}

/** The first epoch of a project's group that a revoked device must not know. */
export interface ProjectRevocationCutoff {
  readonly projectId: string;
  /**
   * Unsigned, at most `Number.MAX_SAFE_INTEGER`. Phase 4 uses the project's
   * key epoch (decision D10: monotonic across group resets), so the first
   * MLS epoch of a group is this minus the group's key-epoch base.
   */
  readonly cutoffEpoch: number;
  /** The cutoff head, if the project had one (version 2 statements). */
  readonly head?: RevocationCutoffHead;
}

/**
 * What the identity key signs when it removes a device (ADR-024, Key
 * lifecycle): a cutoff for each project the user belongs to, bound to the
 * device-list entry that revokes the device. Once a browser has seen the
 * statement it accepts the revoked device's work in a project only before
 * that project's cutoff. Phase 4 stores and enforces it; this is the format.
 */
export interface RevocationCutoffs {
  readonly userId: string;
  /** The identity generation of the revoking entry; 1 for the first. */
  readonly generation: number;
  /** Sequence of the device-list entry that revokes the device(s). */
  readonly entrySequence: number;
  /** `deviceListEntryHash` of that entry. */
  readonly entryHash: Uint8Array;
  /** Unix milliseconds; the signer's claim, not proof of time. */
  readonly issuedAt: number;
  /** Sorted by project id on encoding; each project at most once. */
  readonly cutoffs: readonly ProjectRevocationCutoff[];
}

function checkCutoffs(value: RevocationCutoffs, code: E2eeErrorCode): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') {
    fail('Expected revocation cutoffs');
  }
  if (!isEnvelopeId(value.userId)) fail('Cutoff userId is not an id');
  if (!isUint(value.generation, MAX_U32) || value.generation < 1) {
    fail('generation must be a u32 of at least 1');
  }
  if (!isUint(value.entrySequence, MAX_U32) || value.entrySequence < 1) {
    fail('A revoking entry follows the first one');
  }
  if (!isHash(value.entryHash)) fail('entryHash must be 32 bytes');
  if (!isUint(value.issuedAt, Number.MAX_SAFE_INTEGER)) {
    fail('issuedAt must be Unix milliseconds');
  }
  if (
    !Array.isArray(value.cutoffs) ||
    value.cutoffs.length > MAX_REVOCATION_CUTOFFS
  ) {
    fail(`A statement names at most ${MAX_REVOCATION_CUTOFFS} projects`);
  }
  const projects = new Set<string>();
  for (const cutoff of value.cutoffs) {
    if (!isEnvelopeId(cutoff?.projectId)) fail('Cutoff projectId is not an id');
    if (projects.has(cutoff.projectId)) {
      fail('Each project has one cutoff');
    }
    projects.add(cutoff.projectId);
    if (!isUint(cutoff.cutoffEpoch, Number.MAX_SAFE_INTEGER)) {
      fail('cutoffEpoch must be an unsigned safe integer');
    }
    if (cutoff.head !== undefined) {
      if (
        cutoff.head === null ||
        typeof cutoff.head !== 'object' ||
        !isUint(cutoff.head.documentVersion, Number.MAX_SAFE_INTEGER) ||
        cutoff.head.documentVersion < 1 ||
        !isHash(cutoff.head.versionHash)
      ) {
        fail('A cutoff head is a document version and a 32-byte hash');
      }
    }
  }
}

/**
 * Canonical bytes: `"OZR" | u8 1 | u8 length + user id | u32 generation |
 * u32 entry sequence | 32-byte entry hash | u64 issuedAt | u16 count +
 * cutoffs by project id (u8 length + project id, u64 cutoff epoch)`.
 *
 * Version 2 is the same with `u64 head document version (0 for none) |
 * 32-byte head version hash (zero for none)` after each cutoff epoch, and
 * is used exactly when at least one cutoff names a head, so every statement
 * has one encoding and version 1 statements stay byte for byte.
 */
export function encodeRevocationCutoffs(value: RevocationCutoffs): Bytes {
  checkCutoffs(value, 'invalid-argument');
  const version = value.cutoffs.some((c) => c.head !== undefined)
    ? REVOCATION_CUTOFFS_VERSION_2
    : REVOCATION_CUTOFFS_VERSION_1;
  const writer = new ByteWriter().bytes(CUTOFFS_MAGIC).u8(version);
  writeId(writer, value.userId);
  writer
    .u32(value.generation)
    .u32(value.entrySequence)
    .bytes(value.entryHash)
    .u64(value.issuedAt)
    .u16(value.cutoffs.length);
  for (const cutoff of [...value.cutoffs].sort((a, b) =>
    byId(a.projectId, b.projectId)
  )) {
    writeId(writer, cutoff.projectId);
    writer.u64(cutoff.cutoffEpoch);
    if (version === REVOCATION_CUTOFFS_VERSION_2) {
      writer
        .u64(cutoff.head?.documentVersion ?? 0)
        .bytes(cutoff.head?.versionHash ?? new Uint8Array(HASH_BYTES));
    }
  }
  return writer.finish();
}

/** Decodes canonical statement bytes; anything else is `malformed`. */
export function decodeRevocationCutoffs(bytes: Uint8Array): RevocationCutoffs {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Statement must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_REVOCATION_CUTOFFS_BYTES) {
    throw new E2eeError('limit-exceeded', 'Revocation cutoffs are too large');
  }
  const reader = new ByteReader(bytes, 'Revocation cutoffs');
  if (!equalBytes(reader.bytes(3), CUTOFFS_MAGIC)) {
    throw new E2eeError('malformed', 'Not a revocation cutoff statement');
  }
  const version = reader.u8();
  if (
    version !== REVOCATION_CUTOFFS_VERSION_1 &&
    version !== REVOCATION_CUTOFFS_VERSION_2
  ) {
    throw new E2eeError(
      'unsupported-version',
      `Revocation cutoffs version ${version} is not supported`
    );
  }
  const userId = readId(reader);
  const generation = reader.u32();
  const entrySequence = reader.u32();
  const entryHash = copyBytes(reader.bytes(HASH_BYTES));
  const issuedAt = reader.u64();
  const cutoffs: ProjectRevocationCutoff[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const projectId = readId(reader);
    const cutoffEpoch = reader.u64();
    if (version === REVOCATION_CUTOFFS_VERSION_1) {
      cutoffs.push({ projectId, cutoffEpoch });
      continue;
    }
    const documentVersion = reader.u64();
    const versionHash = copyBytes(reader.bytes(HASH_BYTES));
    // A head slot without a head must be all zero (canonical form below).
    cutoffs.push(
      documentVersion === 0
        ? { projectId, cutoffEpoch }
        : { projectId, cutoffEpoch, head: { documentVersion, versionHash } }
    );
  }
  reader.end();
  const value: RevocationCutoffs = {
    userId,
    generation,
    entrySequence,
    entryHash,
    issuedAt,
    cutoffs
  };
  checkCutoffs(value, 'malformed');
  if (!equalBytes(encodeRevocationCutoffs(value), bytes)) {
    throw new E2eeError(
      'malformed',
      'Revocation cutoffs are not in canonical form'
    );
  }
  return value;
}

/** The identity key signs the cutoffs of a removal. */
export async function signRevocationCutoffs(
  identityPrivateKey: CryptoKey,
  value: RevocationCutoffs
): Promise<SignedStatement> {
  const statement = encodeRevocationCutoffs(value);
  return {
    statement,
    signature: await signStatement(
      identityPrivateKey,
      'revocation cutoffs',
      statement
    )
  };
}

/**
 * Decodes cutoffs and checks them against a verified device list of
 * `generation`: signed by that list's identity key (`authentication-failed`
 * otherwise), for its user and generation, and naming an entry the list
 * holds, by sequence and hash, that revokes at least one device
 * (`context-mismatch` otherwise).
 */
export async function verifyRevocationCutoffs(
  signed: SignedStatement,
  list: VerifiedDeviceList,
  expected: { readonly generation: number }
): Promise<RevocationCutoffs> {
  const statement = copyBytes(signed.statement);
  const signature = copyBytes(signed.signature);
  const value = decodeRevocationCutoffs(statement);
  const { key } = await verifyingKey(list.identityKey);
  if (
    !(await statementValid(key, 'revocation cutoffs', statement, signature))
  ) {
    throw new E2eeError(
      'authentication-failed',
      'Revocation cutoffs are not signed by the identity key'
    );
  }
  if (value.userId !== list.userId) {
    throw new E2eeError('context-mismatch', 'The cutoffs are for another user');
  }
  if (value.generation !== expected.generation) {
    throw new E2eeError(
      'context-mismatch',
      'The cutoffs are for another identity generation'
    );
  }
  const revoking = list.entries[value.entrySequence];
  if (!revoking || !equalBytes(revoking.hash, value.entryHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The cutoffs name an entry this device list does not hold'
    );
  }
  if (!revoking.entry.revoked.some((r) => r.kind === 'device')) {
    throw new E2eeError(
      'context-mismatch',
      'The cutoffs name an entry that revokes no device'
    );
  }
  return value;
}

// --- Solo group resets (decision D9) ---------------------------------------

export const GROUP_RESET_VERSION_1 = 1;

/**
 * What the identity key signs to replace a solo project's MLS group when
 * none of the owner's leaves can act any more (ADR-024, "The user is the
 * only member"; decision D9). The new group's key epochs continue after
 * `priorKeyEpoch` (decision D10): its key-epoch base is `priorKeyEpoch + 1`
 * and its generation `priorGroupGeneration + 1`. Bound to the device-list
 * entry the signer held, so it names the identity state it was made under.
 * A collaborator's browser that sees one excluding them reports the fork.
 */
export interface GroupReset {
  readonly userId: string;
  /** The identity generation of the signing identity; 1 for the first. */
  readonly generation: number;
  /** Sequence and `deviceListEntryHash` of the signer's device-list head. */
  readonly entrySequence: number;
  readonly entryHash: Uint8Array;
  readonly projectId: string;
  /** The generation of the group being replaced; 0 for the first group. */
  readonly priorGroupGeneration: number;
  /** The newest key epoch of the group being replaced. */
  readonly priorKeyEpoch: number;
  /** Unix milliseconds; the signer's claim, not proof of time. */
  readonly issuedAt: number;
}

function checkGroupReset(value: GroupReset, code: E2eeErrorCode): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') fail('Expected a reset');
  if (!isEnvelopeId(value.userId)) fail('Reset userId is not an id');
  if (!isUint(value.generation, MAX_U32) || value.generation < 1) {
    fail('generation must be a u32 of at least 1');
  }
  if (!isUint(value.entrySequence, MAX_U32)) {
    fail('entrySequence must be a u32');
  }
  if (!isHash(value.entryHash)) fail('entryHash must be 32 bytes');
  if (!isEnvelopeId(value.projectId)) fail('Reset projectId is not an id');
  // The new group's generation is one more, so the old one is below u32 max.
  if (!isUint(value.priorGroupGeneration, MAX_U32 - 1)) {
    fail('priorGroupGeneration must be a u32 below its maximum');
  }
  // The new base is one more, and key epochs are u32 (migration 0032).
  if (!isUint(value.priorKeyEpoch, MAX_U32 - 1)) {
    fail('priorKeyEpoch must be a u32 below its maximum');
  }
  if (!isUint(value.issuedAt, Number.MAX_SAFE_INTEGER)) {
    fail('issuedAt must be Unix milliseconds');
  }
}

/**
 * Canonical bytes: `"OZX" | u8 1 | u8 length + user id | u32 generation |
 * u32 entry sequence | 32-byte entry hash | u8 length + project id |
 * u32 prior group generation | u64 prior key epoch | u64 issuedAt`.
 */
export function encodeGroupReset(value: GroupReset): Bytes {
  checkGroupReset(value, 'invalid-argument');
  const writer = new ByteWriter().bytes(RESET_MAGIC).u8(GROUP_RESET_VERSION_1);
  writeId(writer, value.userId);
  writer.u32(value.generation).u32(value.entrySequence).bytes(value.entryHash);
  writeId(writer, value.projectId);
  return writer
    .u32(value.priorGroupGeneration)
    .u64(value.priorKeyEpoch)
    .u64(value.issuedAt)
    .finish();
}

/** Decodes canonical reset bytes; anything else is `malformed`. */
export function decodeGroupReset(bytes: Uint8Array): GroupReset {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Statement must be a Uint8Array');
  }
  const reader = new ByteReader(bytes, 'Group reset');
  if (!equalBytes(reader.bytes(3), RESET_MAGIC)) {
    throw new E2eeError('malformed', 'Not a group reset statement');
  }
  const version = reader.u8();
  if (version !== GROUP_RESET_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Group reset version ${version} is not supported`
    );
  }
  const userId = readId(reader);
  const generation = reader.u32();
  const entrySequence = reader.u32();
  const entryHash = copyBytes(reader.bytes(HASH_BYTES));
  const projectId = readId(reader);
  const value: GroupReset = {
    userId,
    generation,
    entrySequence,
    entryHash,
    projectId,
    priorGroupGeneration: reader.u32(),
    priorKeyEpoch: reader.u64(),
    issuedAt: reader.u64()
  };
  reader.end();
  checkGroupReset(value, 'malformed');
  if (!equalBytes(encodeGroupReset(value), bytes)) {
    throw new E2eeError('malformed', 'Group reset is not in canonical form');
  }
  return value;
}

/** The identity key signs a solo group reset. */
export async function signGroupReset(
  identityPrivateKey: CryptoKey,
  value: GroupReset
): Promise<SignedStatement> {
  const statement = encodeGroupReset(value);
  return {
    statement,
    signature: await signStatement(identityPrivateKey, 'group reset', statement)
  };
}

/**
 * Decodes a reset and checks it against a verified device list of
 * `generation`: signed by that list's identity key (`authentication-failed`
 * otherwise), for its user and generation, naming an entry the list holds
 * by sequence and hash (`context-mismatch` otherwise).
 */
export async function verifyGroupReset(
  signed: SignedStatement,
  list: VerifiedDeviceList,
  expected: { readonly generation: number }
): Promise<GroupReset> {
  const statement = copyBytes(signed.statement);
  const signature = copyBytes(signed.signature);
  const value = decodeGroupReset(statement);
  const { key } = await verifyingKey(list.identityKey);
  if (!(await statementValid(key, 'group reset', statement, signature))) {
    throw new E2eeError(
      'authentication-failed',
      'The group reset is not signed by the identity key'
    );
  }
  if (value.userId !== list.userId) {
    throw new E2eeError('context-mismatch', 'The reset is for another user');
  }
  if (value.generation !== expected.generation) {
    throw new E2eeError(
      'context-mismatch',
      'The reset is for another identity generation'
    );
  }
  const named = list.entries[value.entrySequence];
  if (!named || !equalBytes(named.hash, value.entryHash)) {
    throw new E2eeError(
      'context-mismatch',
      'The reset names an entry this device list does not hold'
    );
  }
  return value;
}

// --- Key pairs ------------------------------------------------------------

/**
 * The raw public key of a PKCS #8 P-256 private key, read through a
 * short-lived extractable import. An unwrapped private key is checked
 * against the public key the identity certified before it is trusted.
 */
export async function publicKeyOfPrivateKey(
  pkcs8: Uint8Array,
  algorithm: 'ECDH' | 'ECDSA'
): Promise<Bytes> {
  let jwk: JsonWebKey;
  try {
    const key = await subtle().importKey(
      'pkcs8',
      asBytes(pkcs8),
      { name: algorithm, namedCurve: 'P-256' },
      true,
      algorithm === 'ECDH' ? ['deriveBits'] : ['sign']
    );
    jwk = await subtle().exportKey('jwk', key);
  } catch (cause) {
    throw new E2eeError('malformed', 'Private key is not P-256 PKCS #8', {
      cause
    });
  }
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new E2eeError('malformed', 'Private key carries no public point');
  }
  return concatBytes(
    Uint8Array.of(0x04),
    fromBase64Url(jwk.x, KEY_BYTES),
    fromBase64Url(jwk.y, KEY_BYTES)
  );
}
