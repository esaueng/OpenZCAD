import {
  ByteReader,
  ByteWriter,
  copyBytes,
  equalBytes,
  isUint,
  type Bytes
} from './bytes';
import { chainEntryHash, checkChain, type ChainLink } from './chain';
import {
  readDeviceSignature,
  signIdentityStatement,
  signWithDevice,
  verifyDeviceSignature,
  verifyIdentityStatement,
  type AncestryLookup,
  type DeviceSigner,
  type VerifiedDeviceList,
  type VerifiedDeviceSignature
} from './devices';
import { E2eeError } from './errors';
import { HASH_BYTES, isEnvelopeId } from './header';

export const ROSTER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

/**
 * The four roster entry types and their signer rules (ADR-024, Signed
 * roster):
 *
 * | Type              | Signed by                                          | May change                                   |
 * | ----------------- | -------------------------------------------------- | -------------------------------------------- |
 * | `membership`      | a certified device key of the owner (the anchor)   | members and roles; may start an epoch         |
 * | `epoch`           | a certified device key of any current member       | only the key epoch, wrapped to every member  |
 * | `self-removal`    | the departing member's device key or identity key  | removes only the signer; carries no key      |
 * | `anchor-transfer` | the owner's old identity key                       | names the owner's new identity               |
 *
 * Only membership entries list members; the others apply to the membership
 * in force at their parent. A removal that does not start an epoch itself
 * leaves a rotation pending: no version may be written until a remaining
 * member's device signs the next epoch entry (`checkVersionEpoch`).
 */
export const ROSTER_ENTRY_TYPES = [
  'membership',
  'epoch',
  'self-removal',
  'anchor-transfer'
] as const;
export type RosterEntryType = (typeof ROSTER_ENTRY_TYPES)[number];

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

interface RosterEntryBase {
  readonly projectId: string;
  /** 0 for the first entry, then +1 per entry. */
  readonly sequence: number;
  readonly keyEpoch: number;
  /** `rosterEntryHash` of the previous entry; null for the first. */
  readonly previousEntryHash: Uint8Array | null;
}

export interface MembershipEntry extends RosterEntryBase {
  readonly type: 'membership';
  readonly members: readonly RosterMember[];
  /** One per member when the epoch moves; empty otherwise. */
  readonly keyWraps: readonly RosterKeyWrap[];
}

export interface EpochEntry extends RosterEntryBase {
  readonly type: 'epoch';
  /** One per member in force. */
  readonly keyWraps: readonly RosterKeyWrap[];
}

export interface SelfRemovalEntry extends RosterEntryBase {
  readonly type: 'self-removal';
  /**
   * The departing member, who must be the signer. The entry carries no
   * project key: a departing (possibly compromised) key must not choose the
   * next one.
   */
  readonly removedUserId: string;
}

export interface AnchorTransferEntry extends RosterEntryBase {
  readonly type: 'anchor-transfer';
  /** `publicKeyHash` of the owner's new identity key. */
  readonly newIdentityKeyHash: Uint8Array;
}

export type RosterEntry =
  MembershipEntry | EpochEntry | SelfRemovalEntry | AnchorTransferEntry;

export type RosterSignatureKind = 'device' | 'identity';

export interface SignedRosterEntry {
  /** Canonical `encodeRosterEntry` bytes. */
  readonly entry: Bytes;
  /**
   * A device signature (`signWithDevice`, purpose `roster`), or an identity
   * signature (`u8 version | r || s` over `label "v1 roster signature" | entry`).
   */
  readonly signature: Bytes;
  readonly signedBy: RosterSignatureKind;
}

const ROSTER_MAGIC = [0x4f, 0x5a, 0x52]; // "OZR"
const ROSTER_VERSION_1 = 1;
const MAX_ROSTER_MEMBERS = 4096;
const MAX_SEALED_KEY_BYTES = 1024;
const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

const byUserId = <T extends { readonly userId: string }>(a: T, b: T): number =>
  a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;

/** A plain boolean, so a failed check does not narrow the value to `never`. */
const isList = (value: unknown): boolean => Array.isArray(value);

const isHash = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength === HASH_BYTES;

