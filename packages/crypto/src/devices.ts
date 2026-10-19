import {
  ByteReader,
  ByteWriter,
  asBytes,
  concatBytes,
  copyBytes,
  equalBytes,
  isUint,
  label,
  toHex,
  type Bytes
} from './bytes';
import {
  chainEntryHash,
  checkChain,
  checkNextLink,
  type ChainLink,
  type ChainOptions
} from './chain';
import { publicKeyHash } from './codes';
import { E2eeError } from './errors';
import { HASH_BYTES, isEnvelopeId } from './header';
import {
  P256_PUBLIC_KEY_BYTES,
  exportPublicKey,
  importSigningPublicKey
} from './keys';
import { subtle } from './primitives';

export const SIGNATURE_VERSION_1 = 1;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const P1363_BYTES = 64;
const MAX_U32 = 0xffffffff;
const MAX_DEVICES = 256;
const MAX_CUTOFFS = 65535;

// --- Raw ECDSA ------------------------------------------------------------

export async function ecdsaSign(
  privateKey: CryptoKey,
  message: Uint8Array
): Promise<Bytes> {
  if (
    privateKey?.algorithm?.name !== 'ECDSA' ||
    privateKey.type !== 'private'
  ) {
    throw new E2eeError('invalid-argument', 'Expected an ECDSA private key');
  }
  return new Uint8Array(
    await subtle().sign(ECDSA_SHA256, privateKey, asBytes(message))
  );
}

export async function ecdsaVerify(
  publicKey: Uint8Array | CryptoKey,
  signature: Uint8Array,
  message: Uint8Array
): Promise<boolean> {
  const key =
    publicKey instanceof Uint8Array
      ? await importSigningPublicKey(publicKey)
      : publicKey;
  if (key?.algorithm?.name !== 'ECDSA' || key.type !== 'public') {
    throw new E2eeError('invalid-argument', 'Expected an ECDSA public key');
  }
  try {
    return await subtle().verify(
      ECDSA_SHA256,
      key,
      asBytes(signature),
      asBytes(message)
    );
  } catch {
    // Engines differ on out-of-range r or s: Node returns false, others may
    // throw. Either way the signature is not valid.
    return false;
  }
}

function checkVersionByte(bytes: Uint8Array, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new E2eeError('malformed', `${what} is empty`);
  }
  if (bytes[0] !== SIGNATURE_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `${what} version ${bytes[0]} is not supported`
    );
  }
}

function isPublicKey(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    value.byteLength === P256_PUBLIC_KEY_BYTES &&
    value[0] === 0x04
  );
}

async function rawPublicKey(key: Uint8Array | CryptoKey): Promise<Bytes> {
  return key instanceof Uint8Array ? copyBytes(key) : exportPublicKey(key);
}

// --- Device list entries --------------------------------------------------

export interface CertifiedDevice {
  readonly deviceId: string;
  /** Raw 65-byte ECDSA P-256 public key of the device signing key. */
  readonly signingKey: Uint8Array;
}

/**
 * Where a revocation cuts off one project: the newest heads the revoking
 * browser had accepted. A revoked device's signature stays valid only on a
 * cutoff head or one of its ancestors, because the device itself chose any
 * parent or timestamp it claims.
 */
export interface RevocationCutoff {
  readonly projectId: string;
  /** `versionHash` of the newest accepted version. */
  readonly versionHead: Uint8Array;
  /** `rosterEntryHash` of the newest accepted roster entry, if known. */
  readonly rosterHead: Uint8Array | null;
}

/**
 * One entry of a user's device list, signed by their identity key. Each
 * entry is a full snapshot: the current encryption public key and every
 * live device signing key. A device missing from an entry is revoked from
 * that entry on, and can never return; a revoking entry names a cutoff for
 * every project the user belongs to.
 */
export interface DeviceListEntry {
  readonly userId: string;
  /** 0 for the first entry, then +1 per entry. */
  readonly sequence: number;
  /** `deviceListEntryHash` of the previous entry; null for the first. */
  readonly previousEntryHash: Uint8Array | null;
  /** Raw 65-byte ECDH P-256 public key that receives project keys. */
  readonly encryptionKey: Uint8Array;
  readonly devices: readonly CertifiedDevice[];
  /** Only on an entry that revokes a device; empty otherwise. */
  readonly cutoffs: readonly RevocationCutoff[];
}

