import {
  ByteReader,
  ByteWriter,
  asBytes,
  copyBytes,
  equalBytes,
  isUint,
  label,
  snapshotBytes,
  type Bytes
} from './bytes';
import { parseEnvelope } from './envelope';
import { E2eeError } from './errors';
import { HASH_BYTES, type ProjectEnvelopeHeader } from './header';
import { importSigningPublicKey, isP256Key } from './keys';
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
 * header is signed as such), the version hash and the author's timestamp.
 * The version hash is SHA-256 over the serialized prefix followed by every
 * chunk's ciphertext and tag, i.e. the whole envelope. Signing the header
 * alone would not do: any member holding the symmetric key can re-encrypt
 * altered content under the same header with valid tags. Project envelopes
 * are bounded (24 MiB) and complete in memory when signed, so WebCrypto's
 * one-shot SHA-256 computes this hash; content blobs are not signed but
 * committed to by their reference's ciphertext hash.
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
  // Without the sign usage `subtle.sign` throws a native error.
  if (
    !isP256Key(privateKey, 'ECDSA', 'private') ||
    !privateKey.usages?.includes('sign')
  ) {
    throw new E2eeError(
      'invalid-argument',
      'Expected a P-256 ECDSA private key with the sign usage'
    );
  }
  if (!isUint(signedAt, Number.MAX_SAFE_INTEGER)) {
    throw new E2eeError(
      'invalid-argument',
      'signedAt must be Unix milliseconds'
    );
  }
  const statement = await versionStatement(envelope, signedAt);
  let rs: Bytes;
  try {
    rs = new Uint8Array(
      await subtle().sign(ECDSA_SHA256, privateKey, statement)
    );
  } catch (cause) {
    // Only an object that merely looks like a P-256 signing key gets here;
    // keep the failure an E2eeError like every other one.
    throw new E2eeError('invalid-argument', 'The signing key cannot sign', {
      cause
    });
  }
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
  // r‖s is read after awaits below; read it from a copy.
  signature = copyBytes(signature);
  const reader = new ByteReader(signature, 'Signature');
  reader.u8();
  const signedAt = reader.u64();
  const rs = reader.bytes(64);
  // Build the statement before anything is awaited: parsing and the digest
  // call both read the envelope now, so what is verified is what was passed.
  const statement = versionStatement(envelope, signedAt);
  statement.catch(() => undefined);
  const key =
    publicKey instanceof Uint8Array
      ? await importSigningPublicKey(publicKey)
      : publicKey;
  // Without the verify usage `subtle.verify` throws, which the catch below
  // would report as a bad signature rather than an unusable key.
  if (!isP256Key(key, 'ECDSA', 'public') || !key.usages?.includes('verify')) {
    throw new E2eeError(
      'invalid-argument',
      'Expected a P-256 ECDSA public key with the verify usage'
    );
  }
  const message = await statement;
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
 * Most a single `verifyVersionChain` call takes. The call copies the
 * history it is given, so a longer one is checked in overlapping windows:
 * pin the newest hash of one window and pass it with the next.
 */
export const MAX_CHAIN_ENVELOPES = 1024;
export const MAX_CHAIN_BYTES = 256 * 1024 * 1024;

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
  // Bound the history before copying any of it.
  if (envelopes.length > MAX_CHAIN_ENVELOPES) {
    throw new E2eeError(
      'limit-exceeded',
      `Check at most ${MAX_CHAIN_ENVELOPES} versions at a time`
    );
  }
  let total = 0;
  for (const envelope of envelopes) {
    if (!(envelope instanceof Uint8Array)) {
      throw new E2eeError('invalid-argument', 'Envelopes must be Uint8Arrays');
    }
    total += envelope.byteLength;
  }
  if (total > MAX_CHAIN_BYTES) {
    throw new E2eeError(
      'limit-exceeded',
      `Check at most ${MAX_CHAIN_BYTES} bytes of history at a time`
    );
  }
  const pinned =
    options.pinnedVersionHash === undefined
      ? undefined
      : snapshotBytes(
          options.pinnedVersionHash,
          'pinnedVersionHash',
          HASH_BYTES
        );
  // Capture every envelope before the first await (headers decode into
  // copies; the bodies are copied, within the bound above), so a caller
  // editing the list or a buffer meanwhile cannot change the chain
  // checked. Hash them one at a time, releasing each copy once hashed:
  // concurrent digests would each hold another, and a broken link stops
  // the work early.
  const captured: { header: ProjectEnvelopeHeader; bytes: Bytes | null }[] =
    envelopes.map((envelope) => ({
      header: projectHeaderOf(envelope).header,
      bytes: copyBytes(envelope)
    }));
  const hashes: Bytes[] = [];
  let previous: ProjectEnvelopeHeader | null = null;
  for (const entry of captured) {
    const { header } = entry;
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
    const bytes = entry.bytes!;
    entry.bytes = null;
    hashes.push(await versionHash(bytes));
  }
  if (pinned && !hashes.some((hash) => equalBytes(hash, pinned))) {
    throw new E2eeError(
      'chain-broken',
      'History does not contain the newest version this browser has seen'
    );
  }
  return hashes;
}
