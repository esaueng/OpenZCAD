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
 *
 * Version 2 adds `linkTokenHash`: a hash of the token in the emailed link,
 * which the owner's browser makes and the Worker mails. The invitee's
 * browser records that the person accepted an invitation by link only when
 * the statement it gets back names the token it opened, so the server
 * cannot answer a link with another invitation. A version 1 statement
 * (an older app, or a migration invitation, which has no link) is still
 * verified, but it is joined only on the person's explicit confirmation.
 *
 * Version 3 adds `inviteeIdentityKeyHash`: the identity key of the person
 * the owner invited, when the owner had already verified them as a
 * contact. The owner's browser then adds without asking only the account
 * whose acceptance names that identity, so wherever the server delivers
 * the link, nobody else is added automatically. An invitation without it
 * (versions 1 and 2) is added only once the owner confirms the contact who
 * accepted. A version 3 statement may name a link or not.
 */

export const PROJECT_INVITATION_VERSION_1 = 1;
/** Version 1 plus the emailed link's token hash. */
export const PROJECT_INVITATION_VERSION_2 = 2;
/** Version 1 plus the invited contact's identity key hash, and any link's. */
export const PROJECT_INVITATION_VERSION_3 = 3;

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
  /**
   * `invitationLinkTokenHash` of the emailed link's token (version 2).
   * Absent from a version 1 statement, which binds no link.
   */
  readonly linkTokenHash?: Uint8Array;
  /**
   * `publicKeyHash` of the invitee's identity key (version 3): the owner
   * invited a contact they had verified, and only an acceptance by that
   * identity is added without the owner's confirmation. Absent from
   * versions 1 and 2.
   */
  readonly inviteeIdentityKeyHash?: Uint8Array;
}

/**
 * Largest canonical invitation: three longest ids and the signer id, and a
 * version 3 statement's identity hash, link flag and link token hash.
 */
export const MAX_PROJECT_INVITATION_BYTES =
  3 + 1 + 4 * (1 + MAX_ID_BYTES) + HASH_BYTES + 1 + 8 + 8 + 3 * HASH_BYTES + 1;

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
  if (value.linkTokenHash !== undefined && !isHash(value.linkTokenHash)) {
    fail('linkTokenHash must be 32 bytes');
  }
  if (
    value.inviteeIdentityKeyHash !== undefined &&
    !isHash(value.inviteeIdentityKeyHash)
  ) {
    fail('inviteeIdentityKeyHash must be 32 bytes');
  }
}

/** The version a statement encodes as: the newest field it carries. */
function invitationVersion(value: ProjectInvitation): number {
  if (value.inviteeIdentityKeyHash !== undefined) {
    return PROJECT_INVITATION_VERSION_3;
  }
  return value.linkTokenHash !== undefined
    ? PROJECT_INVITATION_VERSION_2
    : PROJECT_INVITATION_VERSION_1;
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
 * The emailed link's token as a version 2 statement names it:
 * `SHA-256(label "v1 invitation link token hash" | UTF-8(token))`. The
 * owner's browser makes the token and signs this hash; the invitee's
 * browser compares it with the token of the link it opened.
 */
export async function invitationLinkTokenHash(token: string): Promise<Bytes> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
    throw new E2eeError('invalid-argument', 'token must be a short string');
  }
  return sha256(
    concatBytes(label('v1 invitation link token hash'), utf8(token))
  );
}

/**
 * Canonical bytes: `"OZI" | u8 version | u8 length + project id | u8 length
 * + invitation id | u8 length + inviter user id | 32-byte invitee email hash
 * | u8 role (1 editor, 2 viewer) | u64 issuedAt | u64 expiresAt | u8 length
 * + signer device id | 32-byte signer key hash`; then for version 2 a
 * `32-byte link token hash`, and for version 3 a `32-byte invitee identity
 * key hash | u8 link (0 or 1)` followed, with a link, by its `32-byte link
 * token hash`. A value with `inviteeIdentityKeyHash` encodes as version 3,
 * one with only `linkTokenHash` as version 2, one with neither as version 1.
 */
