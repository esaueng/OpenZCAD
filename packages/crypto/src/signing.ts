import {
  ByteReader,
  ByteWriter,
  asBytes,
  equalBytes,
  isUint,
  label,
  type Bytes
} from './bytes';
import { parseEnvelope } from './envelope';
import { E2eeError } from './errors';
import type { ProjectEnvelopeHeader } from './header';
import { importSigningPublicKey } from './keys';
import { sha256, subtle } from './primitives';

/**
 * Version signatures and the version hash chain. Which keys may sign (device
 * lists, rosters) is key management, which is being reassessed (MLS); this
 * module only signs and verifies with a key the caller supplies.
 */

/** ECDSA P-256 with SHA-256; the signature is IEEE P1363 `r || s`. */
export const SIGNATURE_VERSION_1 = 1;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const SIGNATURE_BYTES = 1 + 8 + 64;

/**
 * The version hash: SHA-256 of a whole project envelope. The next version
 * names it as `previousVersionHash`, which chains a project's history.
 */
export async function versionHash(envelope: Uint8Array): Promise<Bytes> {
  return sha256(envelope);
}

function projectHeaderOf(envelope: Uint8Array): {
  prefix: Bytes;
  header: ProjectEnvelopeHeader;
} {
  const { prefix, header } = parseEnvelope(envelope);
  if (header.class !== 'project') {
    throw new E2eeError(
      'invalid-argument',
      'Only project envelopes are signed; content blobs are authenticated by reference'
    );
  }
  return { prefix, header };
}

/**
 * What an author signs: a label, the envelope prefix (so the plaintext
 * header is signed as such), the version hash (so is everything else) and
 * the author's timestamp.
 */
async function versionStatement(
  envelope: Uint8Array,
  signedAt: number
): Promise<Bytes> {
  const { prefix } = projectHeaderOf(envelope);
  return new ByteWriter()
    .bytes(label('v1 version signature'))
    .u32(prefix.byteLength)
    .bytes(prefix)
    .bytes(await versionHash(envelope))
    .u64(signedAt)
    .finish();
}

/**
 * Signs a project envelope (a version, checkpoint, merged version or share
 * snapshot). Output: `u8 version | u64 signedAt (Unix ms) | 64-byte r || s`.
 */
export async function signProjectEnvelope(
  privateKey: CryptoKey,
  envelope: Uint8Array,
  signedAt: number = Date.now()
): Promise<Bytes> {
  if (
    privateKey?.algorithm?.name !== 'ECDSA' ||
    privateKey.type !== 'private'
  ) {
    throw new E2eeError('invalid-argument', 'Expected an ECDSA private key');
  }
  if (!isUint(signedAt, Number.MAX_SAFE_INTEGER)) {
    throw new E2eeError(
      'invalid-argument',
      'signedAt must be Unix milliseconds'
    );
  }
  const rs = new Uint8Array(
    await subtle().sign(
      ECDSA_SHA256,
      privateKey,
      await versionStatement(envelope, signedAt)
    )
  );
  return new ByteWriter()
    .u8(SIGNATURE_VERSION_1)
    .u64(signedAt)
    .bytes(rs)
    .finish();
}

export interface VerifiedVersionSignature {
  /** The author's signed timestamp, Unix milliseconds. */
  readonly signedAt: number;
}

/**
 * The signed timestamp when `signature` is by `publicKey` over exactly
 * this envelope, otherwise null. Throws for a malformed signature or
 * envelope, or an unknown version.
 */
export async function verifyProjectEnvelopeSignature(
  publicKey: Uint8Array | CryptoKey,
  envelope: Uint8Array,
  signature: Uint8Array
): Promise<VerifiedVersionSignature | null> {
  if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
    throw new E2eeError('malformed', 'Signature is empty');
  }
  if (signature[0] !== SIGNATURE_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Signature version ${signature[0]} is not supported`
    );
  }
  if (signature.byteLength !== SIGNATURE_BYTES) {
    throw new E2eeError('malformed', 'Signature has the wrong length');
  }
  const reader = new ByteReader(signature, 'Signature');
  reader.u8();
  const signedAt = reader.u64();
  const rs = reader.bytes(64);
  const key =
    publicKey instanceof Uint8Array
      ? await importSigningPublicKey(publicKey)
      : publicKey;
  if (key?.algorithm?.name !== 'ECDSA' || key.type !== 'public') {
    throw new E2eeError('invalid-argument', 'Expected an ECDSA public key');
  }
  const message = await versionStatement(envelope, signedAt);
  let valid: boolean;
  try {
    valid = await subtle().verify(ECDSA_SHA256, key, asBytes(rs), message);
  } catch {
    // Engines differ on out-of-range r or s: Node returns false, others may
    // throw. Either way the signature is not valid.
    valid = false;
  }
  return valid ? { signedAt } : null;
}

/**
 * Checks that project envelopes, oldest first, form one unbroken history:
 * each names the previous one's version hash, versions increase, and the
 * project never changes. With `pinnedVersionHash` (the newest version this
 * browser has seen), the chain must contain it, so a rolled-back or forked
 * history fails (`chain-broken`). Headers are not authenticated here;
 * decrypt and verify signatures separately.
 */
export async function verifyVersionChain(
  envelopes: readonly Uint8Array[],
  options: { readonly pinnedVersionHash?: Uint8Array } = {}
): Promise<Bytes[]> {
  if (envelopes.length === 0) {
    throw new E2eeError('chain-broken', 'Version history is empty');
  }
  const hashes: Bytes[] = [];
  let previous: ProjectEnvelopeHeader | null = null;
  for (const envelope of envelopes) {
    const { header } = projectHeaderOf(envelope);
    const before = hashes.at(-1);
    if (
      previous &&
      before &&
      (header.projectId !== previous.projectId ||
        header.documentVersion <= previous.documentVersion ||
        header.previousVersionHash === null ||
        !equalBytes(header.previousVersionHash, before))
    ) {
      throw new E2eeError(
        'chain-broken',
        `Version ${header.documentVersion} does not follow version ${previous.documentVersion}`
      );
    }
    previous = header;
    hashes.push(await versionHash(envelope));
  }
  const pinned = options.pinnedVersionHash;
  if (pinned && !hashes.some((hash) => equalBytes(hash, pinned))) {
    throw new E2eeError(
      'chain-broken',
      'History does not contain the newest version this browser has seen'
    );
  }
  return hashes;
}
