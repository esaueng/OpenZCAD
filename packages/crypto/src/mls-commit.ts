/**
 * A device's signature on an MLS Commit it hands to the delivery service.
 *
 * The Commit itself is signed inside MLS by the sender's leaf, which only
 * the members' engines check. The Worker that sequences Commits cannot run
 * the MLS engine, so the submitting device also signs a statement that
 * names the account, project, device, epoch and kind and commits to the
 * exact Commit and GroupInfo bytes. The Worker verifies it with the signing
 * key the account's device list certifies for that device, so only a
 * listed device of the calling account can take an epoch, and only with
 * the bytes it signed.
 */
import { ByteWriter, copyBytes, isUint, utf8, type Bytes } from './bytes';
import { signStatement, statementValid, verifyingKey } from './devices';
import { E2eeError } from './errors';
import type { SigningPrivateKey } from './external-keys';
import { sha256 } from './primitives';

export const MLS_COMMIT_SIGNATURE_BYTES = 65;
const STATEMENT_FORMAT_1 = 1;
const MAX_IDENTIFIER_BYTES = 256;

export type MlsCommitSubmissionKind = 'commit' | 'external';

export interface MlsCommitSubmission {
  readonly userId: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly kind: MlsCommitSubmissionKind;
  /** The MLS epoch the Commit was sent in. */
  readonly epoch: number;
  /** The key epoch the Commit makes (key-epoch base + epoch + 1). */
  readonly keyEpoch: number;
  /** The MLSMessage carrying the Commit. */
  readonly message: Uint8Array;
  /** The GroupInfo of the epoch the Commit makes. */
  readonly groupInfo: Uint8Array;
}

function identifier(value: unknown, name: string): Bytes {
  const bytes = typeof value === 'string' ? utf8(value) : null;
  if (
    !bytes ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_IDENTIFIER_BYTES
  ) {
    throw new E2eeError(
      'invalid-argument',
      `${name} must be a non-empty identifier`
    );
  }
  return bytes;
}

/**
 * @internal The signed statement:
 * `u8 1 | u16 len userId | u16 len projectId | u16 len deviceId | u8 kind |
 *  u64 epoch | u64 keyEpoch | SHA-256(message) | SHA-256(groupInfo)`.
 * The label `v1 MLS commit submission signature` is prepended when signed.
 */
export async function mlsCommitSubmissionStatement(
  value: MlsCommitSubmission
): Promise<Bytes> {
  if (!value || typeof value !== 'object') {
    throw new E2eeError('invalid-argument', 'Expected a Commit submission');
  }
  const userId = identifier(value.userId, 'userId');
  const projectId = identifier(value.projectId, 'projectId');
  const deviceId = identifier(value.deviceId, 'deviceId');
  if (value.kind !== 'commit' && value.kind !== 'external') {
    throw new E2eeError('invalid-argument', 'kind must be commit or external');
  }
  if (
    !isUint(value.epoch, Number.MAX_SAFE_INTEGER) ||
    !isUint(value.keyEpoch, Number.MAX_SAFE_INTEGER)
  ) {
    throw new E2eeError('invalid-argument', 'Epochs must be unsigned integers');
  }
  if (
    !(value.message instanceof Uint8Array) ||
    value.message.byteLength === 0 ||
    !(value.groupInfo instanceof Uint8Array) ||
    value.groupInfo.byteLength === 0
  ) {
    throw new E2eeError(
      'invalid-argument',
      'A Commit submission signs a non-empty message and GroupInfo'
    );
  }
  // Copied before the first await, so what is hashed is what was passed.
  const message = copyBytes(value.message);
  const groupInfo = copyBytes(value.groupInfo);
  const writer = new ByteWriter()
    .u8(STATEMENT_FORMAT_1)
    .u16(userId.byteLength)
    .bytes(userId)
    .u16(projectId.byteLength)
    .bytes(projectId)
    .u16(deviceId.byteLength)
    .bytes(deviceId)
    .u8(value.kind === 'commit' ? 1 : 2)
    .u64(value.epoch)
    .u64(value.keyEpoch);
  return writer
    .bytes(await sha256(message))
    .bytes(await sha256(groupInfo))
    .finish();
}

/** Signs a Commit submission: `u8 1 | r || s` (65 bytes). */
export async function signMlsCommitSubmission(
  key: SigningPrivateKey,
  value: MlsCommitSubmission
): Promise<Bytes> {
  return signStatement(
    key,
    'MLS commit submission',
    await mlsCommitSubmissionStatement(value)
  );
}

/**
 * Whether `signature` is `signer`'s signature on exactly this submission.
 * Throws for a malformed signature or submission.
 */
export async function verifyMlsCommitSubmission(
  signer: Uint8Array | CryptoKey,
  value: MlsCommitSubmission,
  signature: Uint8Array
): Promise<boolean> {
  if (
    !(signature instanceof Uint8Array) ||
    signature.byteLength !== MLS_COMMIT_SIGNATURE_BYTES
  ) {
    throw new E2eeError(
      'malformed',
      'MLS commit submission signature has the wrong length'
    );
  }
  const captured = copyBytes(signature);
  const statement = await mlsCommitSubmissionStatement(value);
  return statementValid(
    (await verifyingKey(signer)).key,
    'MLS commit submission',
    statement,
    captured
  );
}
