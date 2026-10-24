import {
  ByteReader,
  ByteWriter,
  concatBytes,
  copyBytes,
  equalBytes,
  isUint,
  label,
  utf8,
  type Bytes
} from './bytes';
import { publicKeyHash } from './codes';
import {
  signStatement,
  statementValid,
  verifyingKey,
  type SignedStatement
} from './devices';
import { E2eeError, type E2eeErrorCode } from './errors';
import { HASH_BYTES, MAX_ID_BYTES, isEnvelopeId } from './header';
import { sha256 } from './primitives';
import type { SigningPrivateKey } from './external-keys';

/**
 * Owner-signed project invitations (ADR-024, Sharing and collaboration;
 * Phase 5, slice 5-3a). An invitation to an encrypted project is a
 * statement the owner's certified device signs, naming the project, the
 * invitation, the owner, a hash of the invitee's email (not the email), the
 * role and an expiry of at most seven days. The server stores it and binds
 * the accepting account to it by the email hash; the invitee's browser
 * verifies it against the owner's device list before it publishes a
 * KeyPackage, and the owner's browser only Commits an Add for invitations
 * it signed.
 */

export const PROJECT_INVITATION_VERSION_1 = 1;

const INVITATION_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x49); // "OZI"

/** The longest an invitation may last: `expiresAt - issuedAt` (7 days). */
export const MAX_PROJECT_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How far a signer's clock may run ahead of a verifier's. */
export const INVITATION_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** The role an invitation offers: owners are never invited. */
export type InvitationRole = 'editor' | 'viewer';
export const INVITATION_ROLES = Object.freeze(['editor', 'viewer'] as const);
const ROLE_CODES: Record<InvitationRole, number> = { editor: 1, viewer: 2 };

export interface ProjectInvitation {
  readonly projectId: string;
  readonly invitationId: string;
  /** The project owner, who signs. */
  readonly inviterUserId: string;
  /** `invitationEmailHash` of the invitee's email. */
  readonly inviteeEmailHash: Uint8Array;
  readonly role: InvitationRole;
  /** Unix milliseconds; the signer's claim. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** The owner device that signs, certified in the owner's device list. */
  readonly signerDeviceId: string;
  /** `publicKeyHash` of that device's signing key. */
  readonly signerKeyHash: Uint8Array;
}

/** Largest canonical invitation: three longest ids and the signer id. */
export const MAX_PROJECT_INVITATION_BYTES =
  3 + 1 + 4 * (1 + MAX_ID_BYTES) + HASH_BYTES + 1 + 8 + 8 + HASH_BYTES;

export type InvitationFailure =
  /** The signature does not verify under the given signing key. */
  | 'signature'
  /** The statement names another signing key than the one given. */
  | 'signer-mismatch'
  /** The invitation expired before the verifier's `now`. */
  | 'expired'
  /** Issued after the verifier's `now`, beyond the clock skew. */
  | 'not-yet-valid'
  /** Valid, but for another project, invitation, owner or email. */
  | 'context-mismatch';

const FAILURE_CODES: Record<InvitationFailure, E2eeErrorCode> = {
  signature: 'authentication-failed',
  'signer-mismatch': 'authentication-failed',
  expired: 'context-mismatch',
  'not-yet-valid': 'context-mismatch',
  'context-mismatch': 'context-mismatch'
};

export class ProjectInvitationError extends E2eeError {
  readonly reason: InvitationFailure;

  constructor(reason: InvitationFailure, message: string) {
    super(FAILURE_CODES[reason], message);
    this.reason = reason;
  }
}

function refuse(reason: InvitationFailure, message: string): never {
  throw new ProjectInvitationError(reason, message);
}

const ascii = new TextEncoder();
const asciiDecoder = new TextDecoder();

function writeId(writer: ByteWriter, id: string): void {
  writer.u8(id.length).bytes(ascii.encode(id));
}