function checkWraps(
  wraps: readonly RosterKeyWrap[],
  fail: (message: string) => never
): void {
  if (!isList(wraps)) fail('keyWraps must be an array');
  if (wraps.length > MAX_ROSTER_MEMBERS) fail('Too many key wraps');
  const seen = new Set<string>();
  for (const wrap of wraps) {
    if (!isEnvelopeId(wrap?.userId) || seen.has(wrap.userId)) {
      fail('Key wraps name distinct members');
    }
    seen.add(wrap.userId);
    if (
      !(wrap.sealedKey instanceof Uint8Array) ||
      wrap.sealedKey.byteLength === 0 ||
      wrap.sealedKey.byteLength > MAX_SEALED_KEY_BYTES
    ) {
      fail('sealedKey must be 1..1024 bytes');
    }
  }
}

function checkRosterEntry(
  entry: RosterEntry,
  code: 'invalid-argument' | 'malformed'
): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (!ROSTER_ENTRY_TYPES.includes(entry?.type)) fail('Unknown roster type');
  if (!isEnvelopeId(entry.projectId)) fail('Roster projectId is not an id');
  if (!isUint(entry.sequence, 0xffffffff)) fail('sequence must be a u32');
  if (!isUint(entry.keyEpoch, 0xffffffff)) fail('keyEpoch must be a u32');
  if ((entry.sequence === 0) !== (entry.previousEntryHash === null)) {
    fail('Only the first roster entry (sequence 0) has no previous entry');
  }
  if (entry.previousEntryHash !== null && !isHash(entry.previousEntryHash)) {
    fail('previousEntryHash must be 32 bytes');
  }
  if (entry.sequence === 0 && entry.type !== 'membership') {
    fail('The first roster entry is a membership entry');
  }
  switch (entry.type) {
    case 'membership': {
      if (!isList(entry.members) || entry.members.length === 0) {
        fail('A membership entry lists at least one member');
      }
      if (entry.members.length > MAX_ROSTER_MEMBERS) fail('Too many members');
      const members = new Set<string>();
      let owners = 0;
      for (const member of entry.members) {
        if (!isEnvelopeId(member?.userId)) fail('Roster userId is not an id');
        if (members.has(member.userId)) {
          fail(`Duplicate member ${member.userId}`);
        }
        members.add(member.userId);
        if (!isHash(member.identityKeyHash)) {
          fail('identityKeyHash must be 32 bytes');
        }
        if (!ROSTER_ROLES.includes(member.role)) fail('Unknown roster role');
        if (member.role === 'owner') owners += 1;
      }
      if (owners !== 1) fail('A membership entry lists exactly one owner');
      checkWraps(entry.keyWraps, fail);
      if (
        entry.keyWraps.length !== 0 &&
        (entry.keyWraps.length !== members.size ||
          entry.keyWraps.some((wrap) => !members.has(wrap.userId)))
      ) {
        fail('A new epoch wraps the key to every listed member');
      }
      if (entry.sequence === 0 && entry.keyWraps.length === 0) {
        fail('The first roster entry starts an epoch and needs key wraps');
      }
      return;
    }
    case 'epoch':
      checkWraps(entry.keyWraps, fail);
      if (entry.keyWraps.length === 0) fail('An epoch entry needs key wraps');
      return;
    case 'self-removal':
      if (!isEnvelopeId(entry.removedUserId)) {
        fail('removedUserId is not an id');
      }
      return;
    case 'anchor-transfer':
      if (!isHash(entry.newIdentityKeyHash)) {
        fail('newIdentityKeyHash must be 32 bytes');
      }
      return;
  }
}

function writeId(writer: ByteWriter, id: string): void {
  writer.u8(id.length).bytes(ascii.encode(id));
}

function readId(reader: ByteReader): string {
  return asciiDecoder.decode(reader.bytes(reader.u8()));
}

function writeWraps(writer: ByteWriter, wraps: readonly RosterKeyWrap[]): void {
  writer.u16(wraps.length);
  for (const wrap of [...wraps].sort(byUserId)) {
    writeId(writer, wrap.userId);
    writer.u16(wrap.sealedKey.byteLength).bytes(wrap.sealedKey);
  }
}

function readWraps(reader: ByteReader): RosterKeyWrap[] {
  const wraps: RosterKeyWrap[] = [];
  for (let count = reader.u16(); count > 0; count -= 1) {
    const userId = readId(reader);
    wraps.push({ userId, sealedKey: copyBytes(reader.bytes(reader.u16())) });
  }
  return wraps;
}

