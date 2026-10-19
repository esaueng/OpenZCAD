import {
  ByteWriter,
  asBytes,
  equalBytes,
  fromBase32,
  isUint,
  label,
  toBase32,
  toDigitGroups,
  toHex,
  type Bytes
} from './bytes';
import { E2eeError } from './errors';
import { HASH_BYTES } from './header';
import { P256_PUBLIC_KEY_BYTES } from './keys';
import {
  KEY_BYTES,
  deriveHmacKey,
  hkdfBaseKey,
  sha256,
  subtle,
  systemRandom,
  type KeyMaterial,
  type RandomSource
} from './primitives';

// --- Asset de-duplication -------------------------------------------------

/** The per-project HMAC key: HKDF-SHA256(project key, label). */
export async function deriveAssetDedupeKey(
  projectKey: KeyMaterial
): Promise<CryptoKey> {
  return deriveHmacKey(
    await hkdfBaseKey(projectKey, 'Project key'),
    label('v1 asset dedupe')
  );
}

/**
 * Lowercase hex HMAC-SHA256 of an asset's plaintext: an index value stored
 * beside the content blob, never inside an envelope. Equal content in one
 * project (and epoch) dedupes; the server cannot test for a known file.
 */
export async function assetDedupeHash(
  dedupeKey: CryptoKey,
  content: Uint8Array
): Promise<string> {
  return toHex(
    new Uint8Array(await subtle().sign('HMAC', dedupeKey, asBytes(content)))
  );
}

// --- Key hashes and the codes people compare ------------------------------

function checkPublicKey(raw: Uint8Array, what = 'Public key'): void {
  if (
    !(raw instanceof Uint8Array) ||
    raw.byteLength !== P256_PUBLIC_KEY_BYTES ||
    raw[0] !== 0x04
  ) {
    throw new E2eeError(
      'invalid-argument',
      `${what} must be a 65-byte uncompressed P-256 key`
    );
  }
}

/**
 * The full 256-bit hash of one or more raw public keys: a member's
 * encryption and signing keys in that order, or one device key. This is
 * what a QR code carries, what the roster records as a verified key, and,
 * through `formatComparisonCode`, what people compare. It is never
 * shortened: a truncated hash of a key the server can see invites grinding.
 */
export async function publicKeyHash(
  publicKeys: Uint8Array | readonly Uint8Array[]
): Promise<Bytes> {
  const keys = publicKeys instanceof Uint8Array ? [publicKeys] : publicKeys;
  if (keys.length === 0 || keys.length > 255) {
    throw new E2eeError(
      'invalid-argument',
      'A key hash covers 1..255 public keys'
    );
  }
  const writer = new ByteWriter()
    .bytes(label('v1 public key hash'))
    .u8(keys.length);
  for (const key of keys) {
    checkPublicKey(key);
    writer.bytes(key);
  }
  return sha256(writer.finish());
}

/**
 * A 256-bit hash as 40 digits in eight groups of five (132.9 bits), the
 * form shown for fingerprints and project state codes.
 */
export function formatComparisonCode(hash: Uint8Array): string {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== HASH_BYTES) {
    throw new E2eeError(
      'invalid-argument',
      'Comparison codes come from a 32-byte hash'
    );
  }
  return toDigitGroups(hash);
}

/**
 * The fingerprint people verify for a user: the hash of their long-term
 * identity key, which survives device changes and key rotation. Show
 * `code`; `hash` is the QR form and the roster's `identityKeyHash`.
 */
export async function identityFingerprint(
  identityPublicKey: Uint8Array
): Promise<{ hash: Bytes; code: string }> {
  const hash = await publicKeyHash(identityPublicKey);
  return { hash, code: formatComparisonCode(hash) };
}

/**
 * What two people compare to verify a contact: the contact's identity key
 * together with their current device-list head, so a server cannot pair the
 * right identity with an old device list. Show `code`; `hash` is the QR
 * payload. The verifier pins the head with the identity.
 */