export function encodeProjectInvitation(value: ProjectInvitation): Bytes {
  checkInvitation(value, 'invalid-argument');
  const version = invitationVersion(value);
  const writer = new ByteWriter().bytes(INVITATION_MAGIC).u8(version);
  writeId(writer, value.projectId);
  writeId(writer, value.invitationId);
  writeId(writer, value.inviterUserId);
  writer
    .bytes(value.inviteeEmailHash)
    .u8(ROLE_CODES[value.role])
    .u64(value.issuedAt)
    .u64(value.expiresAt);
  writeId(writer, value.signerDeviceId);
  writer.bytes(value.signerKeyHash);
  if (version === PROJECT_INVITATION_VERSION_3) {
    writer
      .bytes(value.inviteeIdentityKeyHash!)
      .u8(value.linkTokenHash !== undefined ? 1 : 0);
  }
  if (value.linkTokenHash !== undefined) writer.bytes(value.linkTokenHash);
  return writer.finish();
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
  if (
    version !== PROJECT_INVITATION_VERSION_1 &&
    version !== PROJECT_INVITATION_VERSION_2 &&
    version !== PROJECT_INVITATION_VERSION_3
  ) {
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
  let inviteeIdentityKeyHash: Uint8Array | undefined;
  let linked = version === PROJECT_INVITATION_VERSION_2;
  if (version === PROJECT_INVITATION_VERSION_3) {
    inviteeIdentityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
    const flag = reader.u8();
    if (flag > 1) {
      throw new E2eeError('malformed', `Unknown invitation link flag ${flag}`);
    }
    linked = flag === 1;
  }
  const linkTokenHash = linked
    ? copyBytes(reader.bytes(HASH_BYTES))
    : undefined;
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
    signerKeyHash,
    ...(linkTokenHash ? { linkTokenHash } : {}),
    ...(inviteeIdentityKeyHash ? { inviteeIdentityKeyHash } : {})
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
  /**
   * `invitationLinkTokenHash` of the link's token: the statement must be
   * version 2 and name exactly it.
   */
  readonly linkTokenHash?: Uint8Array;
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
      !equalBytes(value.inviteeEmailHash, expected.inviteeEmailHash)) ||
    (expected.linkTokenHash !== undefined &&
      (value.linkTokenHash === undefined ||
        !equalBytes(value.linkTokenHash, expected.linkTokenHash)))
  ) {
    refuse('context-mismatch', 'The invitation is for something else');
  }
  return value;
}

// --- Invitee's acceptance ---------------------------------------------------

/**
 * The invitee's signed acceptance of one invitation (ADR-024, Sharing and
 * collaboration): a certified device of the account that accepted signs
 * the invitation it accepted (by the hash of its statement), its own
 * account and identity, and the invitee email hash that statement names.
 * The server stores it with the invitation; the owner's browser checks it
 * against the invitee's verified device list before an Add, so the account
 * the owner adds is the one whose device accepted that very invitation as
 * the recipient of that email, not whichever account the server names.
 */
export const INVITATION_ACCEPTANCE_VERSION_1 = 1;

const ACCEPTANCE_MAGIC = Uint8Array.of(0x4f, 0x5a, 0x4a); // "OZJ"

export interface InvitationAcceptance {
  readonly projectId: string;
  readonly invitationId: string;
  /** `invitationStatementHash` of the accepted invitation's statement. */
  readonly invitationHash: Uint8Array;
  /** The account that accepted. */
  readonly inviteeUserId: string;
  /** `publicKeyHash` of that account's identity key. */
  readonly inviteeIdentityKeyHash: Uint8Array;
  /** The invitation's `inviteeEmailHash`, as the invitee checked it. */
  readonly inviteeEmailHash: Uint8Array;
  /** Unix milliseconds; the signer's claim. */
  readonly acceptedAt: number;
  /** The invitee device that signs, certified in the invitee's list. */
  readonly signerDeviceId: string;
  /** `publicKeyHash` of that device's signing key. */
  readonly signerKeyHash: Uint8Array;
}

/** Largest canonical acceptance: the longest ids. */
export const MAX_INVITATION_ACCEPTANCE_BYTES =
  3 + 1 + 4 * (1 + MAX_ID_BYTES) + 4 * HASH_BYTES + 8;