export interface SignedDeviceListEntry {
  /** Canonical `encodeDeviceListEntry` bytes. */
  readonly entry: Bytes;
  /** `u8 version | 64-byte r || s` by the identity key. */
  readonly signature: Bytes;
}

const DEVICE_LIST_MAGIC = [0x4f, 0x5a, 0x44]; // "OZD"
const DEVICE_LIST_VERSION_1 = 1;
const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

function checkDeviceListEntry(
  entry: DeviceListEntry,
  code: 'invalid-argument' | 'malformed'
): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (!isEnvelopeId(entry.userId)) fail('Device list userId is not an id');
  if (!isUint(entry.sequence, MAX_U32)) fail('sequence must be a u32');
  if ((entry.sequence === 0) !== (entry.previousEntryHash === null)) {
    fail('Only the first entry (sequence 0) has no previous entry');
  }
  if (
    entry.previousEntryHash !== null &&
    !(
      entry.previousEntryHash instanceof Uint8Array &&
      entry.previousEntryHash.byteLength === HASH_BYTES
    )
  ) {
    fail('previousEntryHash must be 32 bytes');
  }
  if (!isPublicKey(entry.encryptionKey)) {
    fail('encryptionKey must be a raw P-256 public key');
  }
  if (!Array.isArray(entry.devices) || entry.devices.length > MAX_DEVICES) {
    fail(`A device list holds 0..${MAX_DEVICES} devices`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const device of entry.devices) {
    if (!isEnvelopeId(device?.deviceId)) fail('deviceId is not an id');
    if (!isPublicKey(device.signingKey)) {
      fail('signingKey must be a raw P-256 public key');
    }
    const key = toHex(device.signingKey);
    if (ids.has(device.deviceId) || keys.has(key)) {
      fail('Device ids and signing keys must be unique');
    }
    ids.add(device.deviceId);
    keys.add(key);
  }
  if (!Array.isArray(entry.cutoffs) || entry.cutoffs.length > MAX_CUTOFFS) {
    fail(`A device list entry holds 0..${MAX_CUTOFFS} cutoffs`);
  }
  const projects = new Set<string>();
  for (const cutoff of entry.cutoffs) {
    if (!isEnvelopeId(cutoff?.projectId) || projects.has(cutoff.projectId)) {
      fail('Cutoffs name distinct project ids');
    }
    projects.add(cutoff.projectId);
    if (
      !isHash(cutoff.versionHead) ||
      (cutoff.rosterHead !== null && !isHash(cutoff.rosterHead))
    ) {
      fail('Cutoff heads are 32-byte hashes');
    }
  }
}

function isHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === HASH_BYTES;
}

/**
 * Canonical bytes: "OZD" | u8 version | u32 sequence | u8 previous-hash
 * length (0|32) + hash | u8 length + user id | 65-byte encryption key |
 * u16 device count | devices sorted by id, each as u8 length + device id
 * and the 65-byte signing key | u16 cutoff count | cutoffs sorted by
 * project id, each as u8 length + project id, 32-byte version head and
 * u8 length (0|32) + roster head.
 */
export function encodeDeviceListEntry(entry: DeviceListEntry): Bytes {
  checkDeviceListEntry(entry, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(Uint8Array.from(DEVICE_LIST_MAGIC))
    .u8(DEVICE_LIST_VERSION_1)
    .u32(entry.sequence)
    .u8(entry.previousEntryHash?.byteLength ?? 0)
    .bytes(entry.previousEntryHash ?? new Uint8Array())
    .u8(entry.userId.length)
    .bytes(ascii.encode(entry.userId))
    .bytes(entry.encryptionKey)
    .u16(entry.devices.length);
  const devices = [...entry.devices].sort((a, b) =>
    a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0
  );
  for (const device of devices) {
    writer
      .u8(device.deviceId.length)
      .bytes(ascii.encode(device.deviceId))
      .bytes(device.signingKey);
  }
  writer.u16(entry.cutoffs.length);
  const cutoffs = [...entry.cutoffs].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0
  );
  for (const cutoff of cutoffs) {
    writer
      .u8(cutoff.projectId.length)
      .bytes(ascii.encode(cutoff.projectId))
      .bytes(cutoff.versionHead)
      .u8(cutoff.rosterHead?.byteLength ?? 0)
      .bytes(cutoff.rosterHead ?? new Uint8Array());
  }
  return writer.finish();
}