export async function contactVerificationCode(
  identityPublicKey: Uint8Array,
  deviceListHead: Uint8Array
): Promise<{ hash: Bytes; code: string }> {
  if (
    !(deviceListHead instanceof Uint8Array) ||
    deviceListHead.byteLength !== HASH_BYTES
  ) {
    throw new E2eeError('invalid-argument', 'deviceListHead must be 32 bytes');
  }
  const hash = await sha256(
    new ByteWriter()
      .bytes(label('v1 contact verification'))
      .bytes(await publicKeyHash(identityPublicKey))
      .bytes(deviceListHead)
      .finish()
  );
  return { hash, code: formatComparisonCode(hash) };
}

export interface ProjectStateInput {
  /** `versionHash` of the newest version. */
  readonly versionHash: Uint8Array;
  readonly documentVersion: number;
  /** Identity key hash of the member who signed that version. */
  readonly signerKeyHash: Uint8Array;
}

/**
 * The project state code members compare outside OpenZCAD to detect a
 * split view or rollback, which version chains alone cannot (they give
 * fork consistency only). Show `code`; `hash` is the QR form.
 */
export async function projectStateCode(
  input: ProjectStateInput
): Promise<{ hash: Bytes; code: string }> {
  for (const [name, value] of [
    ['versionHash', input.versionHash],
    ['signerKeyHash', input.signerKeyHash]
  ] as const) {
    if (!(value instanceof Uint8Array) || value.byteLength !== HASH_BYTES) {
      throw new E2eeError('invalid-argument', `${name} must be 32 bytes`);
    }
  }
  if (!isUint(input.documentVersion, Number.MAX_SAFE_INTEGER)) {
    throw new E2eeError(
      'invalid-argument',
      'documentVersion must be a safe integer'
    );
  }
  const hash = await sha256(
    new ByteWriter()
      .bytes(label('v1 project state'))
      .bytes(input.versionHash)
      .u64(input.documentVersion)
      .bytes(input.signerKeyHash)
      .finish()
  );
  return { hash, code: formatComparisonCode(hash) };
}

// --- Device approval ------------------------------------------------------

/**
 * Scan form: the new device shows `publicKeyHash(devicePublicKey)` as a QR
 * code; the approving device wraps the account key only if the key the
 * server delivered hashes to the scanned value.
 */
export async function verifyScannedDeviceKey(
  devicePublicKey: Uint8Array,
  scannedHash: Uint8Array
): Promise<boolean> {
  return equalBytes(await publicKeyHash(devicePublicKey), scannedHash);
}

/**
 * Compare form, a commitment-based short authentication string:
 *
 * 1. New device: `commitDeviceApproval(newDevicePublicKey)`; sends its key
 *    and `commitment`, keeps `nonce` back.
 * 2. Approving device: sends its own public key and `createApprovalNonce()`.
 * 3. New device: having received those, reveals `nonce`.
 * 4. Approving device: `verifyDeviceApprovalCommitment` must hold.
 * 5. Both show `deviceApprovalCode(...)`; the user approves only if equal.
 *
 * The commitment fixes the new side's key and nonce before the server sees
 * the approver's, so it cannot grind; a substituted key matches with
 * probability 10⁻⁶ per visible attempt.
 */
export interface DeviceApprovalCommitment {
  readonly nonce: Bytes;
  readonly commitment: Bytes;
}

function checkNonce(nonce: Uint8Array, what: string): void {
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== KEY_BYTES) {
    throw new E2eeError('invalid-argument', `${what} must be 32 bytes`);
  }
}

async function commitmentFor(
  newDevicePublicKey: Uint8Array,
  nonce: Uint8Array
): Promise<Bytes> {
  checkPublicKey(newDevicePublicKey, 'New device key');
  checkNonce(nonce, 'New device nonce');
  return sha256(
    new ByteWriter()
      .bytes(label('v1 device approval commitment'))
      .bytes(newDevicePublicKey)
      .bytes(nonce)
      .finish()
  );
}

