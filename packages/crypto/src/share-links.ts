import {
  ByteReader,
  ByteWriter,
  concatBytes,
  copyBytes,
  equalBytes,
  isUint,
  label,
  toHex,
  type Bytes
} from './bytes';
import { publicKeyHash } from './codes';
import {
  signStatement,
  statementValid,
  verifyingKey,
  MAX_LISTED_DEVICES,
  type SignedStatement
} from './devices';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  HASH_BYTES,
  MAX_ID_BYTES,
  isEnvelopeId,
  type ProjectEnvelopeHeader
} from './header';
import { P256_PUBLIC_KEY_BYTES } from './keys';
import { KEY_BYTES, sha256, type KeyMaterial } from './primitives';
import { parseEnvelope } from './envelope';
import { verifyProjectEnvelopeSignature } from './signing';
import { unwrapKey } from './wrap';
import type { SigningPrivateKey } from './external-keys';

/**
 * Share-link authority (ADR-024, Sharing and collaboration). An anonymous
 * visitor holds only the link, `#share=<token>.<key>.<owner>`, and cannot
 * follow project membership, so every snapshot it accepts is vouched for by
 * a short chain the owner signs:
 *
 * - a **share delegation**, signed by the owner's identity key, naming the
 *   owner devices allowed to sign share-authority statements, for at most
 *   30 days;
 * - a **share-authority statement** per link, signed by one of those
 *   devices, naming the device signing keys (by `publicKeyHash`) of the
 *   owner and each current editor that may publish snapshots, for at most
 *   7 days;
 * - the snapshot itself, a `share-snapshot` project envelope signed by one
 *   of the named author keys.
 *
 * Members also keep the project's active link set inside the encrypted,
 * signed document (`EncryptedDocumentBody.shareLinks`): an owner-signed
 * **link grant** for each active link and an owner-signed, permanent
 * **tombstone** for each revoked link id.
 */

export const SHARE_DELEGATION_VERSION_1 = 1;
export const SHARE_AUTHORITY_VERSION_1 = 1;
export const SHARE_LINK_GRANT_VERSION_1 = 1;
export const SHARE_LINK_TOMBSTONE_VERSION_1 = 1;

const DELEGATION_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x53); // "OZS"
const AUTHORITY_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x41); // "OZA"
const GRANT_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x4c); // "OZL"
const TOMBSTONE_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x59); // "OZY"

const MAX_U32 = 0xffffffff;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest a share delegation may last: `expiresAt - issuedAt`. */
export const MAX_SHARE_DELEGATION_LIFETIME_MS = 30 * DAY_MS;
/** The longest a share-authority statement may last: `expiresAt - issuedAt`. */
export const MAX_SHARE_AUTHORITY_LIFETIME_MS = 7 * DAY_MS;
/**
 * How far a signer's clock may run ahead of a verifier's: a statement
 * issued up to this far in the verifier's future is accepted, so a visitor
 * whose clock is a little slow still opens a fresh link.
 */
