/**
 * Leaf certifications (ADR-024, "MLS assessment"): each project's MLS leaf
 * key is certified by the device signing key the identity key certified in
 * the device list. `@openzcad/mls` treats the certification as opaque bytes;
 * this module fixes their form and is the only place that signs or checks
 * them.
 *
 * Form (version 2): `u8 version = 2 | u64 certifiedEpoch (big-endian) |
 * 64-byte r || s`, ECDSA P-256/SHA-256 over the package's
 * `leafCertificationPayload` (label `openzcad mls leaf certification v2`,
 * project id, user id, device id, cipher suite, leaf key, certifiedEpoch).
 * A certification therefore counts only for the project, user, device, key
 * and epoch it names. `certifiedEpoch` is the group's current epoch when the
 * device certifies; the policy lets a recovery Add through only for a key
 * certified at or after the identity's latest leaf removal, so the epoch is
 * signed and travels with the signature in the leaf credential. A server
 * that rewrites it breaks the signature. Version 1 (no epoch) is refused.
 *
 * The device key may be a non-extractable `CryptoKey` or a Keychain-held
 * external key: `ecdsaSign` takes either.
 */
import {
  ecdsaSign,
  importSigningPublicKey,
  type SigningPrivateKey
} from '@openzcad/crypto';
import type { Mls, MlsSession } from '@openzcad/mls';

export const LEAF_CERTIFICATION_VERSION_2 = 2;
const EPOCH_BYTES = 8;
const P1363_SIGNATURE_BYTES = 64;
const LEAF_CERTIFICATION_BYTES = 1 + EPOCH_BYTES + P1363_SIGNATURE_BYTES;

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

const isEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Certify the session's leaf key with this device, from `certifiedEpoch`:
 * the group's current epoch at certification time (0 for a group this leaf
 * is about to create). Installs the certification in the session and
 * returns it; the leaf credential carries it and other members verify it
 * (`verifyLeafCertification`).
 */
export async function certifyLeaf(
  session: MlsSession,
  device: CertifyingDevice,
  certifiedEpoch: number
): Promise<Uint8Array> {
  if (!isEpoch(certifiedEpoch)) {
    throw new Error('A leaf is certified from a group epoch.');
  }
  const status = await session.status();
  if (status.userId !== device.userId || status.deviceId !== device.deviceId) {
    throw new Error('This MLS leaf belongs to a different device.');
  }
  const payload = await session.certificationPayload(certifiedEpoch);
  const rs = await ecdsaSign(device.signing.privateKey, own(payload));
  const certification = new Uint8Array(LEAF_CERTIFICATION_BYTES);
  certification[0] = LEAF_CERTIFICATION_VERSION_2;
  new DataView(certification.buffer).setBigUint64(1, BigInt(certifiedEpoch));
  certification.set(rs, 1 + EPOCH_BYTES);
  await session.certify(certification);
  return certification;
}

/**
 * The epoch a certification claims, unverified; null when it is not a
 * version 2 certification or the epoch is not a safe integer.
 */
export function claimedCertifiedEpoch(
  certification: Uint8Array
): number | null {
  if (
    !(certification instanceof Uint8Array) ||
    certification.length !== LEAF_CERTIFICATION_BYTES ||
    certification[0] !== LEAF_CERTIFICATION_VERSION_2
  ) {
    return null;
  }
  const epoch = new DataView(
    certification.buffer,
    certification.byteOffset,
    certification.byteLength
  ).getBigUint64(1);
  return epoch <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(epoch) : null;
}

export interface LeafCertificationClaim {
  readonly projectId: string;
  readonly userId: string;
  readonly deviceId: string;
  /** The per-project leaf signing key (P-256, SEC1 uncompressed). */
  readonly leafKey: Uint8Array;
  readonly certification: Uint8Array;
}

export interface VerifiedLeafCertification {
  /** The epoch the certifying device signed: the certification counts from it. */
  readonly certifiedEpoch: number;
}

/**
 * Checks that `claim.certification` is the device key's signature over
 * exactly this project, user, device and leaf key and the epoch it claims,
 * and returns that epoch. Null for anything else, malformed input included,
 * never an exception, so one bad record cannot be mistaken for a transport
 * error.
 */
export async function verifyLeafCertification(
  mls: Mls,
  claim: LeafCertificationClaim,
  deviceSigningKey: Uint8Array
): Promise<VerifiedLeafCertification | null> {
  const { certification, leafKey } = claim;
  const certifiedEpoch = claimedCertifiedEpoch(certification);
  if (
    certifiedEpoch === null ||
    !(leafKey instanceof Uint8Array) ||
    leafKey.length !== 65 ||
    leafKey[0] !== 0x04
  ) {
    return null;
  }
  let payload: Uint8Array;
  let key: CryptoKey;
  try {
    payload = await mls.leafCertificationPayload(
      claim.projectId,
      claim.userId,
      claim.deviceId,
      leafKey,
      certifiedEpoch
    );
    key = await importSigningPublicKey(deviceSigningKey);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    own(certification.subarray(1 + EPOCH_BYTES)),
    own(payload)
  );
  return valid ? { certifiedEpoch } : null;
}
