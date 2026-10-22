/**
 * Sealed session state for IndexedDB. The exported MLS state holds the leaf
 * signing key and every group secret, so it only leaves the Worker sealed
 * with AES-256-GCM under a caller-supplied non-extractable key.
 *
 * Format: "OZMS" | version 0x01 | 12-byte IV | ciphertext+tag. The AAD is
 * that 5-byte header followed by "openzcad mls session\0" and the project id,
 * so a blob opens only for the project it was sealed for.
 */
import { MlsError } from './errors';

const MAGIC = new Uint8Array([0x4f, 0x5a, 0x4d, 0x53]); // "OZMS"
const VERSION = 1;
const IV_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 1;
const AAD_LABEL = 'openzcad mls session\0';
const encoder = new TextEncoder();

/** WebCrypto takes only ArrayBuffer-backed views. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

function aad(projectId: string): Uint8Array<ArrayBuffer> {
  const label = encoder.encode(AAD_LABEL + projectId);
  const out = new Uint8Array(HEADER_BYTES + label.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(label, HEADER_BYTES);
  return out;
}

/** Refuse anything but a non-extractable AES-256-GCM key that can seal. */
export function assertStateKey(key: CryptoKey): void {
  const algorithm = key.algorithm as Partial<AesKeyAlgorithm>;
  if (
    key.type !== 'secret' ||
    algorithm.name !== 'AES-GCM' ||
    algorithm.length !== 256
  ) {
    throw new MlsError('input', 'the state key must be an AES-256-GCM key');
  }
  if (key.extractable) {
    throw new MlsError('input', 'the state key must be non-extractable');
  }
  if (!key.usages.includes('encrypt') || !key.usages.includes('decrypt')) {
    throw new MlsError('input', 'the state key must allow encrypt and decrypt');
  }
}

/** A fresh non-extractable state key, for callers that do not have one. */
export function generateStateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
}

export async function sealState(
  key: CryptoKey,
  projectId: string,
  state: Uint8Array
): Promise<Uint8Array> {
  assertStateKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(projectId) },
      key,
      own(state)
    )
  );
  const out = new Uint8Array(HEADER_BYTES + IV_BYTES + ciphertext.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(iv, HEADER_BYTES);
  out.set(ciphertext, HEADER_BYTES + IV_BYTES);
  return out;
}

export async function openState(
  key: CryptoKey,
  projectId: string,
  sealed: Uint8Array
): Promise<Uint8Array> {
  assertStateKey(key);
  if (
    sealed.length < HEADER_BYTES + IV_BYTES + 16 ||
    !MAGIC.every((b, i) => sealed[i] === b)
  ) {
    throw new MlsError('state', 'not a sealed MLS session');
  }
  if (sealed[MAGIC.length] !== VERSION) {
    throw new MlsError(
      'state',
      `sealed MLS session version ${sealed[MAGIC.length]} is not supported`
    );
  }
  const iv = sealed.slice(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad(projectId) },
        key,
        own(sealed.subarray(HEADER_BYTES + IV_BYTES))
      )
    );
  } catch {
    throw new MlsError(
      'state',
      'the sealed MLS session does not open with this key and project'
    );
  }
}
