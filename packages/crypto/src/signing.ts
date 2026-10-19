import {
  ByteReader,
  ByteWriter,
  copyBytes,
  equalBytes,
  isUint,
  type Bytes
} from './bytes';
import { chainEntryHash, checkChain, type ChainOptions } from './chain';
import {
  readDeviceSignature,
  signWithDevice,
  verifyDeviceSignature,
  type AncestryLookup,
  type DeviceSignatureInfo,
  type DeviceSigner,
  type VerifiedDeviceList,
  type VerifiedDeviceSignature
} from './devices';
import { parseEnvelope } from './envelope';
import { sha256 } from './primitives';
import { E2eeError } from './errors';
import { HASH_BYTES, isEnvelopeId, type ProjectEnvelopeHeader } from './header';

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

// --- Signed roster --------------------------------------------------------

export const ROSTER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

export interface RosterMember {
  readonly userId: string;
  /** `publicKeyHash` of the member's verified identity key. */
  readonly identityKeyHash: Uint8Array;
  readonly role: RosterRole;
}

/** The new epoch's project key, sealed to one member's encryption key. */
export interface RosterKeyWrap {
  readonly userId: string;
  /** `sealKey` output with a `project-key` context. */
  readonly sealedKey: Uint8Array;
}

/**
 * One roster entry. A membership entry (owner) changes the member list; an
 * epoch entry (any member) keeps it and moves `keyEpoch` up by one. Any
 * entry that starts an epoch, and the first entry, carries exactly one key
 * wrap per member; other entries carry none.
 */
export interface RosterEntry {
  readonly projectId: string;
  /** 0 for the first entry, then +1 per entry. */
  readonly sequence: number;
  readonly keyEpoch: number;
  /** `rosterEntryHash` of the previous entry; null for the first. */
  readonly previousEntryHash: Uint8Array | null;
  readonly members: readonly RosterMember[];
  readonly keyWraps: readonly RosterKeyWrap[];
}

export interface SignedRosterEntry {
  /** Canonical `encodeRosterEntry` bytes. */
  readonly entry: Bytes;
  /** A device signature (`signWithDevice`, purpose `roster`). */
  readonly signature: Bytes;
}

const ROSTER_MAGIC = [0x4f, 0x5a, 0x52]; // "OZR"
const ROSTER_VERSION_1 = 1;
const MAX_ROSTER_MEMBERS = 4096;
const MAX_SEALED_KEY_BYTES = 1024;
const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

const byUserId = <T extends { readonly userId: string }>(a: T, b: T): number =>
  a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;

function checkRosterEntry(
  entry: RosterEntry,
  code: 'invalid-argument' | 'malformed'
): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (!isEnvelopeId(entry.projectId)) fail('Roster projectId is not an id');
  if (!isUint(entry.sequence, 0xffffffff)) fail('sequence must be a u32');
  if (!isUint(entry.keyEpoch, 0xffffffff)) fail('keyEpoch must be a u32');
  if ((entry.sequence === 0) !== (entry.previousEntryHash === null)) {
    fail('Only the first roster entry (sequence 0) has no previous entry');
  }
  if (
    entry.previousEntryHash !== null &&
    !(
      entry.previousEntryHash instanceof Uint8Array &&
      entry.previousEntryHash.byteLength === HASH_BYTES
    )
  ) {
    fail('previousEntryHash must be 32 bytes');
  }
  if (!Array.isArray(entry.members) || entry.members.length === 0) {
    fail('A roster lists at least one member');
  }
  if (entry.members.length > MAX_ROSTER_MEMBERS) fail('Too many members');
  const members = new Set<string>();
  for (const member of entry.members) {
    if (!isEnvelopeId(member?.userId)) fail('Roster userId is not an id');
    if (members.has(member.userId)) fail(`Duplicate member ${member.userId}`);
    members.add(member.userId);
    if (
      !(member.identityKeyHash instanceof Uint8Array) ||
      member.identityKeyHash.byteLength !== HASH_BYTES
    ) {
      fail('identityKeyHash must be 32 bytes');
    }
    if (!ROSTER_ROLES.includes(member.role)) fail('Unknown roster role');
  }
  if (!Array.isArray(entry.keyWraps)) fail('keyWraps must be an array');
  const wrapped = new Set<string>();
  for (const wrap of entry.keyWraps) {
    if (!members.has(wrap?.userId) || wrapped.has(wrap.userId)) {
      fail('Key wraps go to listed members, one each');
    }
    wrapped.add(wrap.userId);
    if (
      !(wrap.sealedKey instanceof Uint8Array) ||
      wrap.sealedKey.byteLength === 0 ||
      wrap.sealedKey.byteLength > MAX_SEALED_KEY_BYTES
    ) {
      fail('sealedKey must be 1..1024 bytes');
    }
  }
  if (wrapped.size !== 0 && wrapped.size !== members.size) {
    fail('An epoch needs a key wrap for every member');
  }
  if (entry.sequence === 0 && wrapped.size === 0) {
    fail('The first roster entry starts an epoch and needs key wraps');
  }
}