export const SHARE_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** Most owner devices one delegation names (a device list's limit). */
export const MAX_DELEGATED_DEVICES = MAX_LISTED_DEVICES;
/** Most author credentials one share-authority statement names. */
export const MAX_SHARE_AUTHORS = 2048;
/** Most active links one document's link set holds. */
export const MAX_SHARE_LINKS = 256;
/** Most tombstones one document's link set holds. */
export const MAX_SHARE_TOMBSTONES = 4096;

const SIGNATURE_BYTES = 1 + 64;

/** Largest canonical delegation: every device. */
export const MAX_SHARE_DELEGATION_BYTES =
  3 + 1 + HASH_BYTES + 4 + 8 + 8 + 1 + MAX_DELEGATED_DEVICES * 65;
/** Largest canonical share-authority statement: every author, longest ids. */
export const MAX_SHARE_AUTHORITY_BYTES =
  3 +
  1 +
  2 * (1 + MAX_ID_BYTES) +
  HASH_BYTES +
  1 +
  HASH_BYTES +
  4 +
  8 +
  8 +
  HASH_BYTES +
  2 +
  MAX_SHARE_AUTHORS * HASH_BYTES;
/** Largest canonical link grant. */
export const MAX_SHARE_LINK_GRANT_BYTES =
  3 + 1 + 2 * (1 + MAX_ID_BYTES) + HASH_BYTES + 1 + 4 + 8 + HASH_BYTES;
/** Largest canonical link tombstone. */
export const MAX_SHARE_LINK_TOMBSTONE_BYTES =
  3 + 1 + 2 * (1 + MAX_ID_BYTES) + 4 + 8 + HASH_BYTES;

/**
 * What a link visitor may do, as `ProjectShareLinkMode` in
 * `@openzcad/shared`: `view` is read-only, `tweak` opens the
 * parameters-only workspace.
 */
export const SHARE_LINK_MODES = Object.freeze(['view', 'tweak'] as const);
export type ShareLinkMode = (typeof SHARE_LINK_MODES)[number];
const MODE_CODES: Record<ShareLinkMode, number> = { view: 1, tweak: 2 };

// --- Errors ----------------------------------------------------------------

export type ShareLinkFailure =
  /** The identity key is not the one the link names. */
  | 'owner-mismatch'
  /** The delegation is not signed by the owner's identity key. */
  | 'delegation-signature'
  /** The delegation expired before the verifier's `now`. */
  | 'delegation-expired'
  /** The delegation was issued after the verifier's `now` (beyond skew). */
  | 'delegation-not-yet-valid'
  /** The statement's signing device is not named in the delegation. */
  | 'signer-not-delegated'
  /** The statement's signature is not valid. */
  | 'authority-signature'
  /** The statement expired before the verifier's `now`. */
  | 'authority-expired'
  /** The statement was issued after the verifier's `now` (beyond skew). */
  | 'authority-not-yet-valid'
  /** The statement is for another link: project, link id or share key. */
  | 'link-mismatch'
  /** The snapshot's signing key is not one the statement names. */
  | 'author-not-named'
  /** The snapshot's signature is not valid. */
  | 'snapshot-signature'
  /** The snapshot is not a share snapshot of the statement's project. */
  | 'snapshot-mismatch'
  /** A grant or tombstone signer the owner's keys do not include. */
  | 'unknown-signer'
  /** A link grant's signature is not valid. */
  | 'grant-signature'
  /** A link tombstone's signature is not valid. */
  | 'tombstone-signature'
  /** A grant or tombstone for another project, or a later key epoch. */
  | 'grant-mismatch'
  /** An active link whose id has a tombstone. */
  | 'tombstoned'
  /** A tombstone the previous set held is missing: tombstones are permanent. */
  | 'tombstone-dropped'
  /** The set changed in a version an editor (not the owner) wrote. */
  | 'changed-by-editor';

const FAILURE_CODES: Record<ShareLinkFailure, E2eeErrorCode> = {
  'owner-mismatch': 'context-mismatch',
  'delegation-signature': 'authentication-failed',
  'delegation-expired': 'context-mismatch',
  'delegation-not-yet-valid': 'context-mismatch',
  'signer-not-delegated': 'authentication-failed',
  'authority-signature': 'authentication-failed',
  'authority-expired': 'context-mismatch',
  'authority-not-yet-valid': 'context-mismatch',
  'link-mismatch': 'context-mismatch',
  'author-not-named': 'authentication-failed',
  'snapshot-signature': 'authentication-failed',
  'snapshot-mismatch': 'context-mismatch',
  'unknown-signer': 'authentication-failed',
  'grant-signature': 'authentication-failed',
  'tombstone-signature': 'authentication-failed',
  'grant-mismatch': 'context-mismatch',
  tombstoned: 'context-mismatch',
  'tombstone-dropped': 'chain-broken',
  'changed-by-editor': 'authentication-failed'
};

/**
 * Every share-link refusal: an `E2eeError` whose `reason` says which check
 * failed. Its `code` is `authentication-failed` for a missing or invalid
 * signature or an unauthorized signer, `chain-broken` for a dropped
 * tombstone, and `context-mismatch` otherwise (expiry included: the
 * statement is authentic but not valid now).
 */
export class ShareLinkError extends E2eeError {
  readonly reason: ShareLinkFailure;

  constructor(reason: ShareLinkFailure, message: string) {
    super(FAILURE_CODES[reason], message);
    this.reason = reason;
  }
}

function refuse(reason: ShareLinkFailure, message: string): never {
  throw new ShareLinkError(reason, message);
}

// --- Shared helpers --------------------------------------------------------

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

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.byteLength - b.byteLength;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

function writeId(writer: ByteWriter, id: string): void {
  writer.u8(id.length).bytes(ascii.encode(id));
}

function readId(reader: ByteReader): string {
  return asciiDecoder.decode(reader.bytes(reader.u8()));
}

function checkLifetime(
  issuedAt: unknown,
  expiresAt: unknown,
  max: number,
  what: string,
  fail: (message: string) => never
): void {
  if (!isUint(issuedAt, Number.MAX_SAFE_INTEGER)) {
    fail(`${what} issuedAt must be Unix milliseconds`);
  }
  if (!isUint(expiresAt, Number.MAX_SAFE_INTEGER)) {
    fail(`${what} expiresAt must be Unix milliseconds`);
  }
  if (expiresAt <= issuedAt) fail(`${what} must expire after it is issued`);
  if (expiresAt - issuedAt > max) {
    fail(`${what} lasts at most ${max / DAY_MS} days`);
  }
}

function readMagic(
  reader: ByteReader,
  magic: Uint8Array,
  version: number,
  what: string
): void {
  if (!equalBytes(reader.bytes(3), magic)) {
    throw new E2eeError('malformed', `Not a ${what}`);
  }
  const found = reader.u8();
  if (found !== version) {
    throw new E2eeError(
      'unsupported-version',
      `${what} version ${found} is not supported`
    );
  }
}

function checkInput(bytes: unknown, max: number, what: string): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', `${what} must be a Uint8Array`);
  }
  if (bytes.byteLength > max) {
    throw new E2eeError('limit-exceeded', `${what} is too large`);
  }
}

function readMode(reader: ByteReader): ShareLinkMode {
  const code = reader.u8();
  const mode = SHARE_LINK_MODES.find((m) => MODE_CODES[m] === code);
  if (!mode)
    throw new E2eeError('malformed', `Unknown share link mode ${code}`);
  return mode;
}

function checkNow(now: unknown): asserts now is number {
  if (!isUint(now, Number.MAX_SAFE_INTEGER)) {
    throw new E2eeError('invalid-argument', 'now must be Unix milliseconds');
  }
}

function checkValidAt(
  issuedAt: number,
  expiresAt: number,
  now: number,
  what: 'delegation' | 'authority'
): void {
  const name = what === 'delegation' ? 'share delegation' : 'share authority';
  if (now >= expiresAt) {
    refuse(`${what}-expired`, `The ${name} expired`);
  }
  if (issuedAt > now + SHARE_CLOCK_SKEW_MS) {
    refuse(`${what}-not-yet-valid`, `The ${name} is not valid yet`);
  }
}

function copySigned(signed: SignedStatement, what: string): SignedStatement {
  if (
    signed === null ||
    typeof signed !== 'object' ||
    !(signed.statement instanceof Uint8Array) ||
    !(signed.signature instanceof Uint8Array)
  ) {
    throw new E2eeError('invalid-argument', `Not a signed ${what}`);
  }
  return {
    statement: copyBytes(signed.statement),
    signature: copyBytes(signed.signature)
  };
}

/**
 * `SHA-256(label "v1 share key hash" | share key)`: what a link grant, a
 * share-authority statement and the active link set name a share key by.
 * The key has full entropy, so the hash reveals nothing about it.
 */
export async function shareKeyHash(shareKey: Uint8Array): Promise<Bytes> {
  if (!(shareKey instanceof Uint8Array) || shareKey.byteLength !== KEY_BYTES) {
    throw new E2eeError('invalid-argument', 'A share key is 32 bytes');
  }
  return sha256(concatBytes(label('v1 share key hash'), copyBytes(shareKey)));
}

/**
 * Opens a link's share key from its `share-key` wrap under an epoch's
 * project key and checks it against the hash its owner-signed grant names
 * (`context-mismatch` otherwise), so a member who wrapped another key under
 * the link's id cannot make editors publish to a key the link does not
 * hold.
 */