function readId(reader: ByteReader): string {
  return asciiDecoder.decode(reader.bytes(reader.u8()));
}

const isHash = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength === HASH_BYTES;

function checkInvitation(value: ProjectInvitation, code: E2eeErrorCode): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') {
    fail('Expected an invitation');
  }
  if (!isEnvelopeId(value.projectId)) fail('projectId is not an id');
  if (!isEnvelopeId(value.invitationId)) fail('invitationId is not an id');
  if (!isEnvelopeId(value.inviterUserId)) fail('inviterUserId is not an id');
  if (!isHash(value.inviteeEmailHash)) {
    fail('inviteeEmailHash must be 32 bytes');
  }
  if (!INVITATION_ROLES.includes(value.role)) fail('Unknown invitation role');
  if (!isUint(value.issuedAt, Number.MAX_SAFE_INTEGER)) {
    fail('issuedAt must be Unix milliseconds');
  }
  if (!isUint(value.expiresAt, Number.MAX_SAFE_INTEGER)) {
    fail('expiresAt must be Unix milliseconds');
  }
  if (value.expiresAt <= value.issuedAt) {
    fail('An invitation must expire after it is issued');
  }
  if (value.expiresAt - value.issuedAt > MAX_PROJECT_INVITATION_LIFETIME_MS) {
    fail('An invitation lasts at most 7 days');
  }
  if (!isEnvelopeId(value.signerDeviceId)) fail('signerDeviceId is not an id');
  if (!isHash(value.signerKeyHash)) fail('signerKeyHash must be 32 bytes');
}

/**
 * The invitee's email as the statement names it:
 * `SHA-256(label "v1 invitation email hash" | UTF-8(lowercase(trim(email))))`.
 * The server holds the email to send the invitation; the statement and the
 * stored invitation hold only this hash.
 */
export async function invitationEmailHash(email: string): Promise<Bytes> {
  if (typeof email !== 'string') {
    throw new E2eeError('invalid-argument', 'email must be a string');
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320) {
    throw new E2eeError('invalid-argument', 'email is not an address');
  }
  return sha256(
    concatBytes(label('v1 invitation email hash'), utf8(normalized))
  );
}

/**
 * Canonical bytes: `"OZI" | u8 1 | u8 length + project id | u8 length +
 * invitation id | u8 length + inviter user id | 32-byte invitee email hash |
 * u8 role (1 editor, 2 viewer) | u64 issuedAt | u64 expiresAt | u8 length +
 * signer device id | 32-byte signer key hash`.
 */