/**
 * Canonical bytes: "OZR" | u8 version | u32 sequence | u32 key epoch |
 * u8 previous-hash length (0|32) + hash | u8 length + project id |
 * u16 member count | members sorted by user id, each as u8 length + user id,
 * 32-byte identity key hash, u8 role (1 owner, 2 editor, 3 viewer) |
 * u16 wrap count | wraps sorted by user id, each as u8 length + user id,
 * u16 length + sealed key.
 */
export function encodeRosterEntry(entry: RosterEntry): Bytes {
  checkRosterEntry(entry, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(Uint8Array.from(ROSTER_MAGIC))
    .u8(ROSTER_VERSION_1)
    .u32(entry.sequence)
    .u32(entry.keyEpoch)
    .u8(entry.previousEntryHash?.byteLength ?? 0)
    .bytes(entry.previousEntryHash ?? new Uint8Array())
    .u8(entry.projectId.length)
    .bytes(ascii.encode(entry.projectId))
    .u16(entry.members.length);
  for (const member of [...entry.members].sort(byUserId)) {
    writer
      .u8(member.userId.length)
      .bytes(ascii.encode(member.userId))
      .bytes(member.identityKeyHash)
      .u8(ROSTER_ROLES.indexOf(member.role) + 1);
  }
  writer.u16(entry.keyWraps.length);
  for (const wrap of [...entry.keyWraps].sort(byUserId)) {
    writer
      .u8(wrap.userId.length)
      .bytes(ascii.encode(wrap.userId))
      .u16(wrap.sealedKey.byteLength)
      .bytes(wrap.sealedKey);
  }
  return writer.finish();
}

export function decodeRosterEntry(bytes: Uint8Array): RosterEntry {
  const reader = new ByteReader(bytes, 'Roster entry');
  if (!equalBytes(reader.bytes(3), Uint8Array.from(ROSTER_MAGIC))) {
    throw new E2eeError('malformed', 'Not a roster entry');
  }
  const version = reader.u8();
  if (version !== ROSTER_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Roster version ${version} is not supported`
    );
  }
  const sequence = reader.u32();
  const keyEpoch = reader.u32();
  const hashLength = reader.u8();
  const previousEntryHash =
    hashLength === 0 ? null : copyBytes(reader.bytes(hashLength));
  const projectId = asciiDecoder.decode(reader.bytes(reader.u8()));
  const members: RosterMember[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const userId = asciiDecoder.decode(reader.bytes(reader.u8()));
    const identityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
    const role = ROSTER_ROLES[reader.u8() - 1];
    if (role === undefined) {
      throw new E2eeError('malformed', 'Unknown roster role');
    }
    members.push({ userId, identityKeyHash, role });
  }
  const keyWraps: RosterKeyWrap[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const userId = asciiDecoder.decode(reader.bytes(reader.u8()));
    keyWraps.push({ userId, sealedKey: copyBytes(reader.bytes(reader.u16())) });
  }
  reader.end();
  const entry = {
    projectId,
    sequence,
    keyEpoch,
    previousEntryHash,
    members,
    keyWraps
  };
  checkRosterEntry(entry, 'malformed');
  if (!equalBytes(encodeRosterEntry(entry), bytes)) {
    throw new E2eeError('malformed', 'Roster entry is not in canonical form');
  }
  return entry;
}

/** The hash project envelopes name as `rosterEntryHash`. */
export async function rosterEntryHash(entry: Uint8Array): Promise<Bytes> {
  return chainEntryHash('roster', entry);
}

/** A member signs a roster entry with their certified device key. */
export async function signRosterEntry(
  signer: DeviceSigner,
  entry: RosterEntry,
  signedAt: number = Date.now()
): Promise<SignedRosterEntry> {
  const bytes = encodeRosterEntry(entry);
  return {
    entry: bytes,
    signature: await signWithDevice(signer, 'roster', bytes, signedAt)
  };
}

export type RosterEntryKind = 'membership' | 'epoch';

export interface VerifiedRosterEntry {
  readonly entry: RosterEntry;
  readonly hash: Bytes;
  /** `epoch` when the member list is unchanged and the epoch moved up. */
  readonly kind: RosterEntryKind;
  readonly signer: VerifiedDeviceSignature;
}

export interface RosterChainOptions extends ChainOptions {
  /**
   * Roster ancestry beyond the chain given, for entries signed by a device
   * revoked since: such an entry must be the revocation's roster cutoff
   * head or an ancestor of it. Defaults to the order of the chain itself.
   */
  readonly isAncestorOrSelf?: AncestryLookup;
  /**
   * Authorization, which this package leaves to Phase 5: called for every
   * entry with its verified signer and the entry before it (null for the
   * first). Return false to refuse the chain (`authentication-failed`).
   */
  readonly authorize?: (
    entry: RosterEntry,
    kind: RosterEntryKind,
    signer: VerifiedDeviceSignature,
    previous: RosterEntry | null
  ) => boolean;
}

function sameMembers(a: RosterEntry, b: RosterEntry): boolean {
  if (a.members.length !== b.members.length) return false;
  const left = [...a.members].sort(byUserId);
  const right = [...b.members].sort(byUserId);
  return left.every(
    (member, i) =>
      member.userId === right[i]!.userId &&
      member.role === right[i]!.role &&
      equalBytes(member.identityKeyHash, right[i]!.identityKeyHash)
  );
}

/** The signer of a roster entry, so the caller can fetch their device list. */
export function readRosterSigner(
  signed: SignedRosterEntry
): DeviceSignatureInfo {
  return readDeviceSignature(signed.signature);
}

/**
 * Verifies a roster chain, oldest first. Every entry is canonical and
 * signed by a device certified in its signer's device list (supplied by
 * `deviceLists`); sequences count up; each names its predecessor's hash;
 * the project stays the same; and the key epoch either stays (no wraps) or
 * moves up by one with a wrap for every member, the member list unchanged
 * for an epoch entry. Without a pin the chain starts at sequence 0; with
 * `pinnedEntryHash` it may start later but must contain the pin. Who may
 * sign which entry is the `authorize` callback's job.
 */
export async function verifyRosterChain(
  chain: readonly SignedRosterEntry[],
  deviceLists: (userId: string) => VerifiedDeviceList | undefined,
  options: RosterChainOptions = {}
): Promise<VerifiedRosterEntry[]> {
  if (chain.length === 0) {
    throw new E2eeError('chain-broken', 'Roster chain is empty');
  }
  const entries = chain.map((signed) => decodeRosterEntry(signed.entry));
  const hashes = await Promise.all(
    chain.map((signed) => rosterEntryHash(signed.entry))
  );
  checkChain(
    'Roster',
    entries.map((entry, i) => ({
      sequence: entry.sequence,
      previousEntryHash: entry.previousEntryHash,
      hash: hashes[i]!
    })),
    { pinnedEntryHash: options.pinnedEntryHash, fromGenesis: false }
  );
  const indexOf = (hash: Uint8Array) =>
    hashes.findIndex((candidate) => equalBytes(candidate, hash));
  const inChain: AncestryLookup = (candidate, head) => {
    const at = indexOf(candidate);
    const headAt = indexOf(head);
    return at >= 0 && headAt >= at;
  };
  const verified: VerifiedRosterEntry[] = [];
  for (const [i, signed] of chain.entries()) {
    const entry = entries[i]!;
    const hash = hashes[i]!;
    const { userId } = readDeviceSignature(signed.signature);
    const list = deviceLists(userId);
    if (!list) {
      throw new E2eeError(
        'authentication-failed',
        `No verified device list for roster signer ${userId}`
      );
    }
    const signer = await verifyDeviceSignature(
      list,
      'roster',
      signed.entry,
      signed.signature,
      {
        cutoff: {
          projectId: entry.projectId,
          head: 'roster',
          hash,
          isAncestorOrSelf: options.isAncestorOrSelf ?? inChain
        }
      }
    );
    if (!signer) {
      throw new E2eeError(
        'authentication-failed',
        `Roster entry ${entry.sequence} signature is invalid`
      );
    }
    const before = verified.at(-1);
    let kind: RosterEntryKind = 'membership';
    if (before) {
      const prev = before.entry;
      const epochMoved = entry.keyEpoch === prev.keyEpoch + 1;
      if (
        entry.projectId !== prev.projectId ||
        !(entry.keyEpoch === prev.keyEpoch || epochMoved) ||
        epochMoved !== entry.keyWraps.length > 0
      ) {
        throw new E2eeError(
          'chain-broken',
          `Roster entry ${entry.sequence} does not follow its predecessor`
        );
      }
      if (epochMoved && sameMembers(entry, prev)) kind = 'epoch';
    }
    if (
      options.authorize &&
      !options.authorize(entry, kind, signer, before?.entry ?? null)
    ) {
      throw new E2eeError(
        'authentication-failed',
        `${userId} may not sign roster entry ${entry.sequence}`
      );
    }
    verified.push({ entry, hash, kind, signer });
  }
  return verified;
}
