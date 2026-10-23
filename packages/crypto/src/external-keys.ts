import { subtle } from './primitives';
import { E2eeError } from './errors';
import { isP256Key } from './keys';
import type { Bytes } from './bytes';

/**
 * P-256 private keys held outside WebCrypto. On desktop the device signing
 * and unlock keys live in the macOS Keychain and the native host signs and
 * derives with them, so their bytes never reach script (ADR-024, Unlock and
 * devices). Browsers keep non-extractable `CryptoKey`s; every function that
 * uses a device private key takes either form.
 */
export interface ExternalSigningKey {
  readonly external: 'ecdsa-p256-sha256';
  /** ECDSA P-256 over SHA-256(message), as the 64-byte IEEE P1363 r || s. */
  sign(message: Bytes): Promise<Bytes>;
}

export interface ExternalAgreementKey {
  readonly external: 'ecdh-p256';
  /**
   * The 32-byte ECDH shared secret (the x-coordinate) with the 65-byte
   * uncompressed P-256 public key `peer`, as WebCrypto's `deriveBits` returns.
   */
  deriveBits(peer: Bytes): Promise<Bytes>;
}

export type SigningPrivateKey = CryptoKey | ExternalSigningKey;
export type AgreementPrivateKey = CryptoKey | ExternalAgreementKey;

const P1363_SIGNATURE_BYTES = 64;
const ECDH_SECRET_BYTES = 32;

export function isExternalSigningKey(key: unknown): key is ExternalSigningKey {
  const k = key as Partial<ExternalSigningKey> | null | undefined;
  return k?.external === 'ecdsa-p256-sha256' && typeof k.sign === 'function';
}

export function isExternalAgreementKey(
  key: unknown
): key is ExternalAgreementKey {
  const k = key as Partial<ExternalAgreementKey> | null | undefined;
  return k?.external === 'ecdh-p256' && typeof k.deriveBits === 'function';
}

/** True for a key `ecdsaSign` accepts, without signing anything. */
export function isSigningPrivateKey(key: unknown): key is SigningPrivateKey {
  return (
    isExternalSigningKey(key) ||
    (isP256Key(key, 'ECDSA', 'private') &&
      Boolean(key.usages?.includes('sign')))
  );
}

/** True for a key `ecdhDeriveBits` accepts, without deriving anything. */
export function isAgreementPrivateKey(
  key: unknown
): key is AgreementPrivateKey {
  return isExternalAgreementKey(key) || isP256Key(key, 'ECDH', 'private');
}

/**
 * Signs `message` with ECDSA P-256/SHA-256 and returns r || s. An external
 * signer's output is length-checked, so a broken host cannot hand back
 * something that only fails much later at a verifier.
 */
export async function ecdsaSign(
  key: SigningPrivateKey,
  message: Bytes
): Promise<Bytes> {
  if (!isSigningPrivateKey(key)) {
    throw new E2eeError(
      'invalid-argument',
      'Expected a P-256 ECDSA private key with the sign usage'
    );
  }
  let rs: Uint8Array;
  try {
    rs = isExternalSigningKey(key)
      ? await key.sign(new Uint8Array(message))
      : new Uint8Array(
          await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message)
        );
  } catch (cause) {
    throw new E2eeError('invalid-argument', 'The signing key cannot sign', {
      cause
    });
  }
  if (!(rs instanceof Uint8Array) || rs.byteLength !== P1363_SIGNATURE_BYTES) {
    throw new E2eeError(
      'invalid-argument',
      'The signing key returned a malformed signature'
    );
  }
  return new Uint8Array(rs);
}

/**
 * The 32-byte ECDH secret between `key` and the peer. `peer` is the peer's
 * imported public key and `peerRaw` its 65-byte encoding; a `CryptoKey`
 * derives with the first, an external key with the second.
 */
export async function ecdhDeriveBits(
  key: AgreementPrivateKey,
  peer: CryptoKey,
  peerRaw: Bytes
): Promise<Bytes> {
  if (!isAgreementPrivateKey(key)) {
    throw new E2eeError(
      'invalid-argument',
      'Expected a P-256 ECDH private key'
    );
  }
  const secret = isExternalAgreementKey(key)
    ? await key.deriveBits(new Uint8Array(peerRaw))
    : new Uint8Array(
        await subtle().deriveBits(
          { name: 'ECDH', public: peer },
          key,
          ECDH_SECRET_BYTES * 8
        )
      );
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength !== ECDH_SECRET_BYTES
  ) {
    throw new E2eeError(
      'invalid-argument',
      'The agreement key returned a malformed secret'
    );
  }
  return new Uint8Array(secret);
}