/**
 * `SHA-256(label "v1 invitation statement hash" | statement)`: the
 * invitation an acceptance names, over its canonical statement bytes.
 */
export async function invitationStatementHash(
  statement: Uint8Array
): Promise<Bytes> {
  if (!(statement instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'statement must be a Uint8Array');
  }
  return sha256(
    concatBytes(label('v1 invitation statement hash'), copyBytes(statement))
  );
}

function checkAcceptance(
  value: InvitationAcceptance,
  code: E2eeErrorCode
): void {
  const fail = (message: string): never => {
    throw new E2eeError(code, message);
  };
  if (value === null || typeof value !== 'object') {
    fail('Expected an invitation acceptance');
  }
  if (!isEnvelopeId(value.projectId)) fail('projectId is not an id');
  if (!isEnvelopeId(value.invitationId)) fail('invitationId is not an id');
  if (!isHash(value.invitationHash)) fail('invitationHash must be 32 bytes');
  if (!isEnvelopeId(value.inviteeUserId)) fail('inviteeUserId is not an id');
  if (!isHash(value.inviteeIdentityKeyHash)) {
    fail('inviteeIdentityKeyHash must be 32 bytes');
  }
  if (!isHash(value.inviteeEmailHash)) {
    fail('inviteeEmailHash must be 32 bytes');
  }
  if (!isUint(value.acceptedAt, Number.MAX_SAFE_INTEGER)) {
    fail('acceptedAt must be Unix milliseconds');
  }
  if (!isEnvelopeId(value.signerDeviceId)) fail('signerDeviceId is not an id');
  if (!isHash(value.signerKeyHash)) fail('signerKeyHash must be 32 bytes');
}

/**
 * Canonical bytes: `"OZJ" | u8 1 | u8 length + project id | u8 length +
 * invitation id | 32-byte invitation statement hash | u8 length + invitee
 * user id | 32-byte invitee identity key hash | 32-byte invitee email hash
 * | u64 acceptedAt | u8 length + signer device id | 32-byte signer key
 * hash`.
 */
export function encodeInvitationAcceptance(value: InvitationAcceptance): Bytes {
  checkAcceptance(value, 'invalid-argument');
  const writer = new ByteWriter()
    .bytes(ACCEPTANCE_MAGIC)
    .u8(INVITATION_ACCEPTANCE_VERSION_1);
  writeId(writer, value.projectId);
  writeId(writer, value.invitationId);
  writer.bytes(value.invitationHash);
  writeId(writer, value.inviteeUserId);
  writer
    .bytes(value.inviteeIdentityKeyHash)
    .bytes(value.inviteeEmailHash)
    .u64(value.acceptedAt);
  writeId(writer, value.signerDeviceId);
  return writer.bytes(value.signerKeyHash).finish();
}