/**
 * Canonical bytes: "OZR" | u8 version | u8 type (1 membership, 2 epoch,
 * 3 self-removal, 4 anchor-transfer) | u32 sequence | u32 key epoch |
 * u8 previous-hash length (0|32) + hash | u8 length + project id, then by
 * type: membership `u16 count | members | wraps`; epoch `wraps`;
 * self-removal `u8 length + removed user id`; anchor-transfer
 * `32-byte new identity key hash`. Members are sorted by user id, each as
 * u8 length + user id, 32-byte identity key hash, u8 role (1 owner,
 * 2 editor, 3 viewer). Wraps are `u16 count` then, sorted by user id,
 * u8 length + user id and u16 length + sealed key.
 */
export function encodeRosterEntry(entry: RosterEntry): Bytes {
  checkRosterEntry(entry, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(Uint8Array.from(ROSTER_MAGIC))
    .u8(ROSTER_VERSION_1)
    .u8(ROSTER_ENTRY_TYPES.indexOf(entry.type) + 1)
    .u32(entry.sequence)
    .u32(entry.keyEpoch)
    .u8(entry.previousEntryHash?.byteLength ?? 0)
    .bytes(entry.previousEntryHash ?? new Uint8Array());
  writeId(writer, entry.projectId);
  switch (entry.type) {
    case 'membership':
      writer.u16(entry.members.length);
      for (const member of [...entry.members].sort(byUserId)) {
        writeId(writer, member.userId);
        writer
          .bytes(member.identityKeyHash)
          .u8(ROSTER_ROLES.indexOf(member.role) + 1);
      }
      writeWraps(writer, entry.keyWraps);
      break;
    case 'epoch':
      writeWraps(writer, entry.keyWraps);
      break;
    case 'self-removal':
      writeId(writer, entry.removedUserId);
      break;
    case 'anchor-transfer':
      writer.bytes(entry.newIdentityKeyHash);
      break;
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
  const type = ROSTER_ENTRY_TYPES[reader.u8() - 1];
  if (type === undefined) {
    throw new E2eeError('malformed', 'Unknown roster entry type');
  }
  const sequence = reader.u32();
  const keyEpoch = reader.u32();
  const hashLength = reader.u8();
  const previousEntryHash =
    hashLength === 0 ? null : copyBytes(reader.bytes(hashLength));
  const base = {
    projectId: readId(reader),
    sequence,
    keyEpoch,
    previousEntryHash
  };
  let entry: RosterEntry;
  switch (type) {
    case 'membership': {
      const members: RosterMember[] = [];
      for (let count = reader.u16(); count > 0; count -= 1) {
        const userId = readId(reader);
        const identityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
        const role = ROSTER_ROLES[reader.u8() - 1];
        if (role === undefined) {
          throw new E2eeError('malformed', 'Unknown roster role');
        }
        members.push({ userId, identityKeyHash, role });
      }
      entry = { type, ...base, members, keyWraps: readWraps(reader) };
      break;
    }
    case 'epoch':
      entry = { type, ...base, keyWraps: readWraps(reader) };
      break;
    case 'self-removal':
      entry = { type, ...base, removedUserId: readId(reader) };
      break;
    case 'anchor-transfer':
      entry = {
        type,
        ...base,
        newIdentityKeyHash: copyBytes(reader.bytes(HASH_BYTES))
      };
      break;
  }
  reader.end();
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

/** Signs a membership, epoch or self-removal entry with a device key. */
export async function signRosterEntry(
  signer: DeviceSigner,
  entry: RosterEntry,
  signedAt: number = Date.now()
): Promise<SignedRosterEntry> {
  const bytes = encodeRosterEntry(entry);
  return {
    entry: bytes,
    signature: await signWithDevice(signer, 'roster', bytes, signedAt),
    signedBy: 'device'
  };
}

/**
 * Signs an anchor transfer (or a self-removal) with an identity key: the
 * owner's old identity, or a departing member's exposed identity.
 */
export async function signRosterEntryWithIdentity(
  identityPrivateKey: CryptoKey,
  entry: RosterEntry
): Promise<SignedRosterEntry> {
  const bytes = encodeRosterEntry(entry);
  return {
    entry: bytes,
    signature: await signIdentityStatement(identityPrivateKey, 'roster', bytes),
    signedBy: 'identity'
  };
}

/** The roster's owner identity, which every member verified. */
export interface RosterAnchor {
  readonly userId: string;
  readonly identityKeyHash: Bytes;
}

/** The roster in force after an entry: what the next entry applies to. */
export interface RosterState {
  readonly projectId: string;
  readonly sequence: number;
  readonly hash: Bytes;
  readonly keyEpoch: number;
  readonly members: readonly RosterMember[];
  readonly anchor: RosterAnchor;
  /**
   * True after a member left without a new epoch: versions must wait for an
   * epoch entry signed by a remaining member's device.
   */
  readonly rotationPending: boolean;
}

/**
 * Checks the key epoch of a version written under `state` (the roster entry
 * its header names): no version while a removal's rotation is pending, and
 * only the epoch in force otherwise. Throws `context-mismatch`.
 */
export function checkVersionEpoch(state: RosterState, keyEpoch: number): void {
  if (state.rotationPending) {
    throw new E2eeError(
      'context-mismatch',
      'A member left; versions wait for a new epoch from a remaining member'
    );
  }
  if (keyEpoch !== state.keyEpoch) {
    throw new E2eeError(
      'context-mismatch',
      `Versions under this roster entry use epoch ${state.keyEpoch}, not ${keyEpoch}`
    );
  }
}

export interface RosterSigner {
  readonly userId: string;
  /** The identity the roster in force names for the signer. */
  readonly identityKeyHash: Bytes;
  readonly signedBy: RosterSignatureKind;
  /** The device, for device signatures. */
  readonly device: VerifiedDeviceSignature | null;
}

export interface VerifiedRosterEntry {
  readonly entry: RosterEntry;
  readonly hash: Bytes;
  readonly signer: RosterSigner;
  /** The roster in force after this entry. */
  readonly state: RosterState;
}

/**
 * Returns the verified device list of an identity the roster names. The
 * verifier checks the list belongs to that identity.
 */
export type RosterDeviceLists = (
  userId: string,
  identityKeyHash: Uint8Array
) => VerifiedDeviceList | undefined;

export interface RosterChainOptions {
  /** The newest roster entry this browser has seen. */
  readonly pinnedEntryHash?: Uint8Array;
  /** The verified state before the first entry, when it is not sequence 0. */
  readonly from?: RosterState;
  /**
   * Roster ancestry beyond the chain given, for entries signed by a device
   * revoked since. Defaults to the order of the chain itself.
   */
  readonly isAncestorOrSelf?: AncestryLookup;
  /**
   * Extra policy on top of the per-type signer rules, for Phase 5: for
   * example refusing an anchor transfer until the member has verified the
   * new identity outside OpenZCAD. Return false to refuse
   * (`authentication-failed`).
   */
  readonly authorize?: (
    entry: RosterEntry,
    signer: RosterSigner,
    before: RosterState | null
  ) => boolean;
}

function memberMap(
  members: readonly RosterMember[]
): Map<string, RosterMember> {
  return new Map(members.map((member) => [member.userId, member]));
}

function sameUsers(
  wraps: readonly RosterKeyWrap[],
  members: readonly RosterMember[]
): boolean {
  const ids = new Set(members.map((member) => member.userId));
  return (
    wraps.length === ids.size && wraps.every((wrap) => ids.has(wrap.userId))
  );
}

function copyMember(member: RosterMember): RosterMember {
  return { ...member, identityKeyHash: copyBytes(member.identityKeyHash) };
}

/** Applies one entry to the roster in force; throws `chain-broken` on a rule break. */
function applyEntry(
  entry: RosterEntry,
  hash: Bytes,
  before: RosterState | null
): RosterState {
  const broken = (why: string): never => {
    throw new E2eeError(
      'chain-broken',
      `Roster entry ${entry.sequence} (${entry.type}): ${why}`
    );
  };
  if (!before) {
    if (entry.type !== 'membership')
      return broken('the first entry lists members');
    const owner = entry.members.find((member) => member.role === 'owner')!;
    return {
      projectId: entry.projectId,
      sequence: entry.sequence,
      hash,
      keyEpoch: entry.keyEpoch,
      members: entry.members.map(copyMember),
      anchor: {
        userId: owner.userId,
        identityKeyHash: copyBytes(owner.identityKeyHash)
      },
      rotationPending: false
    };
  }
  if (entry.projectId !== before.projectId) broken('the project changed');
  const moved = entry.keyEpoch === before.keyEpoch + 1;
  if (!moved && entry.keyEpoch !== before.keyEpoch) {
    broken('the key epoch stays or moves up by one');
  }
  const next = {
    ...before,
    sequence: entry.sequence,
    hash,
    keyEpoch: entry.keyEpoch
  };
  const inForce = memberMap(before.members);
  switch (entry.type) {
    case 'membership': {
      const owner = entry.members.find((member) => member.role === 'owner')!;
      if (
        owner.userId !== before.anchor.userId ||
        !equalBytes(owner.identityKeyHash, before.anchor.identityKeyHash)
      ) {
        broken('the owner listed must be the roster anchor');
      }
      const listed = memberMap(entry.members);
      const someoneLeaves = [...inForce.keys()].some((id) => !listed.has(id));
      if (moved !== entry.keyWraps.length > 0) {
        broken('key wraps go with, and only with, a new epoch');
      }
      // The owner remains, so an owner entry may rotate as it removes.
      return {
        ...next,
        members: entry.members.map(copyMember),
        rotationPending: moved ? false : before.rotationPending || someoneLeaves
      };
    }
    case 'epoch':
      if (!moved) broken('an epoch entry moves the epoch up by one');
      if (!sameUsers(entry.keyWraps, before.members)) {
        broken('the key is wrapped to every member in force');
      }
      // Signed by a member in force, so after a removal by a remaining one.
      return { ...next, rotationPending: false };
    case 'self-removal': {
      if (moved) broken('a self-removal carries no new epoch');
      if (!inForce.has(entry.removedUserId)) {
        broken('the departing user is not a member');
      }
      return {
        ...next,
        members: before.members.filter(
          (member) => member.userId !== entry.removedUserId
        ),
        rotationPending: true
      };
    }
    case 'anchor-transfer': {
      if (moved) broken('an anchor transfer keeps the key epoch');
      if (equalBytes(entry.newIdentityKeyHash, before.anchor.identityKeyHash)) {
        broken('the new identity must differ from the old');
      }
      const newHash = copyBytes(entry.newIdentityKeyHash);
      const owner: RosterMember = {
        userId: before.anchor.userId,
        identityKeyHash: newHash,
        role: 'owner'
      };
      return {
        ...next,
        anchor: { userId: before.anchor.userId, identityKeyHash: newHash },
        // The owner keeps (or regains, after a self-removal) the owner role
        // under the new identity.
        members: [
          ...before.members.filter((m) => m.userId !== owner.userId),
          owner
        ]
      };
    }
  }
}

/**
 * Verifies a roster chain, oldest first, applying each typed entry to the
 * roster in force and enforcing its signer rule:
 *
 * - `membership`: a device key of the anchor (the owner), whose identity
 *   is the anchor's; the listed owner stays the anchor; it may start an
 *   epoch, and removing someone without one leaves a rotation pending.
 * - `epoch`: a device key of any member in force (so, after a removal, a
 *   remaining member); wraps to every member; clears a pending rotation.
 * - `self-removal`: the departing member, by device or identity key; no
 *   key, so it leaves a rotation pending.
 * - `anchor-transfer`: the anchor's identity key (the old one).
 *
 * Device signatures are checked against the device list `deviceLists`
 * returns for the identity the roster names, within any revocation
 * cutoff. Sequences link by hash from sequence 0 or from `from`, and the
 * chain must contain `pinnedEntryHash` when given. Returns each entry with
 * the state after it.
 */
export async function verifyRosterChain(
  chain: readonly SignedRosterEntry[],
  deviceLists: RosterDeviceLists,
  options: RosterChainOptions = {}
): Promise<VerifiedRosterEntry[]> {
  if (chain.length === 0) {
    throw new E2eeError('chain-broken', 'Roster chain is empty');
  }
  const entries = chain.map((signed) => decodeRosterEntry(signed.entry));
  const hashes = await Promise.all(
    chain.map((signed) => rosterEntryHash(signed.entry))
  );
  const from = options.from;
  const links: ChainLink[] = entries.map((entry, i) => ({
    sequence: entry.sequence,
    previousEntryHash: entry.previousEntryHash,
    hash: hashes[i]!
  }));
  checkChain(
    'Roster',
    from
      ? [
          { sequence: from.sequence, previousEntryHash: null, hash: from.hash },
          ...links
        ]
      : links,
    {
      // A verified `from` state anchors a chain that starts mid-history.
      pinnedEntryHash: options.pinnedEntryHash ?? from?.hash,
      fromGenesis: !from
    }
  );
  const known = from ? [from.hash, ...hashes] : hashes;
  const indexOf = (hash: Uint8Array) =>
    known.findIndex((candidate) => equalBytes(candidate, hash));
  const inChain: AncestryLookup = (candidate, head) => {
    const at = indexOf(candidate);
    return at >= 0 && indexOf(head) >= at;
  };

  const verified: VerifiedRosterEntry[] = [];
  let state: RosterState | null = from ?? null;
  for (const [i, signed] of chain.entries()) {
    const entry = entries[i]!;
    const hash = hashes[i]!;
    const signer = await verifySigner(entry, hash, signed, state, deviceLists, {
      projectId: entry.projectId,
      isAncestorOrSelf: options.isAncestorOrSelf ?? inChain
    });
    const after = applyEntry(entry, hash, state);
    if (options.authorize && !options.authorize(entry, signer, state)) {
      throw new E2eeError(
        'authentication-failed',
        `${signer.userId} may not sign roster entry ${entry.sequence}`
      );
    }
    verified.push({ entry, hash, signer, state: after });
    state = after;
  }
  return verified;
}

async function verifySigner(
  entry: RosterEntry,
  hash: Bytes,
  signed: SignedRosterEntry,
  before: RosterState | null,
  deviceLists: RosterDeviceLists,
  cutoff: { projectId: string; isAncestorOrSelf: AncestryLookup }
): Promise<RosterSigner> {
  const refuse = (why: string): never => {
    throw new E2eeError(
      'authentication-failed',
      `Roster entry ${entry.sequence} (${entry.type}): ${why}`
    );
  };
  // Who the type says must sign, and with which kinds of key.
  let userId: string;
  let identityKeyHash: Uint8Array;
  let allowed: readonly RosterSignatureKind[];
  if (!before) {
    if (entry.type !== 'membership')
      return refuse('the first entry lists members');
    const owner = entry.members.find((member) => member.role === 'owner')!;
    userId = owner.userId;
    identityKeyHash = owner.identityKeyHash;
    allowed = ['device'];
  } else if (entry.type === 'membership' || entry.type === 'anchor-transfer') {
    userId = before.anchor.userId;
    identityKeyHash = before.anchor.identityKeyHash;
    allowed = entry.type === 'membership' ? ['device'] : ['identity'];
  } else {
    if (entry.type === 'self-removal') {
      userId = entry.removedUserId;
    } else if (signed.signedBy === 'device') {
      userId = readDeviceSignature(signed.signature).userId;
    } else {
      return refuse('an epoch entry is signed by a device key');
    }
    const member = before.members.find((m) => m.userId === userId);
    if (!member) return refuse(`${userId} is not a member in force`);
    identityKeyHash = member.identityKeyHash;
    allowed =
      entry.type === 'self-removal' ? ['device', 'identity'] : ['device'];
  }
  if (!allowed.includes(signed.signedBy)) {
    refuse(`must be signed by ${allowed.join(' or ')} key`);
  }
  const list = deviceLists(userId, identityKeyHash);
  if (!list || !equalBytes(list.identityKeyHash, identityKeyHash)) {
    return refuse(`no device list for ${userId}'s identity in the roster`);
  }
  if (signed.signedBy === 'identity') {
    await verifyIdentityStatement(
      list.identityKey,
      'roster',
      signed.entry,
      signed.signature,
      entry.sequence
    );
    return {
      userId,
      identityKeyHash: copyBytes(identityKeyHash),
      signedBy: 'identity',
      device: null
    };
  }
  if (readDeviceSignature(signed.signature).userId !== userId) {
    refuse(`must be signed by ${userId}`);
  }
  const device = await verifyDeviceSignature(
    list,
    'roster',
    signed.entry,
    signed.signature,
    {
      cutoff: {
        projectId: cutoff.projectId,
        head: 'roster',
        hash,
        isAncestorOrSelf: cutoff.isAncestorOrSelf
      }
    }
  );
  if (!device) return refuse('the device signature is invalid');
  return {
    userId,
    identityKeyHash: copyBytes(identityKeyHash),
    signedBy: 'device',
    device
  };
}