export async function openShareKey(
  projectKey: KeyMaterial,
  wrapped: Uint8Array,
  context: {
    readonly projectId: string;
    readonly keyEpoch: number;
    readonly shareId: string;
  },
  expectedShareKeyHash: Uint8Array
): Promise<Bytes> {
  if (!isHash(expectedShareKeyHash)) {
    throw new E2eeError('invalid-argument', 'A share key hash is 32 bytes');
  }
  const expected = copyBytes(expectedShareKeyHash);
  const key = await unwrapKey(projectKey, wrapped, {
    purpose: 'share-key',
    projectId: context?.projectId,
    keyEpoch: context?.keyEpoch,
    shareId: context?.shareId
  });
  if (!equalBytes(await shareKeyHash(key), expected)) {
    throw new E2eeError(
      'context-mismatch',
      'The share key is not the one the link grant names'
    );
  }
  return key;
}

// --- Share delegation ------------------------------------------------------

/**
 * Signed by the owner's identity key: which owner devices may sign
 * share-authority statements, until `expiresAt` (at most 30 days after
 * `issuedAt`). It names no user id, since an anonymous visitor sees it, and
 * carries the device keys whole, so a visitor needs no device list.
 */
export interface ShareDelegation {
  /** `publicKeyHash` of the owner's identity key: the link's `<owner>`. */
  readonly identityKeyHash: Uint8Array;
  /** Rises with each delegation the identity signs. */
  readonly sequence: number;
  /** Unix milliseconds. */
  readonly issuedAt: number;
  /** Unix milliseconds; at most 30 days after `issuedAt`. */
  readonly expiresAt: number;
  /** Raw device signing public keys; sorted bytewise on encoding. */
  readonly deviceKeys: readonly Uint8Array[];
}

function checkDelegation(value: ShareDelegation, code: E2eeErrorCode): void {
  const fail: (message: string) => never = (message) => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') {
    fail('Expected a share delegation');
  }
  if (!isHash(value.identityKeyHash)) fail('identityKeyHash must be 32 bytes');
  if (!isUint(value.sequence, MAX_U32)) fail('sequence must be a u32');
  checkLifetime(
    value.issuedAt,
    value.expiresAt,
    MAX_SHARE_DELEGATION_LIFETIME_MS,
    'A share delegation',
    fail
  );
  if (
    !Array.isArray(value.deviceKeys) ||
    value.deviceKeys.length === 0 ||
    value.deviceKeys.length > MAX_DELEGATED_DEVICES
  ) {
    fail(`A delegation names 1..${MAX_DELEGATED_DEVICES} devices`);
  }
  const seen = new Set<string>();
  for (const key of value.deviceKeys) {
    if (!isRawPublicKey(key)) fail('A delegated key is a raw P-256 point');
    const hex = toHex(key);
    if (seen.has(hex)) fail('A delegation names each device key once');
    seen.add(hex);
  }
}

/**
 * Canonical bytes: `"OZS" | u8 1 | 32-byte owner identity key hash | u32
 * sequence | u64 issuedAt | u64 expiresAt | u8 count + 65-byte device
 * signing keys, sorted bytewise`.
 */
export function encodeShareDelegation(value: ShareDelegation): Bytes {
  checkDelegation(value, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(DELEGATION_MAGIC)
    .u8(SHARE_DELEGATION_VERSION_1)
    .bytes(value.identityKeyHash)
    .u32(value.sequence)
    .u64(value.issuedAt)
    .u64(value.expiresAt)
    .u8(value.deviceKeys.length);
  for (const key of [...value.deviceKeys].sort(compareBytes)) {
    writer.bytes(key);
  }
  return writer.finish();
}

/** Decodes canonical delegation bytes; anything else is `malformed`. */
export function decodeShareDelegation(bytes: Uint8Array): ShareDelegation {
  checkInput(bytes, MAX_SHARE_DELEGATION_BYTES, 'Share delegation');
  const reader = new ByteReader(bytes, 'Share delegation');
  readMagic(
    reader,
    DELEGATION_MAGIC,
    SHARE_DELEGATION_VERSION_1,
    'share delegation'
  );
  const identityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const sequence = reader.u32();
  const issuedAt = reader.u64();
  const expiresAt = reader.u64();
  const deviceKeys: Bytes[] = [];
  for (let count = reader.u8(); count > 0; count -= 1) {
    deviceKeys.push(copyBytes(reader.bytes(P256_PUBLIC_KEY_BYTES)));
  }
  reader.end();
  const value: ShareDelegation = {
    identityKeyHash,
    sequence,
    issuedAt,
    expiresAt,
    deviceKeys
  };
  checkDelegation(value, 'malformed');
  if (!equalBytes(encodeShareDelegation(value), bytes)) {
    throw new E2eeError('malformed', 'Share delegation is not canonical');
  }
  return value;
}

/** The identity key signs a delegation; ask for a passkey or the recovery key. */
export async function signShareDelegation(
  identityPrivateKey: SigningPrivateKey,
  value: ShareDelegation
): Promise<SignedStatement> {
  const statement = encodeShareDelegation(value);
  return {
    statement,
    signature: await signStatement(
      identityPrivateKey,
      'share delegation',
      statement
    )
  };
}

/**
 * Decodes a delegation and checks it against the owner's identity key:
 * the key hashes to the delegation's `identityKeyHash` (and to
 * `ownerIdentityKeyHash`, the link's `<owner>`, when given), the identity
 * signed it, and it is valid at `now`. Refusals are `ShareLinkError`s.
 */
export async function verifyShareDelegation(
  signed: SignedStatement,
  identityPublicKey: Uint8Array | CryptoKey,
  options: {
    readonly now: number;
    readonly ownerIdentityKeyHash?: Uint8Array;
  }
): Promise<ShareDelegation> {
  const { statement, signature } = copySigned(signed, 'share delegation');
  const now = options?.now;
  checkNow(now);
  const owner = options.ownerIdentityKeyHash;
  if (owner !== undefined && !isHash(owner)) {
    throw new E2eeError('invalid-argument', 'An owner hash is 32 bytes');
  }
  const ownerHash = owner === undefined ? undefined : copyBytes(owner);
  const value = decodeShareDelegation(statement);
  const { key, raw } = await verifyingKey(identityPublicKey);
  const identityHash = await publicKeyHash(raw);
  if (ownerHash && !equalBytes(identityHash, ownerHash)) {
    refuse('owner-mismatch', 'The identity key is not the link owner');
  }
  if (!equalBytes(identityHash, value.identityKeyHash)) {
    refuse('owner-mismatch', 'The delegation names another identity');
  }
  if (!(await statementValid(key, 'share delegation', statement, signature))) {
    refuse(
      'delegation-signature',
      'The share delegation is not signed by the owner identity'
    );
  }
  checkValidAt(value.issuedAt, value.expiresAt, now, 'delegation');
  return value;
}

// --- Share-authority statement ---------------------------------------------

/**
 * Signed by an owner device the delegation names: who may publish
 * snapshots of one link, until `expiresAt` (at most 7 days after
 * `issuedAt`). Author credentials are `publicKeyHash`es of device signing
 * keys: the owner's and each current editor's, as certified in the newest
 * device list the owner's browser pinned for that person. It names no user
 * ids, since an anonymous visitor sees it.
 */
export interface ShareAuthorityStatement {
  readonly projectId: string;
  /** The link id. */
  readonly shareId: string;
  /** `shareKeyHash` of the link's share key. */
  readonly shareKeyHash: Uint8Array;
  readonly mode: ShareLinkMode;
  /** `publicKeyHash` of the owner's identity key: the link's `<owner>`. */
  readonly ownerIdentityKeyHash: Uint8Array;
  /** Rises with each statement issued for this link. */
  readonly sequence: number;
  readonly issuedAt: number;
  /** At most 7 days after `issuedAt`. */
  readonly expiresAt: number;
  /** `publicKeyHash` of the owner device key that signs the statement. */
  readonly signerKeyHash: Uint8Array;
  /** Author credentials; sorted bytewise on encoding. */
  readonly authorKeyHashes: readonly Uint8Array[];
}

function checkAuthority(
  value: ShareAuthorityStatement,
  code: E2eeErrorCode
): void {
  const fail: (message: string) => never = (message) => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') {
    fail('Expected a share-authority statement');
  }
  if (!isEnvelopeId(value.projectId)) fail('projectId is not an id');
  if (!isEnvelopeId(value.shareId)) fail('shareId is not an id');
  if (!isHash(value.shareKeyHash)) fail('shareKeyHash must be 32 bytes');
  if (!SHARE_LINK_MODES.includes(value.mode)) fail('Unknown share link mode');
  if (!isHash(value.ownerIdentityKeyHash)) {
    fail('ownerIdentityKeyHash must be 32 bytes');
  }
  if (!isUint(value.sequence, MAX_U32)) fail('sequence must be a u32');
  checkLifetime(
    value.issuedAt,
    value.expiresAt,
    MAX_SHARE_AUTHORITY_LIFETIME_MS,
    'A share-authority statement',
    fail
  );
  if (!isHash(value.signerKeyHash)) fail('signerKeyHash must be 32 bytes');
  if (
    !Array.isArray(value.authorKeyHashes) ||
    value.authorKeyHashes.length === 0 ||
    value.authorKeyHashes.length > MAX_SHARE_AUTHORS
  ) {
    fail(`A statement names 1..${MAX_SHARE_AUTHORS} authors`);
  }
  const seen = new Set<string>();
  for (const hash of value.authorKeyHashes) {
    if (!isHash(hash)) fail('An author key hash is 32 bytes');
    const hex = toHex(hash);
    if (seen.has(hex)) fail('A statement names each author key once');
    seen.add(hex);
  }
}

