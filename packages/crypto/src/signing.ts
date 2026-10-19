import { ByteWriter, equalBytes, type Bytes } from './bytes';
import {
  checkChain,
  checkCurrentHead,
  checkHistoricalRead,
  type HeadAdvance
} from './chain';
import {
  signWithDevice,
  verifyDeviceSignature,
  type AncestryLookup,
  type DeviceSigner,
  type VerifiedDeviceList,
  type VerifiedDeviceSignature
} from './devices';
import { parseEnvelope } from './envelope';
import { E2eeError } from './errors';
import type { ProjectEnvelopeHeader } from './header';
import { sha256 } from './primitives';

// --- Version signatures ---------------------------------------------------

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

/** The prefix (so the plaintext header is signed as such) and the version hash. */
async function versionSubject(envelope: Uint8Array): Promise<Bytes> {
  const { prefix } = projectHeaderOf(envelope);
  return new ByteWriter()
    .u32(prefix.byteLength)
    .bytes(prefix)
    .bytes(await versionHash(envelope))
    .finish();
}

/**
 * Signs a project envelope (a version, checkpoint, merged version or share
 * snapshot) with the author's certified device key.
 */
export async function signProjectEnvelope(
  signer: DeviceSigner,
  envelope: Uint8Array,
  signedAt: number = Date.now()
): Promise<Bytes> {
  return signWithDevice(
    signer,
    'version',
    await versionSubject(envelope),
    signedAt
  );
}

export interface VersionSignatureOptions {
  /**
   * The project's version ancestry. Needed only when the signing device
   * has since been revoked: then the version must be the revocation's
   * cutoff head for this project or one of its ancestors.
   */
  readonly isAncestorOrSelf?: AncestryLookup;
}

/**
 * Who signed a project envelope, checked against the signer's device list
 * (read the user id first with `readDeviceSignature`). Null for an invalid
 * signature; see `verifyDeviceSignature` for the typed refusals. A revoked
 * device's signature is accepted only within its revocation cutoff.
 */
export async function verifyProjectEnvelopeSignature(
  signerDevices: VerifiedDeviceList,
  envelope: Uint8Array,
  signature: Uint8Array,
  options: VersionSignatureOptions = {}
): Promise<VerifiedDeviceSignature | null> {
  const { header } = projectHeaderOf(envelope);
  const lookup = options.isAncestorOrSelf;
  return verifyDeviceSignature(
    signerDevices,
    'version',
    await versionSubject(envelope),
    signature,
    lookup
      ? {
          cutoff: {
            projectId: header.projectId,
            head: 'version',
            hash: await versionHash(envelope),
            isAncestorOrSelf: lookup
          }
        }
      : {}
  );
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
  if (hashes.length === 0) {
    throw new E2eeError('chain-broken', 'Version history is empty');
  }
  // Version numbers need not be consecutive, so only the pin rule is shared.
  checkChain(
    'Version history',
    hashes.map((hash, sequence) => ({
      sequence,
      previousEntryHash: sequence === 0 ? null : hashes[sequence - 1]!,
      hash
    })),
    { pinnedEntryHash: options.pinnedVersionHash, fromGenesis: false }
  );
  return hashes;
}

/**
 * Current-head mode for versions: `envelopes`, oldest first, run from (at
 * or before) the pinned version to the candidate head, the last one. The
 * head must descend from the pin; accepting it moves the pin to the head.
 */
export async function acceptCurrentVersion(
  envelopes: readonly Uint8Array[],
  options: { readonly pinnedVersionHash?: Uint8Array } = {}
): Promise<HeadAdvance> {
  const hashes = await verifyVersionChain(envelopes, options);
  return checkCurrentHead(
    'Version history',
    hashes.map((hash, sequence) => ({
      sequence,
      previousEntryHash: sequence === 0 ? null : hashes[sequence - 1]!,
      hash
    })),
    options.pinnedVersionHash
  );
}

export interface HistoricalVersion {
  readonly header: ProjectEnvelopeHeader;
  readonly versionHash: Bytes;
}

/**
 * Historical mode for versions (opening a retained revision or named
 * checkpoint): `walk` runs newest first from the pinned version back to the
 * one being read, each naming the next as its previous version. Proves the
 * last one is the pin or an ancestor of it; the pin does not move. Check it
 * against the roster entry its header names (`historicalRosterState`), with
 * the author's current device list so later revocation cutoffs apply.
 */
export async function acceptHistoricalVersion(
  walk: readonly Uint8Array[],
  pinnedVersionHash: Uint8Array
): Promise<HistoricalVersion> {
  const steps = await Promise.all(
    walk.map(async (envelope) => ({
      header: projectHeaderOf(envelope).header,
      hash: await versionHash(envelope)
    }))
  );
  steps.forEach((step, i) => {
    const older = steps[i + 1];
    if (
      older &&
      (older.header.projectId !== step.header.projectId ||
        older.header.documentVersion >= step.header.documentVersion)
    ) {
      throw new E2eeError(
        'chain-broken',
        'Version history: the walk back changes project or does not go back'
      );
    }
  });
  checkHistoricalRead(
    'Version history',
    steps.map(({ header, hash }) => ({
      hash,
      previousEntryHash: header.previousVersionHash
    })),
    pinnedVersionHash
  );
  const target = steps.at(-1)!;
  return { header: target.header, versionHash: target.hash };
}