/** Decodes canonical acceptance bytes; anything else is `malformed`. */
export function decodeInvitationAcceptance(
  bytes: Uint8Array
): InvitationAcceptance {
  if (!(bytes instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Acceptance must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_INVITATION_ACCEPTANCE_BYTES) {
    throw new E2eeError('limit-exceeded', 'Acceptance is too large');
  }
  const reader = new ByteReader(bytes, 'Invitation acceptance');
  if (!equalBytes(reader.bytes(3), ACCEPTANCE_MAGIC)) {
    throw new E2eeError('malformed', 'Not an invitation acceptance');
  }
  const version = reader.u8();
  if (version !== INVITATION_ACCEPTANCE_VERSION_1) {
    throw new E2eeError(
      'unsupported-version',
      `Invitation acceptance version ${version} is not supported`
    );
  }
  const projectId = readId(reader);
  const invitationId = readId(reader);
  const invitationHash = copyBytes(reader.bytes(HASH_BYTES));
  const inviteeUserId = readId(reader);
  const inviteeIdentityKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  const inviteeEmailHash = copyBytes(reader.bytes(HASH_BYTES));
  const acceptedAt = reader.u64();
  const signerDeviceId = readId(reader);
  const signerKeyHash = copyBytes(reader.bytes(HASH_BYTES));
  reader.end();
  const value: InvitationAcceptance = {
    projectId,
    invitationId,
    invitationHash,
    inviteeUserId,
    inviteeIdentityKeyHash,
    inviteeEmailHash,
    acceptedAt,
    signerDeviceId,
    signerKeyHash
  };
  checkAcceptance(value, 'malformed');
  if (!equalBytes(encodeInvitationAcceptance(value), bytes)) {
    throw new E2eeError('malformed', 'Invitation acceptance is not canonical');
  }
  return value;
}

/**
 * The invitee's certified device signs an acceptance
 * (`v1 invitation acceptance signature`).
 */
export async function signInvitationAcceptance(
  inviteeDeviceKey: SigningPrivateKey,
  value: InvitationAcceptance
): Promise<SignedStatement> {
  const statement = encodeInvitationAcceptance(value);
  return {
    statement,
    signature: await signStatement(
      inviteeDeviceKey,
      'invitation acceptance',
      statement
    )
  };
}

export interface AcceptanceExpectations {
  readonly projectId: string;
  readonly invitationId: string;
  /** `invitationStatementHash` of the invitation's statement. */
  readonly invitationHash: Uint8Array;
  /** The invitation's `inviteeEmailHash`. */
  readonly inviteeEmailHash: Uint8Array;
  /** The account that accepted. */
  readonly inviteeUserId: string;
  /**
   * `publicKeyHash` of that account's identity key, from its verified
   * device list; a server checking its own stored list may leave it out.
   */
  readonly inviteeIdentityKeyHash?: Uint8Array;
}

/**
 * Verifies an acceptance with the signing device's public key, which the
 * caller takes from the invitee's device list for `signerDeviceId` (the
 * owner's browser: a verified contact's list, checked against its pins;
 * the Worker: the newest stored list): canonical bytes, the key's hash
 * against `signerKeyHash`, the signature, then that it accepts exactly
 * `expected`'s invitation as `expected`'s account (`context-mismatch`).
 */
export async function verifyInvitationAcceptance(
  signed: SignedStatement,
  signerKey: Uint8Array | CryptoKey,
  expected: AcceptanceExpectations
): Promise<InvitationAcceptance> {
  if (
    signed === null ||
    typeof signed !== 'object' ||
    !(signed.statement instanceof Uint8Array) ||
    !(signed.signature instanceof Uint8Array)
  ) {
    throw new E2eeError('invalid-argument', 'Not a signed acceptance');
  }
  if (
    expected === null ||
    typeof expected !== 'object' ||
    !isHash(expected.invitationHash) ||
    !isHash(expected.inviteeEmailHash) ||
    (expected.inviteeIdentityKeyHash !== undefined &&
      !isHash(expected.inviteeIdentityKeyHash))
  ) {
    throw new E2eeError('invalid-argument', 'Expected an invitation to match');
  }
  const statement = copyBytes(signed.statement);
  const signature = copyBytes(signed.signature);
  const invitationHash = copyBytes(expected.invitationHash);
  const inviteeEmailHash = copyBytes(expected.inviteeEmailHash);
  const identityHash =
    expected.inviteeIdentityKeyHash === undefined
      ? undefined
      : copyBytes(expected.inviteeIdentityKeyHash);
  const value = decodeInvitationAcceptance(statement);
  const { key, raw } = await verifyingKey(signerKey);
  if (!equalBytes(await publicKeyHash(raw), value.signerKeyHash)) {
    refuse('signer-mismatch', 'The acceptance names another signing key');
  }
  if (
    !(await statementValid(key, 'invitation acceptance', statement, signature))
  ) {
    refuse('signature', 'The acceptance is forged');
  }
  if (
    value.projectId !== expected.projectId ||
    value.invitationId !== expected.invitationId ||
    !equalBytes(value.invitationHash, invitationHash) ||
    !equalBytes(value.inviteeEmailHash, inviteeEmailHash) ||
    value.inviteeUserId !== expected.inviteeUserId ||
    (identityHash !== undefined &&
      !equalBytes(value.inviteeIdentityKeyHash, identityHash))
  ) {
    refuse('context-mismatch', 'The acceptance is for another invitation');
  }
  return value;
}
