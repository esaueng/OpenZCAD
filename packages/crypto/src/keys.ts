import { asBytes, type Bytes } from './bytes';
import { E2eeError } from './errors';
import { KEY_BYTES, subtle, systemRandom } from './primitives';

/** Uncompressed SEC1 P-256 point: 0x04, X, Y. */
export const P256_PUBLIC_KEY_BYTES = 65;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/**
 * ECDH P-256 pair for receiving project keys; its public half is certified
 * in the device list and its private half wrapped by the account key
 * (`encryption-private-key`). Pass `extractable: false` for a
 * device-approval pair that never needs to be wrapped.
 */
export async function generateEncryptionKeyPair(
  extractable = true
): Promise<CryptoKeyPair> {
  return subtle().generateKey(ECDH, extractable, ['deriveBits']);
}

/**
 * The long-term identity key: ECDSA P-256, extractable so it can be wrapped
 * under the recovery key and passkeys (`identity-key`). It signs only
 * device-list entries; its hash is the fingerprint other people verify.
 */
export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(ECDSA, true, ['sign', 'verify']);
}

/**
 * A per-device signing key: ECDSA P-256, non-extractable by default because
 * it never leaves its device. Certified by the identity key in the device
 * list, it signs versions, roster entries and share snapshots.
 */
export async function generateDeviceSigningKeyPair(
  extractable = false
): Promise<CryptoKeyPair> {
  return subtle().generateKey(ECDSA, extractable, ['sign', 'verify']);
}

/** The raw 65-byte public key, as published and fingerprinted. */
export async function exportPublicKey(key: CryptoKey): Promise<Bytes> {
  if (key.type !== 'public') {
    throw new E2eeError('invalid-argument', 'Expected a public key');
  }
  return new Uint8Array(await subtle().exportKey('raw', key));
}

async function importPublic(
  raw: Uint8Array,
  algorithm: typeof ECDH | typeof ECDSA,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  if (raw.byteLength !== P256_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new E2eeError(
      'malformed',
      'Expected a 65-byte uncompressed P-256 key'
    );
  }
  try {
    return await subtle().importKey(
      'raw',
      asBytes(raw),
      algorithm,
      true,
      usages
    );
  } catch (cause) {
    throw new E2eeError('malformed', 'Public key is not a P-256 point', {
      cause
    });
  }
}

export async function importEncryptionPublicKey(
  raw: Uint8Array
): Promise<CryptoKey> {
  return importPublic(raw, ECDH, []);
}

export async function importSigningPublicKey(
  raw: Uint8Array
): Promise<CryptoKey> {
  return importPublic(raw, ECDSA, ['verify']);
}

/** PKCS #8 bytes of a private key, for wrapping under the account key. */
export async function exportPrivateKey(key: CryptoKey): Promise<Bytes> {
  if (key.type !== 'private' || !key.extractable) {
    throw new E2eeError(
      'invalid-argument',
      'Expected an extractable private key'
    );
  }
  return new Uint8Array(await subtle().exportKey('pkcs8', key));
}

async function importPrivate(
  pkcs8: Uint8Array,
  algorithm: typeof ECDH | typeof ECDSA,
  usages: KeyUsage[],
  extractable: boolean
): Promise<CryptoKey> {
  try {
    return await subtle().importKey(
      'pkcs8',
      asBytes(pkcs8),
      algorithm,
      extractable,
      usages
    );
  } catch (cause) {
    throw new E2eeError('malformed', 'Private key is not P-256 PKCS #8', {
      cause
    });
  }
}

export async function importEncryptionPrivateKey(
  pkcs8: Uint8Array,
  extractable = false
): Promise<CryptoKey> {
  return importPrivate(pkcs8, ECDH, ['deriveBits'], extractable);
}

export async function importSigningPrivateKey(
  pkcs8: Uint8Array,
  extractable = false
): Promise<CryptoKey> {
  return importPrivate(pkcs8, ECDSA, ['sign'], extractable);
}

export async function toEncryptionPublicKey(
  key: Uint8Array | CryptoKey
): Promise<{
  key: CryptoKey;
  raw: Bytes;
}> {
  if (key instanceof Uint8Array) {
    return { key: await importEncryptionPublicKey(key), raw: asBytes(key) };
  }
  if (key.algorithm.name !== 'ECDH' || key.type !== 'public') {
    throw new E2eeError('invalid-argument', 'Expected an ECDH public key');
  }
  return { key, raw: await exportPublicKey(key) };
}

/**
 * Unlock secrets (a device key, a passkey PRF output or a recovery key)
 * become non-extractable HKDF keys, the KEK input for the account key.
 */
export async function importUnlockSecret(
  secret: Uint8Array
): Promise<CryptoKey> {
  if (secret.byteLength !== KEY_BYTES) {
    throw new E2eeError('invalid-argument', 'Unlock secret must be 32 bytes');
  }
  return subtle().importKey('raw', asBytes(secret), 'HKDF', false, [
    'deriveKey',
    'deriveBits'
  ]);
}

/**
 * A fresh device unlock key. It is non-extractable: IndexedDB can store it
 * (structured clone keeps CryptoKeys), but script can never read its bytes.
 */
export async function generateDeviceUnlockKey(): Promise<CryptoKey> {
  const secret = systemRandom(KEY_BYTES);
  const key = await importUnlockSecret(secret);
  secret.fill(0);
  return key;
}

/**
 * The first WebAuthn PRF input for passkey unlock. Fixed, so a passkey
 * always yields the same 32-byte secret for this application.
 */
export const PASSKEY_PRF_INPUT: Bytes = new TextEncoder().encode(
  'OpenZCAD E2EE v1 passkey unlock'
);
