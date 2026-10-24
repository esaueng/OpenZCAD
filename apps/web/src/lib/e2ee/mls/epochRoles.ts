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
  if (reader.uint(2) !== 1) fail('Not an MLS 1.0 GroupContext.');
  reader.uint(2); // cipher suite
  const groupId = reader.vector();
  const epoch = reader.uint(8);
  reader.vector(); // tree hash
  reader.vector(); // confirmed transcript hash
  const extensions = new Reader(reader.vector());
  if (!reader.done) fail('The GroupContext has trailing bytes.');
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

/** The MLS group id of a project's group. */
export function projectGroupId(projectId: string): Uint8Array {
  return new TextEncoder().encode(`${GROUP_ID_PREFIX}${projectId}`);
}
