/**
 * Leaf certifications (ADR-024, "MLS assessment"): each project's MLS leaf
 * key is certified by the device signing key the identity key certified in
 * the device list. `@openzcad/mls` treats the certification as opaque bytes;
 * this module fixes their form and is the only place that signs or checks
 * them.
 *
 * Form: `u8 version = 1 | 64-byte r || s`, ECDSA P-256/SHA-256 over the
 * package's `leafCertificationPayload` (label, project id, user id, device
 * id, cipher suite, leaf key), so a certification counts only for the
 * project, user, device and key it names. The device key may be a
 * non-extractable `CryptoKey` or a Keychain-held external key: `ecdsaSign`
 * takes either.
 */
import {
  ecdsaSign,
  importSigningPublicKey,
  type SigningPrivateKey
} from '@openzcad/crypto';
import type { Mls, MlsSession } from '@openzcad/mls';

export const LEAF_CERTIFICATION_VERSION_1 = 1;
const P1363_SIGNATURE_BYTES = 64;
const LEAF_CERTIFICATION_BYTES = 1 + P1363_SIGNATURE_BYTES;

/** The device whose signing key certifies the leaf (a `StoredDevice` fits). */
export interface CertifyingDevice {
  readonly userId: string;
  readonly deviceId: string;
  readonly signing: { readonly privateKey: SigningPrivateKey };
}

/** WebCrypto takes only ArrayBuffer-backed views. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/**
 * Certify the session's leaf key with this device and install the
 * certification in the session. Returns the certification, which the leaf
 * credential carries and other members verify (`verifyLeafCertification`).
 */
export async function certifyLeaf(
  session: MlsSession,
  device: CertifyingDevice
): Promise<Uint8Array> {
  const status = await session.status();
  if (status.userId !== device.userId || status.deviceId !== device.deviceId) {
    throw new Error('This MLS leaf belongs to a different device.');
  }
  const payload = await session.certificationPayload();
  const rs = await ecdsaSign(device.signing.privateKey, own(payload));
  const certification = new Uint8Array(LEAF_CERTIFICATION_BYTES);
  certification[0] = LEAF_CERTIFICATION_VERSION_1;
  certification.set(rs, 1);
  await session.certify(certification);
  return certification;
}

export interface LeafCertificationClaim {
  readonly projectId: string;
  readonly userId: string;
  readonly deviceId: string;
  /** The per-project leaf signing key (P-256, SEC1 uncompressed). */
  readonly leafKey: Uint8Array;
  readonly certification: Uint8Array;
}

/**
 * Whether `claim.certification` is the device key's signature over exactly
 * this project, user, device and leaf key. Malformed input is false, never
 * an exception, so one bad record cannot be mistaken for a transport error.
 */
export async function verifyLeafCertification(
  mls: Mls,
  claim: LeafCertificationClaim,
  deviceSigningKey: Uint8Array
): Promise<boolean> {
  const { certification, leafKey } = claim;
  if (
    !(certification instanceof Uint8Array) ||
    certification.length !== LEAF_CERTIFICATION_BYTES ||
    certification[0] !== LEAF_CERTIFICATION_VERSION_1 ||
    !(leafKey instanceof Uint8Array) ||
    leafKey.length !== 65 ||
    leafKey[0] !== 0x04
  ) {
    return false;
  }
  let payload: Uint8Array;
  let key: CryptoKey;
  try {
    payload = await mls.leafCertificationPayload(
      claim.projectId,
      claim.userId,
      claim.deviceId,
      leafKey
    );
    key = await importSigningPublicKey(deviceSigningKey);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    own(certification.subarray(1)),
    own(payload)
  );
}