/** @internal Tests inject the nonce; production uses `commitDeviceApproval`. */
export async function commitDeviceApprovalWith(
  newDevicePublicKey: Uint8Array,
  random: RandomSource
): Promise<DeviceApprovalCommitment> {
  const nonce = random(KEY_BYTES);
  return { nonce, commitment: await commitmentFor(newDevicePublicKey, nonce) };
}

export async function commitDeviceApproval(
  newDevicePublicKey: Uint8Array
): Promise<DeviceApprovalCommitment> {
  return commitDeviceApprovalWith(newDevicePublicKey, systemRandom);
}

export function createApprovalNonce(): Bytes {
  return systemRandom(KEY_BYTES);
}

export async function verifyDeviceApprovalCommitment(
  newDevicePublicKey: Uint8Array,
  newDeviceNonce: Uint8Array,
  commitment: Uint8Array
): Promise<boolean> {
  return equalBytes(
    await commitmentFor(newDevicePublicKey, newDeviceNonce),
    commitment
  );
}

export interface DeviceApprovalCodeInput {
  readonly newDevicePublicKey: Uint8Array;
  readonly approverPublicKey: Uint8Array;
  readonly newDeviceNonce: Uint8Array;
  readonly approverNonce: Uint8Array;
}

/** Six digits from H(pk_new ‖ pk_app ‖ n_new ‖ n_app), shown as `123 456`. */
export async function deviceApprovalCode(
  input: DeviceApprovalCodeInput
): Promise<string> {
  checkPublicKey(input.newDevicePublicKey, 'New device key');
  checkPublicKey(input.approverPublicKey, 'Approver key');
  checkNonce(input.newDeviceNonce, 'New device nonce');
  checkNonce(input.approverNonce, 'Approver nonce');
  const digest = await sha256(
    new ByteWriter()
      .bytes(label('v1 device approval code'))
      .bytes(input.newDevicePublicKey)
      .bytes(input.approverPublicKey)
      .bytes(input.newDeviceNonce)
      .bytes(input.approverNonce)
      .finish()
  );
  const value = new DataView(digest.buffer).getUint32(0) % 1_000_000;
  const digits = value.toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

// --- Recovery key ---------------------------------------------------------

const RECOVERY_CHECKSUM_BYTES = 3;

/**
 * Formats a 32-byte recovery secret as 56 Crockford base32 characters in
 * hyphenated groups of four: 256 secret bits and a 24-bit SHA-256 checksum
 * that catches typing mistakes before an unlock attempt.
 */
export async function formatRecoveryKey(secret: Uint8Array): Promise<string> {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== KEY_BYTES) {
    throw new E2eeError('invalid-argument', 'Recovery secret must be 32 bytes');
  }
  const checksum = (await sha256(secret)).subarray(0, RECOVERY_CHECKSUM_BYTES);
  const payload = new Uint8Array(KEY_BYTES + RECOVERY_CHECKSUM_BYTES);
  payload.set(secret);
  payload.set(checksum, KEY_BYTES);
  return toBase32(payload).match(/.{4}/g)!.join('-');
}

/** Parses a typed recovery key; spaces, hyphens and case do not matter. */
export async function parseRecoveryKey(text: string): Promise<Bytes> {
  if (typeof text !== 'string') {
    throw new E2eeError('invalid-argument', 'Recovery key must be text');
  }
  const payload = fromBase32(
    text.replace(/[\s-]/g, ''),
    KEY_BYTES + RECOVERY_CHECKSUM_BYTES
  );
  const secret = payload.slice(0, KEY_BYTES);
  const checksum = (await sha256(secret)).subarray(0, RECOVERY_CHECKSUM_BYTES);
  if (!equalBytes(checksum, payload.subarray(KEY_BYTES))) {
    throw new E2eeError('malformed', 'Recovery key checksum does not match');
  }
  return secret;
}

export async function generateRecoveryKey(): Promise<{
  secret: Bytes;
  formatted: string;
}> {
  const secret = systemRandom(KEY_BYTES);
  return { secret, formatted: await formatRecoveryKey(secret) };
}