/**
 * Canonical bytes: `"OZA" | u8 1 | u8 length + project id | u8 length +
 * link id | 32-byte share key hash | u8 mode (1 view, 2 tweak) | 32-byte
 * owner identity key hash | u32 sequence | u64 issuedAt | u64 expiresAt |
 * 32-byte signer key hash | u16 count + 32-byte author key hashes, sorted
 * bytewise`.
 */
export function encodeShareAuthority(value: ShareAuthorityStatement): Bytes {
  checkAuthority(value, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(AUTHORITY_MAGIC)
    .u8(SHARE_AUTHORITY_VERSION_1);
  writeId(writer, value.projectId);
  writeId(writer, value.shareId);
  writer
    .bytes(value.shareKeyHash)
    .u8(MODE_CODES[value.mode])
    .bytes(value.ownerIdentityKeyHash)
    .u32(value.sequence)
    .u64(value.issuedAt)
    .u64(value.expiresAt)
    .bytes(value.signerKeyHash)
    .u16(value.authorKeyHashes.length);
  for (const hash of [...value.authorKeyHashes].sort(compareBytes)) {
    writer.bytes(hash);
  }
  return writer.finish();
}

/** Decodes canonical statement bytes; anything else is `malformed`. */
export function decodeShareAuthority(
  bytes: Uint8Array
): ShareAuthorityStatement {
  checkInput(bytes, MAX_SHARE_AUTHORITY_BYTES, 'Share-authority statement');
  const reader = new ByteReader(bytes, 'Share-authority statement');
  readMagic(
    reader,
    AUTHORITY_MAGIC,
    SHARE_AUTHORITY_VERSION_1,
    'share-authority statement'
  );
  const projectId = readId(reader);
  const shareId = readId(reader);
  const shareKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const mode = readMode(reader);
  const ownerIdentityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const sequence = reader.u32();
  const issuedAt = reader.u64();
  const expiresAt = reader.u64();
  const signerKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const count = reader.u16();
  if (count > MAX_SHARE_AUTHORS) {
    throw new E2eeError('malformed', 'A statement names too many authors');
  }
  const authorKeyHashes: Bytes[] = [];
  for (let i = 0; i < count; i += 1) {
    authorKeyHashes.push(copyBytes(reader.bytes(HASH_BYTES)));
  }
  reader.end();
  const value: ShareAuthorityStatement = {
    projectId,
    shareId,
    shareKeyHash,
    mode,
    ownerIdentityKeyHash,
    sequence,
    issuedAt,
    expiresAt,
    signerKeyHash,
    authorKeyHashes
  };
  checkAuthority(value, 'malformed');
  if (!equalBytes(encodeShareAuthority(value), bytes)) {
    throw new E2eeError(
      'malformed',
      'Share-authority statement is not canonical'
    );
  }
  return value;
}

/** An owner device the delegation names signs a link's statement. */
export async function signShareAuthority(
  ownerDeviceKey: SigningPrivateKey,
  value: ShareAuthorityStatement
): Promise<SignedStatement> {
  const statement = encodeShareAuthority(value);
  return {
    statement,
    signature: await signStatement(ownerDeviceKey, 'share authority', statement)
  };
}

/**
 * Decodes a statement and checks it against a verified delegation (from
 * `verifyShareDelegation`): the same owner, a signing device the
 * delegation names, a valid signature, and validity at `now`. With
 * `expected`, the statement must also be for that project, link id and
 * share key hash (`link-mismatch`). Refusals are `ShareLinkError`s.
 */
export async function verifyShareAuthority(
  signed: SignedStatement,
  delegation: ShareDelegation,
  options: {
    readonly now: number;
    readonly expected?: {
      readonly projectId?: string;
      readonly shareId?: string;
      readonly shareKeyHash?: Uint8Array;
    };
  }
): Promise<ShareAuthorityStatement> {
  const { statement, signature } = copySigned(
    signed,
    'share-authority statement'
  );
  const now = options?.now;
  checkNow(now);
  const expected = {
    projectId: options.expected?.projectId,
    shareId: options.expected?.shareId,
    shareKeyHash:
      options.expected?.shareKeyHash === undefined
        ? undefined
        : copyBytes(options.expected.shareKeyHash)
  };
  // Re-check the delegation, so a hand-built one cannot widen authority.
  checkDelegation(delegation, 'invalid-argument');
  const delegatedKeys = delegation.deviceKeys.map((key) => copyBytes(key));
  const ownerHash = copyBytes(delegation.identityKeyHash);
  const value = decodeShareAuthority(statement);
  if (!equalBytes(value.ownerIdentityKeyHash, ownerHash)) {
    refuse('owner-mismatch', 'The statement names another owner');
  }
  // The signing device must be named in the delegation.
  let signerKey: Bytes | undefined;
  for (const key of delegatedKeys) {
    if (equalBytes(await publicKeyHash(key), value.signerKeyHash)) {
      signerKey = key;
      break;
    }
  }
  if (!signerKey) {
    refuse(
      'signer-not-delegated',
      'The statement is signed by a device the delegation does not name'
    );
  }
  const { key } = await verifyingKey(signerKey);
  if (!(await statementValid(key, 'share authority', statement, signature))) {
    refuse('authority-signature', 'The share-authority statement is forged');
  }
  checkValidAt(value.issuedAt, value.expiresAt, now, 'authority');
  if (
    (expected.projectId !== undefined &&
      value.projectId !== expected.projectId) ||
    (expected.shareId !== undefined && value.shareId !== expected.shareId) ||
    (expected.shareKeyHash !== undefined &&
      !equalBytes(value.shareKeyHash, expected.shareKeyHash))
  ) {
    refuse('link-mismatch', 'The statement is for another link');
  }
  return value;
}

// --- Visitor check -----------------------------------------------------------

export interface SharedSnapshotInput {
  /** From the link fragment: the owner's identity key hash. */
  readonly ownerIdentityKeyHash: Uint8Array;
  /** From the link fragment: the share key. */
  readonly shareKey: Uint8Array;
  /** Served: the owner's identity public key. */
  readonly ownerIdentityKey: Uint8Array | CryptoKey;
  /** Served: the owner's current share delegation. */
  readonly delegation: SignedStatement;
  /** Served: the link's share-authority statement. */
  readonly authority: SignedStatement;
  /** Served: the `share-snapshot` project envelope. */
  readonly snapshot: Uint8Array;
  /** Served: its version signature (`signProjectEnvelope`). */
  readonly snapshotSignature: Uint8Array;
  /** Served: the author's device signing public key. */
  readonly authorKey: Uint8Array | CryptoKey;
  /** The visitor's clock, Unix milliseconds. */
  readonly now: number;
}

export interface VerifiedSharedSnapshot {
  readonly projectId: string;
  readonly shareId: string;
  readonly mode: ShareLinkMode;
  readonly header: ProjectEnvelopeHeader;
  /** The author's signed timestamp. */
  readonly signedAt: number;
  readonly authorKeyHash: Bytes;
  readonly delegation: ShareDelegation;
  readonly authority: ShareAuthorityStatement;
}

/**
 * What a link visitor checks before decrypting a snapshot, in the ADR's
 * order: the owner hash in the link against the served identity key; the
 * identity-signed delegation and its expiry; that the statement's signing
 * device is named in it; the statement's signature and expiry (and that it
 * is for the link whose share key the visitor holds); then that the
 * snapshot's signing credential is one the statement names, its signature,
 * and that it is a share snapshot of the statement's project. The author's
 * own device list is not consulted: a visitor has no pin for it.
 *
 * Accept the snapshot only if this returns; then open its version key with
 * the share key (`share-version-key`) and decrypt it with
 * `decryptProjectEnvelope`. Refusals are `ShareLinkError`s, or `E2eeError`s
 * for bytes that are not the formats at all.
 */
export async function verifySharedSnapshot(
  input: SharedSnapshotInput
): Promise<VerifiedSharedSnapshot> {
  if (input === null || typeof input !== 'object') {
    throw new E2eeError('invalid-argument', 'Expected a shared snapshot');
  }
  // Copy every input before the first await.
  if (!isHash(input.ownerIdentityKeyHash)) {
    throw new E2eeError('invalid-argument', 'An owner hash is 32 bytes');
  }
  const ownerHash = copyBytes(input.ownerIdentityKeyHash);
  if (
    !(input.shareKey instanceof Uint8Array) ||
    input.shareKey.byteLength !== KEY_BYTES
  ) {
    throw new E2eeError('invalid-argument', 'A share key is 32 bytes');
  }
  const shareKey = copyBytes(input.shareKey);
  const ownerKey =
    input.ownerIdentityKey instanceof Uint8Array
      ? copyBytes(input.ownerIdentityKey)
      : input.ownerIdentityKey;
  const authorKey =
    input.authorKey instanceof Uint8Array
      ? copyBytes(input.authorKey)
      : input.authorKey;
  const delegationSigned = copySigned(input.delegation, 'share delegation');
  const authoritySigned = copySigned(
    input.authority,
    'share-authority statement'
  );
  if (!(input.snapshot instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'A snapshot is a Uint8Array');
  }
  if (!(input.snapshotSignature instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'A signature is a Uint8Array');
  }
  const snapshot = copyBytes(input.snapshot);
  const snapshotSignature = copyBytes(input.snapshotSignature);
  const now = input.now;
  checkNow(now);

  // 1–2. The owner hash in the link, then the delegation and its expiry.
  const delegation = await verifyShareDelegation(delegationSigned, ownerKey, {
    now,
    ownerIdentityKeyHash: ownerHash
  });
  // 3–4. The statement's signer is delegated; its signature and expiry;
  // and it is for the link whose key the visitor holds.
  const authority = await verifyShareAuthority(authoritySigned, delegation, {
    now,
    expected: { shareKeyHash: await shareKeyHash(shareKey) }
  });
  // 5. The snapshot's signing credential is one the statement names.
  const { key, raw } = await verifyingKey(authorKey);
  const authorKeyHash = await publicKeyHash(raw);
  if (!authority.authorKeyHashes.some((h) => equalBytes(h, authorKeyHash))) {
    refuse(
      'author-not-named',
      'The snapshot is signed by a key the statement does not name'
    );
  }
  const verified = await verifyProjectEnvelopeSignature(
    key,
    snapshot,
    snapshotSignature
  );
  if (!verified) {
    refuse('snapshot-signature', 'The snapshot signature is not valid');
  }
  const { header } = parseEnvelope(snapshot);
  if (
    header.class !== 'project' ||
    header.kind !== 'share-snapshot' ||
    header.projectId !== authority.projectId
  ) {
    refuse(
      'snapshot-mismatch',
      "The envelope is not a share snapshot of the statement's project"
    );
  }
  return {
    projectId: authority.projectId,
    shareId: authority.shareId,
    mode: authority.mode,
    header,
    signedAt: verified.signedAt,
    authorKeyHash,
    delegation,
    authority
  };
}

// --- Link grants and tombstones ------------------------------------------

/**
 * An owner device's grant of one active link: its id, the hash of its
 * share key and its mode. `keyEpoch` is the project key epoch the link was
 * granted in, so a grant never names an epoch after the version that
 * carries it, and a revoked owner device's grants can be judged against
 * its revocation cutoff.
 */
export interface ShareLinkGrant {
  readonly projectId: string;
  readonly shareId: string;
  readonly shareKeyHash: Uint8Array;
  readonly mode: ShareLinkMode;
  readonly keyEpoch: number;
  readonly issuedAt: number;
  /** `publicKeyHash` of the owner device key that signs the grant. */
  readonly signerKeyHash: Uint8Array;
}

/**
 * An owner device's permanent revocation of one link id. It is never
 * lifted: restoring access means a new link with a new id and key.
 */
export interface ShareLinkTombstone {
  readonly projectId: string;
  readonly shareId: string;
  readonly keyEpoch: number;
  readonly issuedAt: number;
  readonly signerKeyHash: Uint8Array;
}

function checkLinkCommon(
  value: ShareLinkGrant | ShareLinkTombstone,
  fail: (message: string) => never
): void {
  if (!isEnvelopeId(value.projectId)) fail('projectId is not an id');
  if (!isEnvelopeId(value.shareId)) fail('shareId is not an id');
  if (!isUint(value.keyEpoch, MAX_U32)) fail('keyEpoch must be a u32');
  if (!isUint(value.issuedAt, Number.MAX_SAFE_INTEGER)) {
    fail('issuedAt must be Unix milliseconds');
  }
  if (!isHash(value.signerKeyHash)) fail('signerKeyHash must be 32 bytes');
}

function checkGrant(value: ShareLinkGrant, code: E2eeErrorCode): void {
  const fail: (message: string) => never = (message) => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') fail('Expected a grant');
  checkLinkCommon(value, fail);
  if (!isHash(value.shareKeyHash)) fail('shareKeyHash must be 32 bytes');
  if (!SHARE_LINK_MODES.includes(value.mode)) fail('Unknown share link mode');
}

function checkTombstone(value: ShareLinkTombstone, code: E2eeErrorCode): void {
  const fail: (message: string) => never = (message) => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') fail('Expected a tombstone');
  checkLinkCommon(value, fail);
}

/**
 * Canonical bytes: `"OZL" | u8 1 | u8 length + project id | u8 length +
 * link id | 32-byte share key hash | u8 mode (1 view, 2 tweak) | u32 key
 * epoch | u64 issuedAt | 32-byte signer key hash`.
 */
export function encodeShareLinkGrant(value: ShareLinkGrant): Bytes {
  checkGrant(value, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(GRANT_MAGIC)
    .u8(SHARE_LINK_GRANT_VERSION_1);
  writeId(writer, value.projectId);
  writeId(writer, value.shareId);
  return writer
    .bytes(value.shareKeyHash)
    .u8(MODE_CODES[value.mode])
    .u32(value.keyEpoch)
    .u64(value.issuedAt)
    .bytes(value.signerKeyHash)
    .finish();
}

/** Decodes canonical grant bytes; anything else is `malformed`. */
export function decodeShareLinkGrant(bytes: Uint8Array): ShareLinkGrant {
  checkInput(bytes, MAX_SHARE_LINK_GRANT_BYTES, 'Link grant');
  const reader = new ByteReader(bytes, 'Link grant');
  readMagic(reader, GRANT_MAGIC, SHARE_LINK_GRANT_VERSION_1, 'link grant');
  const projectId = readId(reader);
  const shareId = readId(reader);
  const shareKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const mode = readMode(reader);
  const keyEpoch = reader.u32();
  const issuedAt = reader.u64();
  const signerKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  reader.end();
  const value: ShareLinkGrant = {
    projectId,
    shareId,
    shareKeyHash,
    mode,
    keyEpoch,
    issuedAt,
    signerKeyHash
  };
  checkGrant(value, 'malformed');
  if (!equalBytes(encodeShareLinkGrant(value), bytes)) {
    throw new E2eeError('malformed', 'Link grant is not canonical');
  }
  return value;
}

/**
 * Canonical bytes: `"OZY" | u8 1 | u8 length + project id | u8 length +
 * link id | u32 key epoch | u64 issuedAt | 32-byte signer key hash`.
 */
export function encodeShareLinkTombstone(value: ShareLinkTombstone): Bytes {
  checkTombstone(value, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(TOMBSTONE_MAGIC)
    .u8(SHARE_LINK_TOMBSTONE_VERSION_1);
  writeId(writer, value.projectId);
  writeId(writer, value.shareId);
  return writer
    .u32(value.keyEpoch)
    .u64(value.issuedAt)
    .bytes(value.signerKeyHash)
    .finish();
}

/** Decodes canonical tombstone bytes; anything else is `malformed`. */
export function decodeShareLinkTombstone(
  bytes: Uint8Array
): ShareLinkTombstone {
  checkInput(bytes, MAX_SHARE_LINK_TOMBSTONE_BYTES, 'Link tombstone');
  const reader = new ByteReader(bytes, 'Link tombstone');
  readMagic(
    reader,
    TOMBSTONE_MAGIC,
    SHARE_LINK_TOMBSTONE_VERSION_1,
    'link tombstone'
  );
  const projectId = readId(reader);
  const shareId = readId(reader);
  const keyEpoch = reader.u32();
  const issuedAt = reader.u64();
  const signerKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  reader.end();
  const value: ShareLinkTombstone = {
    projectId,
    shareId,
    keyEpoch,
    issuedAt,
    signerKeyHash
  };
  checkTombstone(value, 'malformed');
  if (!equalBytes(encodeShareLinkTombstone(value), bytes)) {
    throw new E2eeError('malformed', 'Link tombstone is not canonical');
  }
  return value;
}

/** An owner device grants a link. */
export async function signShareLinkGrant(
  ownerDeviceKey: SigningPrivateKey,
  value: ShareLinkGrant
): Promise<SignedStatement> {
  const statement = encodeShareLinkGrant(value);
  return {
    statement,
    signature: await signStatement(
      ownerDeviceKey,
      'share link grant',
      statement
    )
  };
}

/** An owner device revokes a link id, permanently. */
export async function signShareLinkTombstone(
  ownerDeviceKey: SigningPrivateKey,
  value: ShareLinkTombstone
): Promise<SignedStatement> {
  const statement = encodeShareLinkTombstone(value);
  return {
    statement,
    signature: await signStatement(
      ownerDeviceKey,
      'share link tombstone',
      statement
    )
  };
}

// --- The active link set ---------------------------------------------------

/**
 * The project's active link set as a document body carries it
 * (`EncryptedDocumentBody.shareLinks`): signed grants and signed
 * tombstones, each list sorted by link id with each id at most once, and
 * no id in both.
 */
export interface ShareLinkSet {
  readonly grants: readonly SignedStatement[];
  readonly tombstones: readonly SignedStatement[];
}

/**
 * @internal Structure of a link set, without signatures: canonical grants
 * and tombstones, sorted by link id, unique, disjoint, no grant or
 * tombstone after `keyEpoch` when given. Returns the decoded lists, in
 * id order. With `sort` (an encoder), the lists may come in any order.
 * Body codecs call it with their side's error code.
 */
export function checkShareLinkSet(
  set: ShareLinkSet,
  code: 'invalid-argument' | 'malformed',
  keyEpoch?: number,
  sort = false
): {
  grants: { signed: SignedStatement; value: ShareLinkGrant }[];
  tombstones: { signed: SignedStatement; value: ShareLinkTombstone }[];
} {
  const fail: (message: string) => never = (message) => {
    throw new E2eeError(code, message);
  };
  if (
    set === null ||
    typeof set !== 'object' ||
    !Array.isArray(set.grants) ||
    !Array.isArray(set.tombstones)
  ) {
    fail('A link set has grants and tombstones');
  }
  if (set.grants.length > MAX_SHARE_LINKS) {
    throw new E2eeError(
      code === 'malformed' ? 'limit-exceeded' : code,
      `A link set holds at most ${MAX_SHARE_LINKS} links`
    );
  }
  if (set.tombstones.length > MAX_SHARE_TOMBSTONES) {
    throw new E2eeError(
      code === 'malformed' ? 'limit-exceeded' : code,
      `A link set holds at most ${MAX_SHARE_TOMBSTONES} tombstones`
    );
  }
  const read = <T>(
    signed: unknown,
    decode: (bytes: Uint8Array) => T
  ): { signed: SignedStatement; value: T } => {
    const s = signed as SignedStatement | null;
    if (
      s === null ||
      typeof s !== 'object' ||
      !(s.statement instanceof Uint8Array) ||
      !(s.signature instanceof Uint8Array) ||
      s.signature.byteLength !== SIGNATURE_BYTES
    ) {
      fail('A link set entry is a statement and a 65-byte signature');
    }
    const copy = {
      statement: copyBytes(s.statement),
      signature: copyBytes(s.signature)
    };
    try {
      return { signed: copy, value: decode(copy.statement) };
    } catch (cause) {
      if (code === 'malformed' && cause instanceof E2eeError) throw cause;
      throw new E2eeError(code, 'A link set entry is not canonical', {
        cause
      });
    }
  };
  const grants = (set.grants as readonly unknown[]).map((g) =>
    read(g, decodeShareLinkGrant)
  );
  const tombstones = (set.tombstones as readonly unknown[]).map((t) =>
    read(t, decodeShareLinkTombstone)
  );
  for (const list of [grants, tombstones]) {
    if (sort) list.sort((a, b) => byId(a.value.shareId, b.value.shareId));
    for (let i = 1; i < list.length; i += 1) {
      if (byId(list[i - 1]!.value.shareId, list[i]!.value.shareId) >= 0) {
        fail('A link set lists each id once, sorted by id');
      }
    }
  }
  const revoked = new Set(tombstones.map((t) => t.value.shareId));
  if (grants.some((g) => revoked.has(g.value.shareId))) {
    throw new ShareLinkError(
      'tombstoned',
      'A link set lists a revoked link as active'
    );
  }
  if (keyEpoch !== undefined) {
    for (const { value } of [...grants, ...tombstones]) {
      if (value.keyEpoch > keyEpoch) {
        throw new ShareLinkError(
          'grant-mismatch',
          'A link set entry names a later key epoch than its version'
        );
      }
    }
  }
  return { grants, tombstones };
}

/** One active link of a verified set. */
export interface ActiveShareLink {
  readonly shareId: string;
  readonly shareKeyHash: Bytes;
  readonly mode: ShareLinkMode;
  readonly grant: ShareLinkGrant;
}

export interface VerifiedShareLinkSet {
  readonly links: readonly ActiveShareLink[];
  readonly tombstones: readonly ShareLinkTombstone[];
  /** Every revoked link id: the set's and those `seenTombstones` named. */
  readonly tombstonedIds: ReadonlySet<string>;
  /** A copy of the verified set, to compare the next version's against. */
  readonly set: ShareLinkSet;
}

/** What `resolveOwnerKey` learns about one grant or tombstone. */
export interface ShareLinkSigner {
  readonly entry: 'grant' | 'tombstone';
  readonly shareId: string;
  readonly keyEpoch: number;
  readonly signerKeyHash: Bytes;
}

export interface VerifyShareLinkSetOptions {
  readonly projectId: string;
  /** The key epoch of the version whose body carries the set. */
  readonly keyEpoch: number;
  /**
   * The owner's device signing key that `signer.signerKeyHash` names, or
   * null when it may not sign for the owner: not in the owner's verified
   * device list, or revoked with the entry's key epoch at or past its
   * revocation cutoff for this project.
   */
  readonly resolveOwnerKey: (
    signer: ShareLinkSigner
  ) =>
    | Uint8Array
    | CryptoKey
    | null
    | undefined
    | Promise<Uint8Array | CryptoKey | null | undefined>;
  /** Link ids this browser has seen tombstones for in this project. */
  readonly seenTombstones?: Iterable<string>;
  /**
   * The set of the version's parent, as verified: every tombstone it held
   * must still be present, and unless `authorIsOwner` the set must be
   * unchanged (editors only carry it forward).
   */
  readonly previous?: VerifiedShareLinkSet;
  /** Whether the version that carries this set was written by the owner. */
  readonly authorIsOwner?: boolean;
}

function sameSigned(a: SignedStatement, b: SignedStatement): boolean {
  return (
    equalBytes(a.statement, b.statement) && equalBytes(a.signature, b.signature)
  );
}

/** Whether two link sets hold exactly the same signed grants and tombstones. */
export function sameShareLinkSet(a: ShareLinkSet, b: ShareLinkSet): boolean {
  return (
    a.grants.length === b.grants.length &&
    a.tombstones.length === b.tombstones.length &&
    a.grants.every((g, i) => sameSigned(g, b.grants[i]!)) &&
    a.tombstones.every((t, i) => sameSigned(t, b.tombstones[i]!))
  );
}

/**
 * Checks a version's active link set (ADR-024, share-link revocation is
 * project state): every listed link has a valid owner grant for this
 * project and no tombstone (in the set or seen before), every tombstone is
 * owner-signed, no entry names a later key epoch than its version, a
 * tombstone the parent held is never dropped, and an editor's version
 * carries the parent's set unchanged. Refusals are `ShareLinkError`s.
 */
export async function verifyShareLinkSet(
  set: ShareLinkSet,
  options: VerifyShareLinkSetOptions
): Promise<VerifiedShareLinkSet> {
  if (options === null || typeof options !== 'object') {
    throw new E2eeError('invalid-argument', 'Expected link set options');
  }
  const { projectId, keyEpoch, resolveOwnerKey, previous } = options;
  if (!isEnvelopeId(projectId)) {
    throw new E2eeError('invalid-argument', 'projectId is not an id');
  }
  if (!isUint(keyEpoch, MAX_U32)) {
    throw new E2eeError('invalid-argument', 'keyEpoch must be a u32');
  }
  if (typeof resolveOwnerKey !== 'function') {
    throw new E2eeError('invalid-argument', 'resolveOwnerKey is required');
  }
  if (previous !== undefined && typeof options.authorIsOwner !== 'boolean') {
    throw new E2eeError(
      'invalid-argument',
      'authorIsOwner is required with a previous set'
    );
  }
  const seen = new Set<string>(options.seenTombstones ?? []);
  // Copies and structure before the first await.
  const { grants, tombstones } = checkShareLinkSet(
    set,
    'invalid-argument',
    undefined
  );
  const copy: ShareLinkSet = {
    grants: grants.map((g) => g.signed),
    tombstones: tombstones.map((t) => t.signed)
  };
  for (const { value } of [...grants, ...tombstones]) {
    if (value.projectId !== projectId) {
      refuse('grant-mismatch', 'A link set entry is for another project');
    }
    if (value.keyEpoch > keyEpoch) {
      refuse(
        'grant-mismatch',
        'A link set entry names a later key epoch than its version'
      );
    }
  }
  for (const { value } of grants) {
    if (seen.has(value.shareId)) {
      refuse('tombstoned', `Link ${value.shareId} was revoked`);
    }
  }
  if (previous) {
    const kept = new Set(tombstones.map((t) => t.value.shareId));
    for (const old of previous.tombstones) {
      if (!kept.has(old.shareId)) {
        refuse(
          'tombstone-dropped',
          `The tombstone for link ${old.shareId} was dropped`
        );
      }
    }
    if (!options.authorIsOwner && !sameShareLinkSet(previous.set, copy)) {
      refuse(
        'changed-by-editor',
        'Only the owner may change the active link set'
      );
    }
  }
  const check = async (
    entry: 'grant' | 'tombstone',
    signed: SignedStatement,
    value: ShareLinkGrant | ShareLinkTombstone
  ): Promise<void> => {
    const signerKeyHash = copyBytes(value.signerKeyHash);
    const resolved = await resolveOwnerKey({
      entry,
      shareId: value.shareId,
      keyEpoch: value.keyEpoch,
      signerKeyHash
    });
    if (resolved === null || resolved === undefined) {
      refuse('unknown-signer', `Link ${value.shareId} has no owner signer`);
    }
    const { key, raw } = await verifyingKey(resolved);
    if (!equalBytes(await publicKeyHash(raw), signerKeyHash)) {
      refuse('unknown-signer', 'The resolved key is not the named signer');
    }
    const kind =
      entry === 'grant' ? 'share link grant' : 'share link tombstone';
    if (
      !(await statementValid(key, kind, signed.statement, signed.signature))
    ) {
      refuse(
        entry === 'grant' ? 'grant-signature' : 'tombstone-signature',
        `The ${entry} for link ${value.shareId} is not owner-signed`
      );
    }
  };
  for (const { signed, value } of grants) await check('grant', signed, value);
  for (const { signed, value } of tombstones) {
    await check('tombstone', signed, value);
  }
  const tombstonedIds = new Set(seen);
  for (const { value } of tombstones) tombstonedIds.add(value.shareId);
  return {
    links: grants.map(({ value }) => ({
      shareId: value.shareId,
      shareKeyHash: copyBytes(value.shareKeyHash),
      mode: value.mode,
      grant: value
    })),
    tombstones: tombstones.map(({ value }) => value),
    tombstonedIds,
    set: copy
  };
}
