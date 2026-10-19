import { asBytes, type Bytes } from './bytes';
import { E2eeError } from './errors';

export const KEY_BYTES = 32;
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

/** Fills `length` random bytes. Tests inject a deterministic source. */
export type RandomSource = (length: number) => Bytes;

export const systemRandom: RandomSource = (length) => {
  const out = new Uint8Array(length);
  webCrypto().getRandomValues(out);
  return out;
};

/** A fresh random 256-bit key: account, project, blob or share key. */
export function generateSymmetricKey(): Bytes {
  return systemRandom(KEY_BYTES);
}

function webCrypto(): Crypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) {
    throw new E2eeError(
      'unavailable',
      'WebCrypto is not available here (it needs a secure context)'
    );
  }
  return crypto;
}

export function subtle(): SubtleCrypto {
  return webCrypto().subtle;
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', asBytes(data)));
}

/**
 * Secret input to HKDF: 32 raw bytes, or an HKDF `CryptoKey` so a
 * non-extractable device key stored in IndexedDB never leaves WebCrypto.
 */
export type KeyMaterial = Uint8Array | CryptoKey;

export async function hkdfBaseKey(
  material: KeyMaterial,
  what: string
): Promise<CryptoKey> {
  if (material instanceof Uint8Array) {
    if (material.byteLength !== KEY_BYTES) {
      throw new E2eeError('invalid-argument', `${what} must be 32 bytes`);
    }
    return subtle().importKey('raw', asBytes(material), 'HKDF', false, [
      'deriveKey',
      'deriveBits'
    ]);
  }
  if (material.algorithm.name !== 'HKDF') {
    throw new E2eeError('invalid-argument', `${what} must be an HKDF key`);
  }
  return material;
}

/** Imports any-length input keying material (an ECDH secret) for HKDF. */
export async function importHkdfInput(ikm: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', asBytes(ikm), 'HKDF', false, [
    'deriveKey',
    'deriveBits'
  ]);
}

export async function deriveAesGcmKey(
  base: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array
): Promise<CryptoKey> {
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBytes(salt), info: asBytes(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Promise<Bytes> {
  return new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: asBytes(iv), additionalData: asBytes(aad) },
      key,
      asBytes(plaintext)
    )
  );
}

/** AES-GCM decrypt; any refusal is reported as `authentication-failed`. */
export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  what: string
): Promise<Bytes> {
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: asBytes(iv), additionalData: asBytes(aad) },
        key,
        asBytes(ciphertext)
      )
    );
  } catch (cause) {
    throw new E2eeError(
      'authentication-failed',
      `${what} failed authentication: wrong key, wrong context or altered bytes`,
      { cause }
    );
  }
}
