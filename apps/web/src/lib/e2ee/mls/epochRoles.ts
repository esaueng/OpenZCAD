/**
 * The MLS roles of one epoch, read from that epoch's archived record
 * (ADR-024 Phase 5, slice 5-2; roadmap L11). A version is tied to MLS
 * authority by the role its author held in the version's own epoch, so a
 * demoted editor's earlier versions keep verifying and a viewer's, or an
 * unlisted author's, never do. Each key archive carries its epoch's record
 * (`EpochRecord`: the TLS-encoded GroupContext among it), and the
 * GroupContext carries the roles extension every member agreed on.
 *
 * This parses only what the authority check needs, strictly: the
 * GroupContext (RFC 9420 §8.1) and the private-use roles extension
 * (`0xF0A1`, `packages/mls/crate/src/model.rs`: version, rejoin window and
 * the users sorted by id, each with its role and the epoch it took
 * effect). Anything that does not decode exactly is refused.
 */
import type { ProjectRoles, Role } from '@openzcad/mls';

/** `ROLES_EXT` in `model.rs`. */
export const ROLES_EXTENSION_TYPE = 0xf0a1;
const ROLES_VERSION = 1;
/** `GROUP_ID_PREFIX` in `model.rs`: the MLS group id is it plus the project id. */
const GROUP_ID_PREFIX = 'openzcad/project/';
const ROLES: Record<number, Role> = { 1: 'viewer', 2: 'editor', 3: 'owner' };

export class EpochRecordError extends Error {
  override readonly name = 'EpochRecordError';
}

const fail = (message: string): never => {
  throw new EpochRecordError(message);
};

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length)
      fail('The record ends early.');
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint(length: 1 | 2 | 4 | 8): number {
    let value = 0;
    for (const byte of this.take(length)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) fail('An integer is out of range.');
    return value;
  }

  /** An RFC 9420 §2.1.2 variable-length integer. */
  varint(): number {
    const first = this.uint(1);
    const prefix = first >> 6;
    if (prefix === 3) fail('A length uses the reserved prefix.');
    const length = 1 << prefix;
    let value = first & 0x3f;
    for (let index = 1; index < length; index++) {
      value = value * 256 + this.uint(1);
    }
    // The shortest encoding only, as the MLS codec requires.
    if (prefix > 0 && value < 1 << (8 * (length / 2) - 2)) {
      fail('A length is not minimally encoded.');
    }
    return value;
  }

  vector(): Uint8Array {
    return this.take(this.varint());
  }
}

/** What a GroupContext says about authority: its group, epoch and roles. */
export interface EpochContext {
  readonly groupId: Uint8Array;
  readonly epoch: number;
  readonly roles: ProjectRoles;
}

function decodeRoles(data: Uint8Array): ProjectRoles {
  const reader = new Reader(data);
  if (reader.uint(1) !== ROLES_VERSION) fail('Unknown roles version.');
  const rejoinWindow = reader.uint(4);
  const list = new Reader(reader.vector());
  if (!reader.done) fail('The roles extension has trailing bytes.');
  const users: ProjectRoles['users'] = [];
  const text = new TextDecoder('utf-8', { fatal: true });
  while (!list.done) {
    let userId: string;
    try {
      userId = text.decode(list.vector());
    } catch {
      return fail('A role names a user id that is not UTF-8.');
    }
    const role = ROLES[list.uint(1)] ?? fail('A role is unknown.');
    const since = list.uint(8);
    const previous = users.at(-1);
    if (previous && !(previous.userId < userId)) {
      fail('Roles are not sorted by user id without duplicates.');
    }
    users.push({ userId, role, since });
  }
  if (users.filter((user) => user.role === 'owner').length !== 1) {
    fail('Roles must name exactly one owner.');
  }
  return { rejoinWindow, users };
}

/** Parses a TLS-encoded GroupContext and its roles extension. */
export function parseEpochContext(groupContext: Uint8Array): EpochContext {
  const reader = new Reader(groupContext);
  const context = readGroupContext(reader);
  if (!reader.done) fail('The GroupContext has trailing bytes.');
  return context;
}

/** RFC 9420 §6: `mls_group_info` in an MLSMessage. */
const WIRE_FORMAT_GROUP_INFO = 4;