export function encodeProjectInvitation(value: ProjectInvitation): Bytes {
  checkInvitation(value, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(INVITATION_MAGIC)
    .u8(PROJECT_INVITATION_VERSION_1);
  writeId(writer, value.projectId);
  writeId(writer, value.invitationId);
  writeId(writer, value.inviterUserId);
  writer
    .bytes(value.inviteeEmailHash)
    .u8(ROLE_CODES[value.role])
    .u64(value.issuedAt)
    .u64(value.expiresAt);
  writeId(writer, value.signerDeviceId);
  return writer.bytes(value.signerKeyHash).finish();
}

/** Decodes canonical invitation bytes; anything else is `malformed`. */
export function decodeProjectInvitation(bytes: Uint8Array): ProjectInvitation {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Invitation must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_PROJECT_INVITATION_BYTES) {
    throw new E2eeError('limit-exceeded', 'Invitation is too large');
  }
  const reader = new ByteReader(bytes, 'Project invitation');
  if (!equalBytes(reader.bytes(3), INVITATION_MAGIC)) {
    throw new E2eeError('malformed', 'Not a project invitation');
  }
  const version = reader.u8();
  if (version !== PROJECT_INVITATION_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Project invitation version ${version} is not supported`
    );
  }
  const projectId = readId(reader);
  const invitationId = readId(reader);
  const inviterUserId = readId(reader);
  const inviteeEmailHash = copyBytes(reader.bytes(HASH_BYTES));
  const code = reader.u8();
  const role = INVITATION_ROLES.find((r) => ROLE_CODES[r] === code);
  if (!role)
    throw new E2eeError('malformed', `Unknown invitation role ${code}`);
  const issuedAt = reader.u64();
  const expiresAt = reader.u64();
  const signerDeviceId = readId(reader);
  const signerKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  reader.end();
  const value: ProjectInvitation = {
    projectId,
    invitationId,
    inviterUserId,
    inviteeEmailHash,
    role,
    issuedAt,
    expiresAt,
    signerDeviceId,
    signerKeyHash
  };
  checkInvitation(value, 'malformed');
  if (!equalBytes(encodeProjectInvitation(value), bytes)) {
    throw new E2eeError('malformed', 'Project invitation is not canonical');
  }
  return value;
}

/**
 * The owner's certified device signs an invitation
 * (`v1 project invitation signature`). `signerKeyHash` must be that
 * device's key; `verifyProjectInvitation` checks it.
 */
export async function signProjectInvitation(
  ownerDeviceKey: SigningPrivateKey,
  value: ProjectInvitation
): Promise<SignedStatement> {
  const statement = encodeProjectInvitation(value);
  return {
    statement,
    signature: await signStatement(
      ownerDeviceKey,
      'project invitation',
      statement
    )
  };
}

export interface InvitationExpectations {
  readonly projectId?: string;
  readonly invitationId?: string;
  readonly inviterUserId?: string;
  readonly inviteeEmailHash?: Uint8Array;
}

/**
 * Verifies a signed invitation with the signing device's public key, which
 * the caller takes from the owner's verified device list (the Worker: the
 * stored newest list; a browser: the pinned one) for `signerDeviceId`:
 * canonical bytes, the key's hash against `signerKeyHash`, the signature,
 * then `now` within `[issuedAt - skew, expiresAt)`, then `expected`.
 */
export async function verifyProjectInvitation(
  signed: SignedStatement,
  signerKey: Uint8Array | CryptoKey,
  options: { readonly now: number; readonly expected?: InvitationExpectations }
): Promise<ProjectInvitation> {
  if (
    signed === null ||
    typeof signed !== 'object' ||
    !(signed.statement instanceof Uint8Array) ||
    !(signed.signature instanceof Uint8Array)
  ) {
    throw new E2eeError('invalid-argument', 'Not a signed invitation');
  }
  const now = options?.now;
  if (!isUint(now, Number.MAX_SAFE_INTEGER)) {
    throw new E2eeError('invalid-argument', 'now must be Unix milliseconds');
  }
  const statement = copyBytes(signed.statement);
  const signature = copyBytes(signed.signature);
  const value = decodeProjectInvitation(statement);
  const { key, raw } = await verifyingKey(signerKey);
  if (!equalBytes(await publicKeyHash(raw), value.signerKeyHash)) {
    refuse('signer-mismatch', 'The invitation names another signing key');
  }
  if (
    !(await statementValid(key, 'project invitation', statement, signature))
  ) {
    refuse('signature', 'The invitation is forged');
  }
  if (now >= value.expiresAt) refuse('expired', 'The invitation expired');
  if (value.issuedAt > now + INVITATION_CLOCK_SKEW_MS) {
    refuse('not-yet-valid', 'The invitation is not valid yet');
  }
  const expected = options.expected ?? {};
  if (
    (expected.projectId !== undefined &&
      value.projectId !== expected.projectId) ||
    (expected.invitationId !== undefined &&
      value.invitationId !== expected.invitationId) ||
    (expected.inviterUserId !== undefined &&
      value.inviterUserId !== expected.inviterUserId) ||
    (expected.inviteeEmailHash !== undefined &&
      !equalBytes(value.inviteeEmailHash, expected.inviteeEmailHash))
  ) {
    refuse('context-mismatch', 'The invitation is for something else');
  }
  return value;
}