export function decodeDeviceListEntry(bytes: Uint8Array): DeviceListEntry {
  const reader = new ByteReader(bytes, 'Device list entry');
  if (!equalBytes(reader.bytes(3), Uint8Array.from(DEVICE_LIST_MAGIC))) {
    throw new E2eeError('malformed', 'Not a device list entry');
  }
  const version = reader.u8();
  if (version !== DEVICE_LIST_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Device list version ${version} is not supported`
    );
  }
  const sequence = reader.u32();
  const hashLength = reader.u8();
  const previousEntryHash =
    hashLength === 0 ? null : copyBytes(reader.bytes(hashLength));
  const userId = asciiDecoder.decode(reader.bytes(reader.u8()));
  const encryptionKey = copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES));
  const devices: CertifiedDevice[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const deviceId = asciiDecoder.decode(reader.bytes(reader.u8()));
    devices.push({
      deviceId,
      signingKey: copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES))
    });
  }
  const cutoffs: RevocationCutoff[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const projectId = asciiDecoder.decode(reader.bytes(reader.u8()));
    const versionHead = copyBytes(reader.bytes(HASH_BYTES));
    const rosterLength = reader.u8();
    cutoffs.push({
      projectId,
      versionHead,
      rosterHead:
        rosterLength === 0 ? null : copyBytes(reader.bytes(rosterLength))
    });
  }
  reader.end();
  const entry = {
    userId,
    sequence,
    previousEntryHash,
    encryptionKey,
    devices,
    cutoffs
  };
  checkDeviceListEntry(entry, 'malformed');
  if (!equalBytes(encodeDeviceListEntry(entry), bytes)) {
    throw new E2eeError(
      'malformed',
      'Device list entry is not in canonical form'
    );
  }
  return entry;
}

export async function deviceListEntryHash(entry: Uint8Array): Promise<Bytes> {
  return chainEntryHash('device list', entry);
}

/** What the identity key signs; it signs nothing else. */
export type IdentityStatementKind = 'device list' | 'contacts' | 'roster';

/**
 * Identity signature over a canonical entry: `u8 version | r || s` over
 * `label "v1 <kind> signature" | entry`.
 */
export async function signIdentityStatement(
  identityPrivateKey: CryptoKey,
  kind: IdentityStatementKind,
  entry: Uint8Array
): Promise<Bytes> {
  const signature = await ecdsaSign(
    identityPrivateKey,
    concatBytes(label(`v1 ${kind} signature`), entry)
  );
  return concatBytes(Uint8Array.of(SIGNATURE_VERSION_1), signature);
}

/** Throws unless `signature` is the identity key's over `entry`. */
export async function verifyIdentityStatement(
  identityPublicKey: Uint8Array | CryptoKey,
  kind: IdentityStatementKind,
  entry: Uint8Array,
  signature: Uint8Array,
  sequence: number
): Promise<void> {
  checkVersionByte(signature, `${kind} signature`);
  if (signature.byteLength !== 1 + P1363_BYTES) {
    throw new E2eeError('malformed', `${kind} signature has the wrong length`);
  }
  if (
    !(await ecdsaVerify(
      identityPublicKey,
      signature.subarray(1),
      concatBytes(label(`v1 ${kind} signature`), entry)
    ))
  ) {
    throw new E2eeError(
      'authentication-failed',
      `${kind} entry ${sequence} is not signed by the identity key`
    );
  }
}

/** The identity key signs a device-list entry: a certification or revocation. */
export async function signDeviceListEntry(
  identityPrivateKey: CryptoKey,
  entry: DeviceListEntry
): Promise<SignedDeviceListEntry> {
  const bytes = encodeDeviceListEntry(entry);
  return {
    entry: bytes,
    signature: await signIdentityStatement(
      identityPrivateKey,
      'device list',
      bytes
    )
  };
}

// --- Verified device lists ------------------------------------------------

const toLink = ({
  entry,
  hash
}: {
  entry: DeviceListEntry;
  hash: Bytes;
}): ChainLink => ({
  sequence: entry.sequence,
  previousEntryHash: entry.previousEntryHash,
  hash
});

export interface DeviceRecord {
  readonly deviceId: string;
  readonly signingKey: Bytes;
  /** `publicKeyHash` of the signing key: how signatures name the device. */
  readonly keyHash: Bytes;
  /** Sequence of the first entry that certified it. */
  readonly certifiedAt: number;
  /** Sequence of the entry that revoked it, or null while it is live. */
  readonly revokedAt: number | null;
  /** The revoking entry's cutoffs; empty while the device is live. */
  readonly cutoffs: readonly RevocationCutoff[];
}

export interface EncryptionKeyRecord {
  readonly key: Bytes;
  readonly keyHash: Bytes;
  readonly certifiedAt: number;
  /** Sequence of the entry that replaced it, or null for the current key. */
  readonly replacedAt: number | null;
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
  /** The newest entry's sequence and hash, for pinning. */
  readonly latestSequence: number;
  readonly latestHash: Bytes;
  readonly devices: readonly DeviceRecord[];
  readonly encryptionKeys: readonly EncryptionKeyRecord[];
}

/**
 * Verifies a user's whole device list, oldest first, against the identity
 * key the viewer verified: every entry is identity-signed and canonical,
 * the chain starts at sequence 0 and links by hash, and a revoked device
 * never reappears. With `pinnedEntryHash` (the newest entry this browser
 * has seen), the chain must contain it, so a hidden revocation or a forked
 * list fails (`chain-broken`).
 */
export async function verifyDeviceList(
  identityPublicKey: Uint8Array | CryptoKey,
  chain: readonly SignedDeviceListEntry[],
  options: ChainOptions = {}
): Promise<VerifiedDeviceList> {
  if (chain.length === 0) {
    throw new E2eeError('chain-broken', 'Device list is empty');
  }
  const identityKey = await rawPublicKey(identityPublicKey);
  const identityKeyHash = await publicKeyHash(identityKey);
  const entries: { entry: DeviceListEntry; hash: Bytes }[] = [];
  const devices = new Map<string, DeviceRecord>();
  const encryptionKeys: EncryptionKeyRecord[] = [];
  for (const signed of chain) {
    const entry = decodeDeviceListEntry(signed.entry);
    await verifyIdentityStatement(
      identityPublicKey,
      'device list',
      signed.entry,
      signed.signature,
      entry.sequence
    );
    const hash = await deviceListEntryHash(signed.entry);
    const before = entries.at(-1);
    if (before && entry.userId !== before.entry.userId) {
      throw new E2eeError('chain-broken', 'Device list changes user');
    }
    checkNextLink(
      'Device list',
      toLink({ entry, hash }),
      before && toLink(before)
    );
    const live = new Set<string>();
    for (const device of entry.devices) {
      const keyHash = await publicKeyHash(device.signingKey);
      const id = toHex(keyHash);
      live.add(id);
      const known = devices.get(id);
      if (
        known &&
        (known.revokedAt !== null || known.deviceId !== device.deviceId)
      ) {
        throw new E2eeError(
          'chain-broken',
          `Device ${device.deviceId} reappears or changes after revocation`
        );
      }
      if (!known) {
        devices.set(id, {
          deviceId: device.deviceId,
          signingKey: copyBytes(device.signingKey),
          keyHash,
          certifiedAt: entry.sequence,
          revokedAt: null,
          cutoffs: []
        });
      }
    }
    let revokes = false;
    for (const [id, record] of devices) {
      if (record.revokedAt === null && !live.has(id)) {
        revokes = true;
        devices.set(id, {
          ...record,
          revokedAt: entry.sequence,
          cutoffs: entry.cutoffs
        });
      }
    }
    if (!revokes && entry.cutoffs.length > 0) {
      throw new E2eeError(
        'chain-broken',
        `Device list entry ${entry.sequence} names cutoffs but revokes nothing`
      );
    }
    const current = encryptionKeys.at(-1);
    if (!current || !equalBytes(current.key, entry.encryptionKey)) {
      const keyHash = await publicKeyHash(entry.encryptionKey);
      if (
        encryptionKeys.some((record) => equalBytes(record.keyHash, keyHash))
      ) {
        throw new E2eeError(
          'chain-broken',
          'A replaced encryption key returns'
        );
      }
      if (current) {
        encryptionKeys[encryptionKeys.length - 1] = {
          ...current,
          replacedAt: entry.sequence
        };
      }
      encryptionKeys.push({
        key: copyBytes(entry.encryptionKey),
        keyHash,
        certifiedAt: entry.sequence,
        replacedAt: null
      });
    }
    entries.push({ entry, hash });
  }
  checkChain('Device list', entries.map(toLink), {
    ...options,
    fromGenesis: true
  });
  const latest = entries.at(-1)!;
  return {
    userId: latest.entry.userId,
    identityKey,
    identityKeyHash,
    entries,
    latestSequence: latest.entry.sequence,
    latestHash: latest.hash,
    devices: [...devices.values()],
    encryptionKeys
  };
}

/** The encryption key to wrap project keys to: the newest certified one. */
export function currentEncryptionKey(list: VerifiedDeviceList): Bytes {
  return copyBytes(list.encryptionKeys.at(-1)!.key);
}

export function findDevice(
  list: VerifiedDeviceList,
  deviceKeyHash: Uint8Array
): DeviceRecord | undefined {
  return list.devices.find((device) =>
    equalBytes(device.keyHash, deviceKeyHash)
  );
}

/** True if the device was certified at `sequence` and not yet revoked. */
export function isDeviceLiveAt(
  record: DeviceRecord,
  sequence: number
): boolean {
  return (
    record.certifiedAt <= sequence &&
    (record.revokedAt === null || sequence < record.revokedAt)
  );
}

// --- Device signatures ----------------------------------------------------

/** What signs on a user's behalf: a certified device key. */
export interface DeviceSigner {
  readonly userId: string;
  readonly privateKey: CryptoKey;
  /** `publicKeyHash` of the device's public signing key. */
  readonly deviceKeyHash: Uint8Array;
  /** Newest device-list sequence the signer knows; it certifies this key. */
  readonly deviceListSequence: number;
}

export const DEVICE_SIGNATURE_PURPOSES = ['version', 'roster'] as const;
export type DeviceSignaturePurpose = (typeof DEVICE_SIGNATURE_PURPOSES)[number];

export interface DeviceSignatureInfo {
  readonly userId: string;
  readonly deviceListSequence: number;
  readonly deviceKeyHash: Bytes;
  /** The signer's timestamp, Unix milliseconds. */
  readonly signedAt: number;
}

export interface VerifiedDeviceSignature extends DeviceSignatureInfo {
  readonly deviceId: string;
}

/** Signer fields: `u8 version | u8 length + user id | u32 sequence | 32-byte key hash | u64 signedAt`. */
function encodeSignerFields(info: DeviceSignatureInfo): Bytes {
  return new ByteWriter()
    .u8(SIGNATURE_VERSION_1)
    .u8(info.userId.length)
    .bytes(ascii.encode(info.userId))
    .u32(info.deviceListSequence)
    .bytes(info.deviceKeyHash)
    .u64(info.signedAt)
    .finish();
}

function deviceStatement(
  purpose: DeviceSignaturePurpose,
  subject: Uint8Array,
  signerFields: Uint8Array
): Bytes {
  return new ByteWriter()
    .bytes(label(`v1 ${purpose} signature`))
    .u32(subject.byteLength)
    .bytes(subject)
    .bytes(signerFields)
    .finish();
}

/**
 * Signs `subject` with a device key. Output: the signer fields, then the
 * 64-byte `r || s`. The statement covers a purpose label, the subject and
 * every signer field, so a signature cannot be re-attributed or moved
 * between purposes.
 */
export async function signWithDevice(
  signer: DeviceSigner,
  purpose: DeviceSignaturePurpose,
  subject: Uint8Array,
  signedAt: number = Date.now()
): Promise<Bytes> {
  if (!isEnvelopeId(signer?.userId)) {
    throw new E2eeError('invalid-argument', 'Signer userId is not an id');
  }
  if (
    !(signer.deviceKeyHash instanceof Uint8Array) ||
    signer.deviceKeyHash.byteLength !== HASH_BYTES ||
    !isUint(signer.deviceListSequence, MAX_U32) ||
    !isUint(signedAt, Number.MAX_SAFE_INTEGER)
  ) {
    throw new E2eeError(
      'invalid-argument',
      'Signer needs a 32-byte key hash, a u32 sequence and a timestamp'
    );
  }
  const fields = encodeSignerFields({
    userId: signer.userId,
    deviceListSequence: signer.deviceListSequence,
    deviceKeyHash: copyBytes(signer.deviceKeyHash),
    signedAt
  });
  const rs = await ecdsaSign(
    signer.privateKey,
    deviceStatement(purpose, subject, fields)
  );
  return concatBytes(fields, rs);
}

/** Reads who signed, so the caller can fetch that user's device list. */
export function readDeviceSignature(
  signature: Uint8Array
): DeviceSignatureInfo {
  checkVersionByte(signature, 'Device signature');
  const reader = new ByteReader(signature, 'Device signature');
  reader.u8();
  const userId = asciiDecoder.decode(reader.bytes(reader.u8()));
  const deviceListSequence = reader.u32();
  const deviceKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const signedAt = reader.u64();
  reader.bytes(P1363_BYTES);
  reader.end();
  if (!isEnvelopeId(userId)) {
    throw new E2eeError('malformed', 'Device signature userId is not an id');
  }
  return { userId, deviceListSequence, deviceKeyHash, signedAt };
}

/**
 * Answers whether `candidate` is `head` or one of its ancestors in a
 * project's history. Injected so the package stays storage-free.
 */
export type AncestryLookup = (
  candidate: Uint8Array,
  head: Uint8Array
) => boolean | Promise<boolean>;

/** What a revoked device signed, for the cutoff check. */
export interface CutoffSubject {
  readonly projectId: string;
  /** Which head of the cutoff applies. */
  readonly head: 'version' | 'roster';
  /** `versionHash` or `rosterEntryHash` of the signed item. */
  readonly hash: Uint8Array;
  readonly isAncestorOrSelf: AncestryLookup;
}

export interface DeviceSignatureOptions {
  /**
   * Required to accept anything from a device the list has revoked: the
   * signed item must be the revocation's cutoff head for its project, or an
   * ancestor of it. Without it, a revoked device is always refused.
   */
  readonly cutoff?: CutoffSubject;
}

/**
 * Accepts a revoked device's signature only on the cutoff head of the
 * item's project, or one of its ancestors; throws `key-revoked` otherwise.
 * A live device passes.
 */
export async function checkRevocationCutoff(
  record: DeviceRecord,
  subject: CutoffSubject | undefined
): Promise<void> {
  if (record.revokedAt === null) return;
  const refuse = (why: string): never => {
    throw new E2eeError(
      'key-revoked',
      `Device ${record.deviceId} was revoked at device-list entry ${record.revokedAt}: ${why}`
    );
  };
  if (!subject) return refuse('no cutoff subject was given');
  const cutoff = record.cutoffs.find((c) => c.projectId === subject.projectId);
  if (!cutoff) return refuse(`no cutoff for project ${subject.projectId}`);
  const head =
    subject.head === 'version' ? cutoff.versionHead : cutoff.rosterHead;
  if (!head) return refuse(`no ${subject.head} cutoff for the project`);
  if (
    !equalBytes(subject.hash, head) &&
    !(await subject.isAncestorOrSelf(subject.hash, head))
  ) {
    refuse('the item is not within the cutoff');
  }
}

/**
 * Checks a device signature against the signer's verified device list.
 * Returns who signed, or null when the signature itself is invalid. Throws
 * `context-mismatch` for another user's list, `chain-broken` when the list
 * is older than the signature claims, `authentication-failed` for a device
 * the list never certified, and `key-revoked` for a revoked device unless
 * the item is within the revocation's cutoff (`options.cutoff`).
 */
export async function verifyDeviceSignature(
  list: VerifiedDeviceList,
  purpose: DeviceSignaturePurpose,
  subject: Uint8Array,
  signature: Uint8Array,
  options: DeviceSignatureOptions = {}
): Promise<VerifiedDeviceSignature | null> {
  const info = readDeviceSignature(signature);
  if (info.userId !== list.userId) {
    throw new E2eeError('context-mismatch', 'Signature is by another user');
  }
  if (info.deviceListSequence > list.latestSequence) {
    throw new E2eeError(
      'chain-broken',
      'Signature cites a newer device list than the one given'
    );
  }
  const record = findDevice(list, info.deviceKeyHash);
  if (!record || record.certifiedAt > info.deviceListSequence) {
    throw new E2eeError(
      'authentication-failed',
      'Signing device is not certified in the device list'
    );
  }
  await checkRevocationCutoff(record, options.cutoff);
  const fieldsLength = signature.byteLength - P1363_BYTES;
  const valid = await ecdsaVerify(
    record.signingKey,
    signature.subarray(fieldsLength),
    deviceStatement(purpose, subject, signature.subarray(0, fieldsLength))
  );
  return valid ? { ...info, deviceId: record.deviceId } : null;
}