/**
 * The GroupContext of an MLSMessage-framed GroupInfo (RFC 9420 §12.4.3),
 * which every Commit carries for its new epoch (slice 5-4). Only the
 * framing and the GroupContext are read: the GroupInfo's own extensions,
 * confirmation tag and signature are not checked here. The Worker uses it
 * to compare the roles a Commit's new epoch states with the change its
 * request says it makes, as defense in depth; browsers check the Commit.
 */
export function parseGroupInfoContext(groupInfo: Uint8Array): EpochContext {
  const reader = new Reader(groupInfo);
  if (reader.uint(2) !== 1) fail('Not an MLS 1.0 message.');
  if (reader.uint(2) !== WIRE_FORMAT_GROUP_INFO) fail('Not a GroupInfo.');
  return readGroupContext(reader);
}

function readGroupContext(reader: Reader): EpochContext {
  if (reader.uint(2) !== 1) fail('Not an MLS 1.0 GroupContext.');
  reader.uint(2); // cipher suite
  const groupId = reader.vector();
  const epoch = reader.uint(8);
  reader.vector(); // tree hash
  reader.vector(); // confirmed transcript hash
  const extensions = new Reader(reader.vector());
  let roles: ProjectRoles | null = null;
  while (!extensions.done) {
    const type = extensions.uint(2);
    const data = extensions.vector();
    if (type !== ROLES_EXTENSION_TYPE) continue;
    if (roles) fail('The GroupContext carries two roles extensions.');
    roles = decodeRoles(data);
  }
  if (!roles) fail('The GroupContext has no roles extension.');
  return { groupId: new Uint8Array(groupId), epoch, roles: roles! };
}

/** RFC 9420 §6: `mls_public_message` in an MLSMessage. */
const WIRE_FORMAT_PUBLIC_MESSAGE = 1;
/** RFC 9420 §6.1: `member`. */
const SENDER_MEMBER = 1;
/** RFC 9420 §6: `proposal`. */
const CONTENT_PROPOSAL = 2;
/**
 * The SelfRemove proposal type the engine's mls-rs build sends (a
 * private-use number until the MLS extensions draft assigns one); checked
 * against the engine's own output in `epochRoles.test.ts`.
 */
export const SELF_REMOVE_PROPOSAL_TYPE = 0xf003;

/** Who sent a SelfRemove proposal, and in which group and epoch. */
export interface SelfRemoveFrame {
  readonly groupId: Uint8Array;
  readonly epoch: number;
  readonly senderLeaf: number;
}

/**
 * The framing of a SelfRemove proposal (slice 5-5): an MLSMessage
 * PublicMessage whose content is a proposal of the SelfRemove type, sent by
 * a member. Nothing after the proposal type is read, and the signature is
 * not checked here: the MLS engine checks it when a member processes the
 * proposal. A departing member's proposal is vetted with this before
 * anyone's engine caches it, since a cached proposal of another type (a
 * Remove of someone else's leaf, say) would make every Commit of that
 * epoch break the policy.
 */
export function parseSelfRemoveProposal(message: Uint8Array): SelfRemoveFrame {
  const reader = new Reader(message);
  if (reader.uint(2) !== 1) fail('Not an MLS 1.0 message.');
  if (reader.uint(2) !== WIRE_FORMAT_PUBLIC_MESSAGE) {
    fail('Not a PublicMessage.');
  }
  const groupId = reader.vector();
  const epoch = reader.uint(8);
  if (reader.uint(1) !== SENDER_MEMBER) fail('Not sent by a member.');
  const senderLeaf = reader.uint(4);
  reader.vector(); // authenticated data
  if (reader.uint(1) !== CONTENT_PROPOSAL) fail('Not a proposal.');
  if (reader.uint(2) !== SELF_REMOVE_PROPOSAL_TYPE) {
    fail('Not a SelfRemove proposal.');
  }
  return { groupId: new Uint8Array(groupId), epoch, senderLeaf };
}

/** The MLS group id of a project's group. */
export function projectGroupId(projectId: string): Uint8Array {
  return new TextEncoder().encode(`${GROUP_ID_PREFIX}${projectId}`);
}
