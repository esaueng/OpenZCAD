/**
 * End-to-end encryption key routes (ADR-024 Phase 3, first slice; roadmap
 * L11). The Worker is a store and relay here: it keeps public keys,
 * identity-signed device-list entries, wrapped keys and the device-approval
 * exchange, and it never sees a secret key.
 *
 * It still checks what it can, as defense in depth: every chain it stores
 * verifies under the user's identity key, entries extend the stored head,
 * a rotation replaces every account-key wrap at once and carries the
 * replaced account key wrapped under the new one (the account-key history),
 * and a setup carries the wraps without which the account could not be
 * unlocked again. Browsers verify all of it themselves and never trust these
 * checks.
 *
 * Closed unless `isE2eeKeysEnabled`; refused with 503 until migrations 0029
 * and 0030 are in D1.
 */
import {
  E2eeError,
  MAX_LISTED_DEVICES,
  accountKeySequence,
  decodeDeviceApprovalGrant,
  decodeDeviceListEntry,
  decodeIdentityTransition,
  deviceKeysHash,
  fromBase64Url,
  importEncryptionPublicKey,
  importSigningPublicKey,
  publicKeyHash,
  toBase64Url,
  toHex,
  verifyDeviceApprovalGrant,
  verifyDeviceList,
  verifyIdentityTransition,
  type DeviceListEntry,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeAccountKeyHistoryInput,
  E2eeAccountKeyHistoryRecord,
  E2eeAccountResponse,
  E2eeApprovalRecord,
  E2eeApprovalState,
  E2eeIdentityRecord,
  E2eePreviousIdentityRecord,
  E2eeWrapInput,
  E2eeWrapPurpose,
  E2eeWrapRecord
} from '@openzcad/shared';

import {
  e2eeWriteAuthorization,
  releaseDevelopmentE2eeWrite,
  type E2eeWriteAuthorization
} from './e2eeWriteAuthorization';
import {
  PROJECT_PREFERENCES_ROUTE,
  handleProjectPreferenceRequest,
  isE2eeProjectPreferenceStorageReady
} from './e2eeProjectPreferences';
import {
  handleAssistantConsentRequest,
  isAssistantConsentPath,
  isE2eeAssistantConsentStorageReady
} from './e2eeAssistantConsents';
import {
  RouteError,
  handleE2eeProjectRequest,
  isE2eeProjectPath
} from './e2eeProjects';
import {
  handleE2eeShareLinkRequest,
  isE2eeShareLinkPath
} from './e2eeShareLinks';
import { handleE2eeContactsRequest, isE2eeContactsPath } from './e2eeContacts';
import {
  handleE2eeInvitationRequest,
  isE2eeInvitationPath,
  type E2eeInvitationHost
} from './e2eeInvitations';
import {
  MAX_APPEND_CUTOFFS_CHARS,
  appendedRevocationCutoffs,
  handleE2eeDeviceRemovalRequest,
  isE2eeDeviceRemovalPath,
  refuseCutoffsIncomplete
} from './e2eeDeviceRemoval';
import {
  blobBucket,
  handleE2eeContentBlobRequest,
  isE2eeContentBlobPath
} from './e2eeContentBlobs';
import {
  handleE2eeProjectDocumentRequest,
  isE2eeProjectDocumentPath,
  type E2eeObjectBucket
} from './e2eeProjectDocuments';
import {
  handleE2eeProjectEnvelopeRequest,
  isE2eeProjectEnvelopePath
} from './e2eeProjectEnvelopes';
import {
  handleE2eeProjectMigrationRequest,
  isE2eeProjectMigrationPath
} from './e2eeProjectMigrations';
import { migrationLeaseOf } from './e2eeMigrationLease';
import {
  isE2eeProjectGroupStorageReady,
  isE2eeProjectMigrationStorageReady,
  isE2eeProjectVersionStorageReady
} from '@openzcad/cloudflare-adapters';

interface WriteDatabase extends D1Database {
  authorization: E2eeWriteAuthorization;
}

export class E2eeRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'E2eeRouteError';
  }
}

export interface E2eeRouteSession {
  readonly userId: string;
}

export interface E2eeRouteEnv {
  DB?: D1Database;
  AUTH_MODE?: string;
  ENVIRONMENT?: string;
  /** Where encrypted document bodies above the inline size live. */
  PROJECT_STORAGE?: unknown;
  ARTIFACTS?: unknown;
  /** Project rooms, which a migration locks and purges (slice 7-1). */
  PROJECT_ROOM?: unknown;
}

/** The project-storage bucket, as the persistence layer picks it. */
export function projectBucket(env: E2eeRouteEnv): E2eeObjectBucket | null {
  const bucket = (env.PROJECT_STORAGE ?? env.ARTIFACTS) as
    Partial<E2eeObjectBucket> | undefined;
  return bucket &&
    typeof bucket.put === 'function' &&
    typeof bucket.get === 'function' &&
    typeof bucket.delete === 'function'
    ? (bucket as E2eeObjectBucket)
    : null;
}

const MAX_BODY_BYTES = 512 * 1024;
const MAX_WRAPS = 200;
const MAX_WRAP_CHARS = 8192;
/** Entries one generation may hold; replacing the recovery key starts over. */
export const MAX_GENERATION_ENTRIES = 256;
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** Completed and expired approvals are kept this long, for the hourly cap. */
const APPROVAL_RETENTION_MS = 60 * 60 * 1000;
export const MAX_OPEN_APPROVALS = 3;
export const MAX_APPROVALS_PER_HOUR = 10;
/** The current key generation may retain this many read-only recipients. */
export const MAX_READ_ONLY_DEVICES = MAX_LISTED_DEVICES;
const PREVIOUS_GENERATIONS = 3;

const WRAP_PURPOSES: readonly E2eeWrapPurpose[] = [
  'account-key',
  'account-key-approval',
  'identity-key',
  'unlock-target-key',
  'encryption-key'
];

const ENCRYPTION_KEY_TARGET = 'current';

function refuse(status: number, code: string, message: string): never {
  throw new E2eeRouteError(status, code, message);
}

function invalid(message: string): never {
  refuse(400, 'E2EE_REQUEST_INVALID', message);
}

/** Bytes from an unpadded base64url field, with an exact or maximum length. */
function bytesField(
  value: unknown,
  what: string,
  length: { exact?: number; max?: number }
): Uint8Array {
  if (typeof value !== 'string') invalid(`${what} must be base64url text`);
  const max = length.exact ?? length.max!;
  if (value.length > Math.ceil((max * 4) / 3)) invalid(`${what} is too long`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    invalid(`${what} is not base64url`);
  }
  if (length.exact !== undefined && bytes.byteLength !== length.exact) {
    invalid(`${what} must be ${length.exact} bytes`);
  }
  if (bytes.byteLength === 0) invalid(`${what} is empty`);
  return bytes;
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) invalid('Request body is missing');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return record(JSON.parse(new TextDecoder().decode(bytes)), 'Body');
  } catch (error) {
    if (error instanceof E2eeRouteError) throw error;
    invalid('Body is not JSON');
  }
}

function parseWraps(value: unknown): E2eeWrapInput[] {
  if (!Array.isArray(value) || value.length > MAX_WRAPS) {
    invalid(`wraps must be an array of at most ${MAX_WRAPS}`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const wrap = record(item, `wraps[${index}]`);
    if (!WRAP_PURPOSES.includes(wrap.purpose as E2eeWrapPurpose)) {
      invalid(`wraps[${index}].purpose is unknown`);
    }
    if (!isId(wrap.targetId)) invalid(`wraps[${index}].targetId is not an id`);
    if (
      typeof wrap.wrapped !== 'string' ||
      wrap.wrapped.length === 0 ||
      wrap.wrapped.length > MAX_WRAP_CHARS
    ) {
      invalid(`wraps[${index}].wrapped must be 1..${MAX_WRAP_CHARS} chars`);
    }
    bytesField(wrap.wrapped, `wraps[${index}].wrapped`, { max: 6144 });
    const key = `${wrap.purpose as string}:${wrap.targetId}`;
    if (seen.has(key)) invalid('A wrap is listed twice');
    seen.add(key);
    return {
      purpose: wrap.purpose as E2eeWrapPurpose,
      targetId: wrap.targetId,
      wrapped: wrap.wrapped
    };
  });
}

/** Bytes of an AES-KW wrap (`u8 2 | 40 bytes`), as `previous-account-key` makes. */
const HISTORY_WRAP_BYTES = 41;

/**
 * The replaced account key wrapped under the new one. A rotation without it
 * would strand every key wrapped under the old account key, so it is as
 * required as the account-key wraps, and it must name the key it replaces.
 */
function parseHistory(
  value: unknown,
  expected: { generation: number; keySequence: number }
): E2eeAccountKeyHistoryInput {
  if (value === undefined || value === null) {
    invalid('A rotation must carry the replaced account key (history)');
  }
  const history = record(value, 'history');
  if (
    history.generation !== expected.generation ||
    history.keySequence !== expected.keySequence
  ) {
    invalid(
      `The history must wrap account key ${expected.generation}:${expected.keySequence}`
    );
  }
  const wrapped = bytesField(history.wrapped, 'history.wrapped', {
    exact: HISTORY_WRAP_BYTES
  });
  if (wrapped[0] !== 2) invalid('history.wrapped is not an AES-KW wrap');
  return {
    generation: expected.generation,
    keySequence: expected.keySequence,
    wrapped: history.wrapped as string
  };
}

function insertHistory(
  db: D1Database,
  userId: string,
  history: E2eeAccountKeyHistoryInput,
  now: string,
  guard: { sql: string; binds: unknown[] }
): D1PreparedStatement {
  // No ON CONFLICT: a key is replaced once, and a duplicate aborts the batch.
  return db
    .prepare(
      `INSERT INTO e2ee_account_key_history
         (user_id, generation, key_sequence, wrapped, created_at)
       SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}`
    )
    .bind(
      userId,
      history.generation,
      history.keySequence,
      history.wrapped,
      now,
      ...guard.binds
    );
}

function signedEntryOf(body: Record<string, unknown>): {
  signed: SignedDeviceListEntry;
  entryText: string;
  signatureText: string;
} {
  const entry = bytesField(body.entry, 'entry', { max: 32 * 1024 });
  const signature = bytesField(body.signature, 'signature', { exact: 65 });
  return {
    signed: { entry, signature },
    entryText: body.entry as string,
    signatureText: body.signature as string
  };
}

function refuseKeys(error: E2eeError): never {
  refuse(
    400,
    'E2EE_KEYS_INVALID',
    `The key material did not verify: ${error.message}`
  );
}

async function verifiedChain(
  identityKey: Uint8Array,
  chain: SignedDeviceListEntry[]
): Promise<VerifiedDeviceList> {
  try {
    return await verifyDeviceList(identityKey, chain);
  } catch (error) {
    if (error instanceof E2eeError) refuseKeys(error);
    throw error;
  }
}

// --- Storage --------------------------------------------------------------

interface IdentityRow {
  generation: number;
  identity_key: string;
  transition_statement: string | null;
  transition_signature: string | null;
  created_at: string;
}

interface EntryRow {
  sequence: number;
  entry: string;
  signature: string;
  entry_hash: string;
}

interface WrapRow {
  purpose: E2eeWrapPurpose;
  target_id: string;
  key_sequence: number;
  wrapped: string;
}

function database(env: E2eeRouteEnv): D1Database {
  if (!env.DB) {
    refuse(503, 'E2EE_UNAVAILABLE', 'Encryption keys are unavailable.');
  }
  return env.DB;
}

async function currentIdentity(
  db: D1Database,
  userId: string
): Promise<IdentityRow | null> {
  return db
    .prepare(
      `SELECT generation, identity_key, transition_statement,
              transition_signature, created_at
       FROM e2ee_identities WHERE user_id = ?
       ORDER BY generation DESC LIMIT 1`
    )
    .bind(userId)
    .first<IdentityRow>();
}

async function entryRows(
  db: D1Database,
  userId: string,
  generation: number
): Promise<EntryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sequence, entry, signature, entry_hash
       FROM e2ee_device_list_entries
       WHERE user_id = ? AND generation = ?
       ORDER BY sequence`
    )
    .bind(userId, generation)
    .all<EntryRow>();
  return results ?? [];
}

const toSigned = (row: EntryRow): SignedDeviceListEntry => ({
  entry: fromBase64Url(row.entry),
  signature: fromBase64Url(row.signature)
});

function insertWrap(
  db: D1Database,
  userId: string,
  generation: number,
  keySequence: number,
  wrap: E2eeWrapInput,
  now: string,
  guard: { sql: string; binds: unknown[] }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO e2ee_key_wraps
         (user_id, generation, purpose, target_id, key_sequence, wrapped, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, generation, purpose, target_id) DO UPDATE SET
         key_sequence = excluded.key_sequence,
         wrapped = excluded.wrapped,
         updated_at = excluded.updated_at`
    )
    .bind(
      userId,
      generation,
      wrap.purpose,
      wrap.targetId,
      keySequence,
      wrap.wrapped,
      now,
      ...guard.binds
    );
}

// --- Wrap rules -----------------------------------------------------------

/**
 * The wraps an account needs to be unlockable at all: the recovery target's
 * private half, the identity key and account key sealed to it, the account
 * key sealed to every live device, and the encryption key.
 */
function checkCompleteWraps(
  head: DeviceListEntry,
  wraps: readonly E2eeWrapInput[],
  { identity }: { identity: boolean }
): void {
  const has = (purpose: E2eeWrapPurpose, targetId: string) =>
    wraps.some((w) => w.purpose === purpose && w.targetId === targetId);
  for (const target of head.unlockTargets) {
    if (!has('account-key', target.targetId)) {
      invalid(`The account key is not sealed to ${target.targetId}`);
    }
    if (identity) {
      if (!has('identity-key', target.targetId)) {
        invalid(`The identity key is not sealed to ${target.targetId}`);
      }
      if (!has('unlock-target-key', target.targetId)) {
        invalid(`The unlock target key is not wrapped for ${target.targetId}`);
      }
    }
  }
  for (const device of head.devices) {
    if (!has('account-key', device.deviceId)) {
      invalid(`The account key is not sealed to ${device.deviceId}`);
    }
  }
  if (!has('encryption-key', ENCRYPTION_KEY_TARGET)) {
    invalid('The encryption key is not wrapped');
  }
}

/** Every wrap must name something the head certifies. */
function checkWrapTargets(
  head: DeviceListEntry,
  wraps: readonly E2eeWrapInput[]
): void {
  const devices = new Set(head.devices.map((d) => d.deviceId));
  const targets = new Set(head.unlockTargets.map((t) => t.targetId));
  for (const wrap of wraps) {
    const ok =
      wrap.purpose === 'account-key'
        ? devices.has(wrap.targetId) || targets.has(wrap.targetId)
        : wrap.purpose === 'identity-key' ||
            wrap.purpose === 'unlock-target-key'
          ? targets.has(wrap.targetId)
          : wrap.purpose === 'encryption-key'
            ? wrap.targetId === ENCRYPTION_KEY_TARGET
            : false;
    if (!ok) {
      invalid(
        `A ${wrap.purpose} wrap names ${wrap.targetId}, which is not listed`
      );
    }
  }
}

// --- Routes ---------------------------------------------------------------

async function loadAccount(
  db: D1Database,
  userId: string
): Promise<E2eeAccountResponse> {
  // Every response carrier comes from one D1 transaction: a rotation or
  // identity replacement cannot split the chain from the keys it commits.
  const currentGeneration =
    '(SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?)';
  const [
    identityResult,
    entryResult,
    wrapResult,
    approvedResult,
    previousResult
  ] = await db.batch([
    db
      .prepare(
        `SELECT generation, identity_key, transition_statement,
                transition_signature, created_at
         FROM e2ee_identities WHERE user_id = ?
         ORDER BY generation DESC LIMIT ?`
      )
      .bind(userId, PREVIOUS_GENERATIONS + 1),
    db
      .prepare(
        `SELECT sequence, entry, signature, entry_hash
         FROM e2ee_device_list_entries
         WHERE user_id = ? AND generation = ${currentGeneration}
         ORDER BY sequence`
      )
      .bind(userId, userId),
    db
      .prepare(
        `SELECT purpose, target_id, key_sequence, wrapped
         FROM e2ee_key_wraps WHERE user_id = ? AND generation = ${currentGeneration}
         ORDER BY purpose, target_id`
      )
      .bind(userId, userId),
    db
      .prepare(
        `SELECT w.target_id AS device_id, w.updated_at AS approved_at,
           COALESCE((SELECT a.label FROM e2ee_device_approvals a
             WHERE a.user_id = w.user_id AND a.device_id = w.target_id
               AND a.state = 'completed'
             ORDER BY a.created_at DESC, a.id DESC LIMIT 1), 'Read-only device') AS label
         FROM e2ee_key_wraps w
         WHERE w.user_id = ? AND w.generation = ${currentGeneration}
           AND w.purpose = 'account-key-approval'
         ORDER BY w.target_id`
      )
      .bind(userId, userId),
    db
      .prepare(
        `SELECT e.generation, e.sequence, e.entry, e.signature, e.entry_hash
         FROM e2ee_device_list_entries e
         WHERE e.user_id = ? AND e.generation IN (
           SELECT generation FROM e2ee_identities WHERE user_id = ?
           ORDER BY generation DESC LIMIT ? OFFSET 1
         ) AND e.sequence = (
           SELECT MAX(sequence) FROM e2ee_device_list_entries h
           WHERE h.user_id = e.user_id AND h.generation = e.generation
         )`
      )
      .bind(userId, userId, PREVIOUS_GENERATIONS)
  ]);
  if (
    !identityResult ||
    !entryResult ||
    !wrapResult ||
    !approvedResult ||
    !previousResult
  ) {
    throw new Error('Incomplete encryption account snapshot');
  }
  const [current, ...previous] = (identityResult.results ??
    []) as IdentityRow[];
  if (!current) return { current: null, previous: [] };
  const entries = (entryResult.results ?? []) as EntryRow[];
  const wraps = (wrapResult.results ?? []) as WrapRow[];
  const approvedDevices = (approvedResult.results ?? []) as {
    device_id: string;
    label: string;
    approved_at: string;
  }[];
  const previousHeads = (previousResult.results ?? []) as (EntryRow & {
    generation: number;
  })[];
  const previousRecords: E2eePreviousIdentityRecord[] = [];
  for (const row of previous) {
    const head = previousHeads.find(
      (entry) => entry.generation === row.generation
    );
    if (head) {
      previousRecords.push({
        generation: row.generation,
        identityKey: row.identity_key,
        createdAt: row.created_at,
        head: {
          sequence: head.sequence,
          entry: head.entry,
          signature: head.signature
        }
      });
    }
  }
  const currentRecord: E2eeIdentityRecord = {
    generation: current.generation,
    identityKey: current.identity_key,
    createdAt: current.created_at,
    entries: entries.map((row) => ({
      sequence: row.sequence,
      entry: row.entry,
      signature: row.signature
    })),
    transition:
      current.transition_statement && current.transition_signature
        ? {
            statement: current.transition_statement,
            signature: current.transition_signature
          }
        : null,
    approvedDevices: approvedDevices.map((row) => ({
      deviceId: row.device_id,
      label: row.label,
      approvedAt: row.approved_at
    })),
    wraps: wraps.map((row): E2eeWrapRecord => ({
      purpose: row.purpose,
      targetId: row.target_id,
      keySequence: row.key_sequence,
      wrapped: row.wrapped
    }))
  };
  return { current: currentRecord, previous: previousRecords };
}

/** Writes a first generation, or a replacement one, and its first entry. */
async function writeGeneration(
  db: WriteDatabase,
  userId: string,
  input: {
    generation: number;
    identityKeyText: string;
    entryText: string;
    signatureText: string;
    entryHash: string;
    wraps: readonly E2eeWrapInput[];
    transition: { statement: string; signature: string } | null;
    /**
     * For a replacement: the previous generation's head the Worker verified
     * the transition against. A device-list write that lands in between (a
     * revocation of the signing device, say) makes the replacement conflict
     * instead of slipping past it.
     */
    previousHead: { sequence: number; entryHash: string } | null;
    /** For a replacement: the replaced identity's account key, wrapped. */
    history: E2eeAccountKeyHistoryInput | null;
    /** For a replacement: what must still hold when the identity lands. */
    fence?: { sql: string; binds: string[] };
  }
): Promise<boolean> {
  const now = new Date().toISOString();
  const previousHead = input.previousHead;
  const auth = db.authorization;
  const guard = {
    sql: `EXISTS (SELECT 1 FROM e2ee_identities
                  WHERE user_id = ? AND generation = ? AND identity_key = ?) AND ${auth.sql}`,
    binds: [userId, input.generation, input.identityKeyText, ...auth.binds]
  };
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO e2ee_identities
           (user_id, generation, identity_key, transition_statement,
            transition_signature, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE ${auth.sql} AND (SELECT COALESCE(MAX(generation), 0) FROM e2ee_identities
                WHERE user_id = ?) = ?
           AND ${
             previousHead
               ? `(SELECT entry_hash FROM e2ee_device_list_entries
                   WHERE user_id = ? AND generation = ?
                   ORDER BY sequence DESC LIMIT 1) = ?
                  AND (SELECT MAX(sequence) FROM e2ee_device_list_entries
                       WHERE user_id = ? AND generation = ?) = ?`
               : '1 = 1'
           }
           AND ${input.fence?.sql ?? '1 = 1'}`
      )
      .bind(
        userId,
        input.generation,
        input.identityKeyText,
        input.transition?.statement ?? null,
        input.transition?.signature ?? null,
        now,
        ...auth.binds,
        userId,
        input.generation - 1,
        ...(previousHead
          ? [
              userId,
              input.generation - 1,
              previousHead.entryHash,
              userId,
              input.generation - 1,
              previousHead.sequence
            ]
          : []),
        ...(input.fence?.binds ?? [])
      ),
    db
      .prepare(
        `INSERT INTO e2ee_device_list_entries
           (user_id, generation, sequence, entry, signature, entry_hash, created_at)
         SELECT ?, ?, 0, ?, ?, ?, ? WHERE ${guard.sql}
           AND NOT EXISTS (SELECT 1 FROM e2ee_device_list_entries
                           WHERE user_id = ? AND generation = ?)`
      )
      .bind(
        userId,
        input.generation,
        input.entryText,
        input.signatureText,
        input.entryHash,
        now,
        ...guard.binds,
        userId,
        input.generation
      ),
    ...input.wraps.map((wrap) =>
      insertWrap(db, userId, input.generation, 0, wrap, now, guard)
    ),
    ...(input.history
      ? [insertHistory(db, userId, input.history, now, guard)]
      : []),
    // A replaced identity's wraps open nothing anyone should use again.
    // Expire old approvals, retaining receipts for the per-account hourly cap.
    db
      .prepare(
        `DELETE FROM e2ee_key_wraps
         WHERE user_id = ? AND generation < ? AND ${guard.sql}`
      )
      .bind(userId, input.generation, ...guard.binds),
    db
      .prepare(
        `UPDATE e2ee_device_approvals SET expires_at = MIN(expires_at, ?)
         WHERE user_id = ? AND ${guard.sql}`
      )
      .bind(now, userId, ...guard.binds),
    // Retain exactly the history loadAccount exposes. The foreign-key
    // cascade removes entries and wraps too; a failed or revoked replacement
    // cannot prune because the new identity must exist under the same guard.
    db
      .prepare(
        `DELETE FROM e2ee_identities
         WHERE user_id = ? AND generation < ? AND ${guard.sql}`
      )
      .bind(userId, input.generation - PREVIOUS_GENERATIONS, ...guard.binds)
  ];
  const results = await db.batch(statements);
  return (results[0]?.meta?.changes ?? 0) === 1;
}

async function handleSetup(
  db: WriteDatabase,
  userId: string,
  body: Record<string, unknown>
): Promise<E2eeAccountResponse> {
  const identityKey = bytesField(body.identityKey, 'identityKey', {
    exact: 65
  });
  const { signed, entryText, signatureText } = signedEntryOf(body);
  const wraps = parseWraps(body.wraps);
  const list = await verifiedChain(identityKey, [signed]);
  if (list.userId !== userId) invalid('The device list is for another user');
  if (list.head.previousIdentityKeyHash !== null) {
    invalid('A first setup replaces no identity');
  }
  if (body.history !== undefined) {
    invalid('A first setup replaces no account key');
  }
  checkWrapTargets(list.head, wraps);
  checkCompleteWraps(list.head, wraps, { identity: true });
  if (await currentIdentity(db, userId)) {
    refuse(409, 'E2EE_ALREADY_SET_UP', 'Encryption keys are already set up.');
  }
  const written = await writeGeneration(db, userId, {
    generation: 1,
    identityKeyText: body.identityKey as string,
    entryText,
    signatureText,
    entryHash: toHex(list.headHash),
    wraps,
    transition: null,
    previousHead: null,
    history: null
  });
  if (!written) {
    refuse(409, 'E2EE_ALREADY_SET_UP', 'Encryption keys are already set up.');
  }
  return loadAccount(db, userId);
}

async function handleReplaceIdentity(
  db: WriteDatabase,
  userId: string,
  body: Record<string, unknown>
): Promise<E2eeAccountResponse> {
  const generation = body.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 2) {
    invalid('generation must follow the current one');
  }
  const identityKey = bytesField(body.identityKey, 'identityKey', {
    exact: 65
  });
  const { signed, entryText, signatureText } = signedEntryOf(body);
  const wraps = parseWraps(body.wraps);
  const transitionBody = record(body.transition, 'transition');
  const transition = {
    statement: bytesField(transitionBody.statement, 'transition.statement', {
      max: 384
    }),
    signature: bytesField(transitionBody.signature, 'transition.signature', {
      exact: 65
    })
  };
  const current = await currentIdentity(db, userId);
  if (!current) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  if (current.generation + 1 !== generation) {
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  const list = await verifiedChain(identityKey, [signed]);
  if (list.userId !== userId) invalid('The device list is for another user');
  const oldIdentityKey = fromBase64Url(current.identity_key);
  const oldIdentityHash = await publicKeyHash(oldIdentityKey);
  if (
    !list.head.previousIdentityKeyHash ||
    toHex(list.head.previousIdentityKeyHash) !== toHex(oldIdentityHash)
  ) {
    invalid('The new device list must name the identity it replaces');
  }
  checkWrapTargets(list.head, wraps);
  checkCompleteWraps(list.head, wraps, { identity: true });
  // The transition is signed by the old identity or a device it certified.
  // It proves nothing to contacts, but the Worker refuses a replacement from
  // a browser that holds neither.
  let decoded;
  try {
    decoded = decodeIdentityTransition(transition.statement);
  } catch (error) {
    if (error instanceof E2eeError) refuseKeys(error);
    throw error;
  }
  if (
    decoded.userId !== userId ||
    toHex(decoded.oldIdentityKeyHash) !== toHex(oldIdentityHash) ||
    toHex(decoded.newIdentityKey) !== toHex(identityKey) ||
    toHex(decoded.newGenesisHash) !== toHex(list.headHash)
  ) {
    invalid('The identity transition does not describe this replacement');
  }
  // Verify the old list once, and bind the write to its head below.
  const oldList = await verifiedChain(
    oldIdentityKey,
    (await entryRows(db, userId, current.generation)).map(toSigned)
  );
  // The new account key must carry the replaced identity's current one.
  const history = parseHistory(body.history, {
    generation: current.generation,
    keySequence: accountKeySequence(oldList)
  });
  let signerKey: Uint8Array | undefined;
  if (decoded.signer === 'identity') {
    signerKey = oldIdentityKey;
  } else {
    signerKey = oldList.devices.find(
      (d) => toHex(d.signingKeyHash) === toHex(decoded.signerKeyHash)
    )?.signingKey;
  }
  if (!signerKey) {
    refuse(
      403,
      'E2EE_TRANSITION_UNAUTHORIZED',
      'Only the old identity or one of its devices can replace it.'
    );
  }
  try {
    await verifyIdentityTransition(transition, signerKey);
  } catch (error) {
    if (error instanceof E2eeError) {
      refuse(
        403,
        'E2EE_TRANSITION_UNAUTHORIZED',
        'Only the old identity or one of its devices can replace it.'
      );
    }
    throw error;
  }
  const signerFence = await projectSignerFence(db, userId, [
    ...removedDevices(oldList.devices, list.head.devices),
    // Devices already revoked in this generation: their cutoffs name this
    // generation's list, which the new genesis no longer carries.
    ...oldList.revoked
      .filter((revoked) => revoked.kind === 'device')
      .map((revoked) => revoked.id)
  ]);
  const written = await writeGeneration(db, userId, {
    generation: generation,
    identityKeyText: body.identityKey as string,
    entryText,
    signatureText,
    entryHash: toHex(list.headHash),
    wraps,
    transition: {
      statement: transitionBody.statement as string,
      signature: transitionBody.signature as string
    },
    previousHead: {
      sequence: oldList.head.sequence,
      entryHash: toHex(oldList.headHash)
    },
    history,
    fence: signerFence
  });
  if (!written) {
    await refuseIfSigned(db, signerFence);
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  return loadAccount(db, userId);
}

export const E2EE_DEVICE_SIGNED_PROJECTS_CODE = 'E2EE_DEVICE_SIGNED_PROJECTS';

/**
 * Devices of `before` that `after` no longer lists with the same signing
 * key: what they signed no longer resolves to a listed device.
 */
function removedDevices(
  before: readonly { deviceId: string; signingKey: Uint8Array }[],
  after: readonly { deviceId: string; signingKey: Uint8Array }[]
): string[] {
  return before
    .filter(
      (device) =>
        !after.some(
          (d) =>
            d.deviceId === device.deviceId &&
            toHex(d.signingKey) === toHex(device.signingKey)
        )
    )
    .map((device) => device.deviceId);
}

/**
 * A recovery-key replacement starts a new device list whose genesis lists
 * only the devices it keeps. Revocation cutoffs (device removal) name
 * devices revoked within one list, so a device the new genesis drops that
 * signed a version, envelope or key archive of one of the account's
 * encrypted projects keeps the replacement from landing: browsers could no
 * longer resolve what it signed. A device that signed nothing is dropped as
 * before.
 * Nothing to check before migration 0033.
 *
 * A plaintext project staged for encryption (slice 7-1, migration 0042)
 * counts as encrypted here: its staged versions, project info and key
 * archives become the encrypted project at the cutover, which checks no
 * signer itself, so a replacement that drops their signer would leave the
 * migrated project unreadable. An abandoned staging is never cut over.
 *
 * Returns a fence for the identity write itself, so a version such a
 * device signs meanwhile makes the write refuse; encrypted writes, staged
 * ones included, are fenced on the device list in turn
 * (`deviceListUnchanged`).
 */
async function projectSignerFence(
  db: D1Database,
  userId: string,
  removedDeviceIds: readonly string[]
): Promise<{ sql: string; binds: string[] }> {
  if (
    removedDeviceIds.length === 0 ||
    !(await isE2eeProjectVersionStorageReady(db))
  ) {
    return { sql: '1 = 1', binds: [] };
  }
  const staged = (await isE2eeProjectMigrationStorageReady(db))
    ? ` OR ${STAGED_FOR_ENCRYPTION_SQL}`
    : '';
  const fence = signedProjectsFence(
    userId,
    `p.storage_format = 2${staged}`,
    removedDeviceIds
  );
  await refuseIfSigned(db, fence);
  return fence;
}

/** A project `p` with a live 'encrypt' staging (migration 0042). */
const STAGED_FOR_ENCRYPTION_SQL = `EXISTS (SELECT 1 FROM e2ee_project_migrations m
                   WHERE m.project_id = p.id AND m.direction = 'encrypt'
                     AND m.state = 'staging')`;

/**
 * Holds while no project `p` of the user matching `projects` has a
 * version, envelope or key archive signed by one of `deviceIds`.
 */
function signedProjectsFence(
  userId: string,
  projects: string,
  deviceIds: readonly string[]
): { sql: string; binds: string[] } {
  const marks = deviceIds.map(() => '?').join(', ');
  return {
    sql: `NOT EXISTS (SELECT 1 FROM projects p
       WHERE p.user_id = ? AND (${projects})
         AND (EXISTS (SELECT 1 FROM e2ee_project_versions v
                      WHERE v.project_id = p.id
                        AND v.signer_device_id IN (${marks}))
           OR EXISTS (SELECT 1 FROM e2ee_project_envelopes e
                      WHERE e.project_id = p.id
                        AND e.signer_device_id IN (${marks}))
           OR EXISTS (SELECT 1 FROM e2ee_key_archives a
                      WHERE a.project_id = p.id
                        AND a.signer_device_id IN (${marks}))))`,
    binds: [userId, ...deviceIds, ...deviceIds, ...deviceIds]
  };
}

/**
 * An ordinary device revocation lands with a cutoff statement naming every
 * encrypted (format-2) project (`appendedRevocationCutoffs`), but a
 * plaintext project staged for encryption is not one yet, so no cutoff can
 * name it, and the cutover checks no signer: a device revoked after it
 * signed a staged version, project info or key archive would leave the
 * migrated project holding records by a revoked signer without a cutoff,
 * which browsers refuse. So such a revocation waits until the staging is
 * cut over (its project is then format 2 and gets a cutoff) or abandoned.
 * A device that signed nothing staged is revoked as before.
 *
 * Returns a fence for the device-list entry's insert. `signed` refuses a
 * record the device stages meanwhile; staged writes are fenced on the
 * device list in turn (`deviceListUnchanged`). `encrypted` holds while the
 * account owns as many format-2 projects as when checked, so a cutover
 * landing in between, which the cutoffs' own fence misses when there were
 * none to name, makes the append refuse and the browser sign cutoffs
 * again. Nothing to check before migration 0042.
 */
async function stagedSignerFence(
  db: D1Database,
  userId: string,
  revokedDeviceIds: readonly string[]
): Promise<{
  sql: string;
  binds: (string | number)[];
  signed: { sql: string; binds: string[] };
  moved(): Promise<boolean>;
}> {
  if (
    revokedDeviceIds.length === 0 ||
    !(await isE2eeProjectVersionStorageReady(db)) ||
    !(await isE2eeProjectMigrationStorageReady(db))
  ) {
    const clear = { sql: '1 = 1', binds: [] };
    return { ...clear, signed: clear, moved: async () => false };
  }
  const signed = signedProjectsFence(
    userId,
    STAGED_FOR_ENCRYPTION_SQL,
    revokedDeviceIds
  );
  await refuseIfSigned(db, signed, STAGED_SIGNER_MESSAGE);
  const countEncrypted = `(SELECT COUNT(*) FROM projects
                           WHERE user_id = ? AND storage_format = 2)`;
  const encrypted = async () =>
    (
      await db
        .prepare(`SELECT ${countEncrypted} AS n`)
        .bind(userId)
        .first<{ n: number }>()
    )?.n ?? 0;
  const checked = await encrypted();
  return {
    sql: `${signed.sql} AND ${countEncrypted} = ?`,
    binds: [...signed.binds, userId, checked],
    signed,
    moved: async () => (await encrypted()) !== checked
  };
}

const STAGED_SIGNER_MESSAGE =
  'This device helped encrypt a project that is still being encrypted. Finish or cancel that encryption, then remove the device. Nothing was changed.';

async function refuseIfSigned(
  db: D1Database,
  fence: { sql: string; binds: string[] },
  message = 'A device this change leaves out saved encrypted projects, and those projects would stop opening. This will be possible in a coming update.'
): Promise<void> {
  const clear = await db
    .prepare(`SELECT (${fence.sql}) AS clear`)
    .bind(...fence.binds)
    .first<{ clear: number }>();
  if (clear?.clear !== 1) {
    refuse(409, E2EE_DEVICE_SIGNED_PROJECTS_CODE, message);
  }
}

async function handleAppend(
  db: WriteDatabase,
  userId: string,
  body: Record<string, unknown>,
  projectsEnabled: boolean
): Promise<E2eeAccountResponse> {
  const { signed, entryText, signatureText } = signedEntryOf(body);
  const wraps = parseWraps(body.wraps);
  const current = await currentIdentity(db, userId);
  if (!current) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  if (body.generation !== current.generation) {
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  const rows = await entryRows(db, userId, current.generation);
  if (rows.length >= MAX_GENERATION_ENTRIES) {
    refuse(
      409,
      'E2EE_DEVICE_LIST_FULL',
      'This device list is full. Replace the recovery key to start a new one.'
    );
  }
  const identityKey = fromBase64Url(current.identity_key);
  const before = rows.at(-1)!;
  const incoming = decodeOrRefuse(signed.entry);
  if (incoming.sequence !== before.sequence + 1) {
    refuse(
      409,
      'E2EE_DEVICE_LIST_CONFLICT',
      'The device list changed meanwhile. Reload and try again.'
    );
  }
  const list = await verifiedChain(identityKey, [
    ...rows.map(toSigned),
    signed
  ]);
  const previous = list.entries.at(-2)!.entry;
  const rotation =
    toHex(previous.accountKeyCommitment) !==
    toHex(list.head.accountKeyCommitment);
  const newTargets = list.head.unlockTargets.filter(
    (target) =>
      !previous.unlockTargets.some((t) => t.targetId === target.targetId)
  );
  checkWrapTargets(list.head, wraps);
  let history: E2eeAccountKeyHistoryInput | null = null;
  if (rotation) {
    checkCompleteWraps(list.head, wraps, { identity: false });
    history = parseHistory(body.history, {
      generation: current.generation,
      keySequence: accountKeySequence(list, previous.sequence)
    });
  } else {
    if (wraps.some((w) => w.purpose === 'encryption-key')) {
      invalid('Only a rotation replaces the encryption key wrap');
    }
    if (body.history !== undefined) {
      invalid('Only a rotation replaces the account key');
    }
  }
  for (const target of newTargets) {
    for (const purpose of [
      'account-key',
      'identity-key',
      'unlock-target-key'
    ] as const) {
      if (
        !wraps.some(
          (w) => w.purpose === purpose && w.targetId === target.targetId
        )
      ) {
        invalid(`A new unlock target requires ${purpose}`);
      }
    }
  }
  if (
    wraps.some(
      (w) =>
        (w.purpose === 'identity-key' || w.purpose === 'unlock-target-key') &&
        !newTargets.some((target) => target.targetId === w.targetId)
    )
  ) {
    invalid(
      'Only a new unlock target may supply identity and target-key wraps'
    );
  }
  const newDevices = list.head.devices.filter(
    (device) => !previous.devices.some((d) => d.deviceId === device.deviceId)
  );
  for (const device of newDevices) {
    if (
      !wraps.some(
        (w) => w.purpose === 'account-key' && w.targetId === device.deviceId
      )
    ) {
      invalid(`The account key is not sealed to ${device.deviceId}`);
    }
  }
  // A device revocation lands with its signed cutoff statement, or not at
  // all, for an account with encrypted projects (e2eeDeviceRemoval.ts).
  const cutoffs = await appendedRevocationCutoffs(
    db,
    userId,
    current.generation,
    list,
    body.cutoffs,
    projectsEnabled
  );
  // Nor while a device it revokes signed a project staged for encryption,
  // which no cutoff can name yet (`stagedSignerFence`).
  const stagedFence = await stagedSignerFence(
    db,
    userId,
    list.head.revoked
      .filter((revocation) => revocation.kind === 'device')
      .map((revocation) => revocation.id)
  );
  const now = new Date().toISOString();
  const entryHash = toHex(list.headHash);
  const auth = db.authorization;
  const guard = {
    sql: `EXISTS (SELECT 1 FROM e2ee_device_list_entries
                  WHERE user_id = ? AND generation = ? AND sequence = ?
                    AND entry_hash = ?) AND ${auth.sql}`,
    binds: [
      userId,
      current.generation,
      list.head.sequence,
      entryHash,
      ...auth.binds
    ]
  };
  const revokedIds = list.head.revoked.map((r) => r.id);
  // The projects its cutoffs were checked against must not move before
  // the batch runs; nothing lands if they did.
  const projectsFence = cutoffs?.fence ?? { sql: '1', binds: [] };
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO e2ee_device_list_entries
           (user_id, generation, sequence, entry, signature, entry_hash, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE ${auth.sql} AND (SELECT MAX(sequence) FROM e2ee_device_list_entries
                WHERE user_id = ? AND generation = ?) = ?
           AND (SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?) = ?
           AND ${projectsFence.sql} AND ${stagedFence.sql}`
      )
      .bind(
        userId,
        current.generation,
        list.head.sequence,
        entryText,
        signatureText,
        entryHash,
        now,
        ...auth.binds,
        userId,
        current.generation,
        before.sequence,
        userId,
        current.generation,
        ...projectsFence.binds,
        ...stagedFence.binds
      ),
    ...(rotation
      ? [
          // A rotation replaces every wrap of the old account key, so a
          // removed device or target keeps none.
          db
            .prepare(
              `DELETE FROM e2ee_key_wraps
               WHERE user_id = ? AND generation = ?
                 AND purpose IN ('account-key', 'account-key-approval', 'encryption-key')
                 AND ${guard.sql}`
            )
            .bind(userId, current.generation, ...guard.binds)
        ]
      : []),
    ...revokedIds.map((id) =>
      db
        .prepare(
          `DELETE FROM e2ee_key_wraps
           WHERE user_id = ? AND generation = ? AND target_id = ? AND ${guard.sql}`
        )
        .bind(userId, current.generation, id, ...guard.binds)
    ),
    // A device certified now no longer needs its read-only approval wrap.
    ...newDevices.map((device) =>
      db
        .prepare(
          `DELETE FROM e2ee_key_wraps
           WHERE user_id = ? AND generation = ? AND purpose = 'account-key-approval'
             AND target_id = ? AND ${guard.sql}`
        )
        .bind(userId, current.generation, device.deviceId, ...guard.binds)
    ),
    ...wraps.map((wrap) =>
      insertWrap(
        db,
        userId,
        current.generation,
        list.head.sequence,
        wrap,
        now,
        guard
      )
    ),
    ...(history ? [insertHistory(db, userId, history, now, guard)] : []),
    ...(cutoffs ? [cutoffs.insert(guard, now)] : [])
  ];
  const results = await db.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // A project created, shared, committed to or saved to since the
    // cutoffs were checked, or one cut over to encrypted storage: the
    // browser signs them again.
    if ((await cutoffs?.moved()) || (await stagedFence.moved())) {
      refuseCutoffsIncomplete();
    }
    // Or a record the revoked device staged since the check.
    await refuseIfSigned(db, stagedFence.signed, STAGED_SIGNER_MESSAGE);
    refuse(
      409,
      'E2EE_DEVICE_LIST_CONFLICT',
      'The device list changed meanwhile. Reload and try again.'
    );
  }
  return loadAccount(db, userId);
}

function decodeOrRefuse(entry: Uint8Array): DeviceListEntry {
  try {
    return decodeDeviceListEntry(entry);
  } catch (error) {
    if (error instanceof E2eeError) refuseKeys(error);
    throw error;
  }
}

// --- Device approval ------------------------------------------------------

interface ApprovalRow {
  id: string;
  device_id: string;
  label: string;
  signing_key: string;
  unlock_key: string;
  commitment: string | null;
  approver_key: string | null;
  approver_nonce: string | null;
  device_nonce: string | null;
  grant_statement: string | null;
  grant_signature: string | null;
  state: E2eeApprovalState;
  created_at: string;
  expires_at: string;
}

const APPROVAL_COLUMNS = `id, device_id, label, signing_key, unlock_key,
  commitment, approver_key, approver_nonce, device_nonce, grant_statement,
  grant_signature, state, created_at, expires_at`;

function approvalRecord(row: ApprovalRow): E2eeApprovalRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    label: row.label,
    signingKey: row.signing_key,
    unlockKey: row.unlock_key,
    commitment: row.commitment,
    approverKey: row.approver_key,
    approverNonce: row.approver_nonce,
    deviceNonce: row.device_nonce,
    grant:
      row.grant_statement && row.grant_signature
        ? { statement: row.grant_statement, signature: row.grant_signature }
        : null,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function isApprovalLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 64 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

async function p256(
  value: Uint8Array,
  kind: 'ECDH' | 'ECDSA',
  what: string
): Promise<void> {
  try {
    await (kind === 'ECDH'
      ? importEncryptionPublicKey(value)
      : importSigningPublicKey(value));
  } catch {
    invalid(`${what} is not a P-256 public key`);
  }
}

async function approvalRow(
  db: D1Database,
  userId: string,
  id: string,
  now: string
): Promise<ApprovalRow> {
  const row = await db
    .prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM e2ee_device_approvals
       WHERE id = ? AND user_id = ? AND expires_at > ?`
    )
    .bind(id, userId, now)
    .first<ApprovalRow>();
  if (!row) {
    refuse(
      404,
      'E2EE_APPROVAL_NOT_FOUND',
      'This approval request has expired.'
    );
  }
  return row;
}

function randomApprovalId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `apr_${toHex(bytes)}`;
}

async function handleCreateApproval(
  db: WriteDatabase,
  userId: string,
  body: Record<string, unknown>
): Promise<E2eeApprovalRecord> {
  if (!isId(body.deviceId)) invalid('deviceId is not an id');
  if (!isApprovalLabel(body.label))
    invalid('label must be 1..64 bytes of text');
  const signingKey = bytesField(body.signingKey, 'signingKey', { exact: 65 });
  const unlockKey = bytesField(body.unlockKey, 'unlockKey', { exact: 65 });
  await p256(signingKey, 'ECDSA', 'signingKey');
  await p256(unlockKey, 'ECDH', 'unlockKey');
  if (toHex(signingKey) === toHex(unlockKey)) {
    invalid('The signing and unlock keys must differ');
  }
  const commitment =
    body.commitment === undefined
      ? null
      : (bytesField(body.commitment, 'commitment', { exact: 32 }),
        body.commitment as string);
  if (!(await currentIdentity(db, userId))) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(
      `DELETE FROM e2ee_device_approvals WHERE user_id = ? AND created_at < ?
         AND NOT (state = 'completed' AND EXISTS (
           SELECT 1 FROM e2ee_key_wraps w
           WHERE w.user_id = e2ee_device_approvals.user_id
             AND w.target_id = e2ee_device_approvals.device_id
             AND w.purpose = 'account-key-approval'
         ) AND NOT EXISTS (
           SELECT 1 FROM e2ee_device_approvals newer
           WHERE newer.user_id = e2ee_device_approvals.user_id
             AND newer.device_id = e2ee_device_approvals.device_id
             AND newer.state = 'completed'
             AND (newer.created_at > e2ee_device_approvals.created_at
               OR (newer.created_at = e2ee_device_approvals.created_at
                 AND newer.id > e2ee_device_approvals.id))
         )) AND ${db.authorization.sql}`
    )
    .bind(
      userId,
      new Date(nowMs - APPROVAL_RETENTION_MS).toISOString(),
      ...db.authorization.binds
    )
    .run();
  const counts = await db
    .prepare(
      `SELECT
         COUNT(*) AS recent,
         SUM(state <> 'completed' AND expires_at > ?) AS open
       FROM e2ee_device_approvals WHERE user_id = ? AND created_at >= ?`
    )
    .bind(now, userId, new Date(nowMs - APPROVAL_RETENTION_MS).toISOString())
    .first<{ recent: number; open: number | null }>();
  if ((counts?.open ?? 0) >= MAX_OPEN_APPROVALS) {
    refuse(
      429,
      'E2EE_APPROVAL_RATE_LIMITED',
      'Too many devices are waiting for approval. Finish or cancel one first.'
    );
  }
  if ((counts?.recent ?? 0) >= MAX_APPROVALS_PER_HOUR) {
    refuse(
      429,
      'E2EE_APPROVAL_RATE_LIMITED',
      'Too many approval requests this hour. Try again later.'
    );
  }
  const id = randomApprovalId();
  const inserted = await db
    .prepare(
      `INSERT INTO e2ee_device_approvals
         (id, user_id, device_id, label, signing_key, unlock_key, commitment,
          state, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ? WHERE ${db.authorization.sql}
         AND (SELECT COUNT(*) FROM e2ee_device_approvals
              WHERE user_id = ? AND state <> 'completed' AND expires_at > ?) < ?
         AND (SELECT COUNT(*) FROM e2ee_device_approvals
              WHERE user_id = ? AND created_at >= ?) < ?`
    )
    .bind(
      id,
      userId,
      body.deviceId,
      body.label,
      body.signingKey,
      body.unlockKey,
      commitment,
      now,
      new Date(nowMs + APPROVAL_TTL_MS).toISOString(),
      ...db.authorization.binds,
      userId,
      now,
      MAX_OPEN_APPROVALS,
      userId,
      new Date(nowMs - APPROVAL_RETENTION_MS).toISOString(),
      MAX_APPROVALS_PER_HOUR
    )
    .run();
  if ((inserted.meta?.changes ?? 0) !== 1) {
    refuse(
      429,
      'E2EE_APPROVAL_RATE_LIMITED',
      'Too many approval requests. Finish or cancel one, or try again later.'
    );
  }
  return approvalRecord(await approvalRow(db, userId, id, now));
}

async function moveApproval(
  db: WriteDatabase,
  userId: string,
  id: string,
  update: { set: string; binds: unknown[]; from: E2eeApprovalState[] },
  extraWhere = ''
): Promise<E2eeApprovalRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE e2ee_device_approvals SET ${update.set}
       WHERE id = ? AND user_id = ? AND expires_at > ?
         AND state IN (${update.from.map(() => '?').join(', ')}) ${extraWhere} AND ${db.authorization.sql}`
    )
    .bind(
      ...update.binds,
      id,
      userId,
      now,
      ...update.from,
      ...db.authorization.binds
    )
    .run();
  if ((result.meta?.changes ?? 0) !== 1) {
    await approvalRow(db, userId, id, now);
    refuse(
      409,
      'E2EE_APPROVAL_STATE',
      'This approval request has moved on. Reload it.'
    );
  }
  return approvalRecord(await approvalRow(db, userId, id, now));
}

async function handleCompleteApproval(
  db: WriteDatabase,
  userId: string,
  id: string,
  body: Record<string, unknown>
): Promise<E2eeApprovalRecord> {
  const now = new Date().toISOString();
  const row = await approvalRow(db, userId, id, now);
  const grantBody = record(body.grant, 'grant');
  const statement = bytesField(grantBody.statement, 'grant.statement', {
    max: 384
  });
  const signature = bytesField(grantBody.signature, 'grant.signature', {
    exact: 65
  });
  const sealed =
    body.sealedAccountKey === undefined
      ? null
      : (bytesField(body.sealedAccountKey, 'sealedAccountKey', { max: 512 }),
        body.sealedAccountKey as string);
  const current = await currentIdentity(db, userId);
  if (!current) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  const list = await verifiedChain(
    fromBase64Url(current.identity_key),
    (await entryRows(db, userId, current.generation)).map(toSigned)
  );
  let grant;
  try {
    grant = decodeDeviceApprovalGrant(statement);
  } catch (error) {
    if (error instanceof E2eeError) refuseKeys(error);
    throw error;
  }
  const keysHash = await deviceKeysHash(
    fromBase64Url(row.signing_key),
    fromBase64Url(row.unlock_key)
  );
  if (
    grant.userId !== userId ||
    grant.deviceId !== row.device_id ||
    toHex(grant.deviceKeysHash) !== toHex(keysHash) ||
    toHex(grant.identityKeyHash) !== toHex(list.identityKeyHash)
  ) {
    invalid('The grant does not describe this approval');
  }
  const approver = list.devices.find(
    (d) => toHex(d.signingKeyHash) === toHex(grant.approverKeyHash)
  );
  if (!approver) {
    refuse(
      403,
      'E2EE_APPROVER_UNKNOWN',
      'Only a device in the current device list can approve.'
    );
  }
  try {
    await verifyDeviceApprovalGrant(
      { statement, signature },
      approver.signingKey
    );
  } catch (error) {
    if (error instanceof E2eeError) {
      refuse(403, 'E2EE_APPROVER_UNKNOWN', 'The grant signature is not valid.');
    }
    throw error;
  }
  const certifiedHere = list.devices.some(
    (d) =>
      d.deviceId === row.device_id &&
      toBase64Url(d.signingKey) === row.signing_key &&
      toBase64Url(d.unlockKey) === row.unlock_key
  );
  if (grant.certified !== certifiedHere) {
    invalid(
      grant.certified
        ? 'The grant claims a certification the device list does not hold'
        : 'The device is already certified'
    );
  }
  if (grant.certified === (sealed !== null)) {
    invalid(
      grant.certified
        ? 'A certified device opens its own account-key wrap'
        : 'An uncertified approval carries the sealed account key'
    );
  }
  if (
    grant.headSequence !== list.head.sequence ||
    toHex(grant.headHash) !== toHex(list.headHash)
  ) {
    refuse(
      409,
      'E2EE_DEVICE_LIST_CONFLICT',
      'The device list changed meanwhile. Reload and try again.'
    );
  }
  const statementText = grantBody.statement as string;
  // Preserve accepted equivalent encodings of an already-stored point. New
  // responders are stored canonically; the predicate also covers a compare
  // flow starting after we read a requested scan approval.
  const sameResponder =
    row.approver_key !== null &&
    toHex(fromBase64Url(row.approver_key)) === toHex(approver.signingKey);
  const responderKey = sameResponder
    ? row.approver_key
    : toBase64Url(approver.signingKey);
  const readOnlyCount = sealed
    ? await db
        .prepare(
          `
    SELECT COUNT(*) AS count, COALESCE(MAX(CASE WHEN target_id = ? THEN 1 ELSE 0 END), 0) AS existing
    FROM e2ee_key_wraps WHERE user_id = ? AND generation = ? AND purpose = 'account-key-approval'
  `
        )
        .bind(row.device_id, userId, current.generation)
        .first<{ count: number; existing: number }>()
    : null;
  if (
    readOnlyCount &&
    !readOnlyCount.existing &&
    readOnlyCount.count >= MAX_READ_ONLY_DEVICES
  ) {
    refuse(
      409,
      'E2EE_READ_ONLY_DEVICE_LIMIT',
      `At most ${MAX_READ_ONLY_DEVICES} read-only devices can share this account key. Certify or revoke existing devices before approving another.`
    );
  }
  const readOnlyGuard = sealed
    ? {
        sql: `(EXISTS (SELECT 1 FROM e2ee_key_wraps WHERE user_id = ? AND generation = ?
                   AND purpose = 'account-key-approval' AND target_id = ?)
           OR (SELECT COUNT(*) FROM e2ee_key_wraps WHERE user_id = ? AND generation = ?
                   AND purpose = 'account-key-approval') < ?)`,
        binds: [
          userId,
          current.generation,
          row.device_id,
          userId,
          current.generation,
          MAX_READ_ONLY_DEVICES
        ]
      }
    : { sql: '1 = 1', binds: [] };
  const headGuard = {
    sql: `(SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?) = ?
      AND (SELECT entry_hash FROM e2ee_device_list_entries WHERE user_id = ?
           ORDER BY generation DESC, sequence DESC LIMIT 1) = ?`,
    binds: [userId, current.generation, userId, toHex(list.headHash)]
  };
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE e2ee_device_approvals
         SET state = 'completed', grant_statement = ?, grant_signature = ?
         WHERE id = ? AND user_id = ? AND expires_at > ?
           AND state IN ('requested', 'revealed')
           AND ((state = 'revealed' AND approver_key = ?)
                OR (state = 'requested' AND (commitment IS NULL OR approver_key IS NULL)))
           AND ${headGuard.sql} AND ${readOnlyGuard.sql} AND ${db.authorization.sql}`
      )
      .bind(
        statementText,
        grantBody.signature,
        id,
        userId,
        now,
        responderKey,
        ...headGuard.binds,
        ...readOnlyGuard.binds,
        ...db.authorization.binds
      )
  ];
  if (sealed) {
    statements.push(
      insertWrap(
        db,
        userId,
        current.generation,
        list.head.sequence,
        {
          purpose: 'account-key-approval',
          targetId: row.device_id,
          wrapped: sealed
        },
        now,
        {
          // D1 executes this batch in one transaction. As in the persistence
          // adapter, changes() binds the child write to its preceding UPDATE,
          // including duplicate grants that already have a completed row.
          sql: `changes() = 1 AND EXISTS (SELECT 1 FROM e2ee_device_approvals
                        WHERE id = ? AND user_id = ? AND state = 'completed' AND grant_statement = ?)
                        AND ${headGuard.sql} AND ${readOnlyGuard.sql} AND ${db.authorization.sql}`,
          binds: [
            id,
            userId,
            statementText,
            ...headGuard.binds,
            ...readOnlyGuard.binds,
            ...db.authorization.binds
          ]
        }
      )
    );
  }
  const results = await db.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    refuse(
      409,
      'E2EE_APPROVAL_STATE',
      'This approval request has moved on. Reload it.'
    );
  }
  return approvalRecord(await approvalRow(db, userId, id, now));
}

/** A path segment as an approval id; anything malformed is simply unknown. */
function approvalIdOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    refuse(
      404,
      'E2EE_APPROVAL_NOT_FOUND',
      'This approval request has expired.'
    );
  }
}

const APPROVALS_ROUTE = /^\/api\/e2ee\/approvals\/([^/]+)$/;
const APPROVAL_ACTION_ROUTE =
  /^\/api\/e2ee\/approvals\/([^/]+)\/(respond|reveal|complete)$/;

/** Cache only proven readiness, so a later migration needs no redeploy. */
const readyDatabases = new WeakSet<D1Database>();

/**
 * Which E2EE key tables D1 holds: `missing` before migration 0029,
 * `keys-only` with 0029 but not 0030 (the account-key history), `ready`
 * with both. Any other answer is refused, so erasure never omits rows it
 * cannot see.
 */
export type E2eeKeyStorage = 'missing' | 'keys-only' | 'ready';

/** Every E2EE key table, children before parents, for erasure. */
export const E2EE_KEY_TABLES = Object.freeze([
  'e2ee_account_key_history',
  'e2ee_key_wraps',
  'e2ee_device_list_entries',
  'e2ee_identities',
  'e2ee_device_approvals'
] as const);

export async function e2eeKeyStorage(db: D1Database): Promise<E2eeKeyStorage> {
  if (readyDatabases.has(db)) return 'ready';
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS tables,
              COALESCE(SUM(name = 'e2ee_account_key_history'), 0) AS history
         FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'e2ee_identities', 'e2ee_device_list_entries',
           'e2ee_key_wraps', 'e2ee_device_approvals',
           'e2ee_account_key_history'
         )`
    )
    .first<{ tables: number; history: number }>();
  // Only a successful count of zero proves there is no E2EE profile data.
  // Unknown or partial readiness must not let erasure omit existing key rows.
  if (row?.tables === 0) return 'missing';
  if (row?.tables === 4 && row.history === 0) return 'keys-only';
  if (row?.tables !== 5 || row.history !== 1) {
    refuse(
      503,
      'E2EE_UNAVAILABLE',
      'Encryption key storage readiness could not be determined.'
    );
  }
  readyDatabases.add(db);
  return 'ready';
}

/** True only when every key table, the account-key history included, exists. */
export async function isE2eeKeyStorageReady(db: D1Database): Promise<boolean> {
  return (await e2eeKeyStorage(db)) === 'ready';
}

/** The key tables erasure must clear, children first; none before 0029. */
export async function e2eeErasureTables(
  db: D1Database
): Promise<readonly string[]> {
  const storage = await e2eeKeyStorage(db);
  if (storage === 'missing') return [];
  return storage === 'ready'
    ? E2EE_KEY_TABLES
    : E2EE_KEY_TABLES.filter((table) => table !== 'e2ee_account_key_history');
}

/**
 * Handles `/api/e2ee/*` for an authenticated session. `enabled` is the
 * rollout decision for this account; `config` answers either way so the
 * browser can tell "off" from "unreachable". `projectsEnabled` is the
 * encrypted-projects decision (E2EE_PROJECTS_ENABLED, ADR-024 Phase 4),
 * reported disabled while migration 0031 is missing. `migrationEnabled`
 * is the decision to move plaintext projects to encrypted storage
 * (E2EE_MIGRATION_ENABLED, ADR-024 Phase 7), reported disabled while
 * migration 0042 is missing.
 */
/** Without a host, the invitation routes stay closed. */
const CLOSED_INVITATIONS: E2eeInvitationHost = {
  email: null,
  inviterLabel: '',
  sharingEnabled: false,
  emailConfigured: false,
  sendInvitationEmail: () =>
    Promise.reject(new Error('Invitation email is not configured.'))
};

export async function handleE2eeRequest(
  request: Request,
  env: E2eeRouteEnv,
  session: E2eeRouteSession,
  enabled: boolean,
  projectsEnabled = false,
  /** The invitation routes' email, sender and sharing rollout (5-3a). */
  invitations: E2eeInvitationHost = CLOSED_INVITATIONS,
  /** Moving plaintext projects to encrypted storage (slice 7-1). */
  migrationEnabled = false
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  let authorization: E2eeWriteAuthorization | null = null;
  try {
    if (pathname === '/api/e2ee/config' && method === 'GET') {
      const keysReady =
        enabled && Boolean(env.DB) && (await isE2eeKeyStorageReady(env.DB!));
      const projectsReady =
        keysReady &&
        projectsEnabled &&
        (await isE2eeProjectPreferenceStorageReady(env.DB)) &&
        // Encrypted projects need their MLS group tables (migration 0032)
        // and their version tables (migration 0033).
        (await isE2eeProjectGroupStorageReady(env.DB)) &&
        (await isE2eeProjectVersionStorageReady(env.DB));
      // Reported only once open, so a closed deployment answers as before.
      const migrationReady =
        projectsReady &&
        migrationEnabled &&
        (await isE2eeProjectMigrationStorageReady(env.DB));
      return json({
        enabled: keysReady,
        projectsEnabled: projectsReady,
        ...(migrationReady ? { migrationEnabled: true } : {})
      });
    }
    if (!enabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'End-to-end encryption is not available for this account yet.'
      );
    }
    const rawDb = database(env);
    if (!(await isE2eeKeyStorageReady(rawDb))) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Encryption keys are unavailable until the database is updated.'
      );
    }
    const userId = session.userId;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      authorization = await e2eeWriteAuthorization(
        request,
        session,
        env.AUTH_MODE === 'development' && env.ENVIRONMENT === 'development'
      );
      if (!authorization)
        refuse(
          401,
          'E2EE_SESSION_REQUIRED',
          'Sign in again before changing encryption keys.'
        );
    }
    const db: WriteDatabase = {
      prepare: (sql) => rawDb.prepare(sql),
      batch: (statements) => rawDb.batch(statements),
      authorization: authorization ?? {
        sql: '0',
        binds: [],
        dispose: async () => {}
      }
    };
    if (pathname === PROJECT_PREFERENCES_ROUTE) {
      if (!projectsEnabled) {
        refuse(
          501,
          'FEATURE_DISABLED',
          'Encrypted projects are not available for this account yet.'
        );
      }
      if (!(await isE2eeProjectPreferenceStorageReady(rawDb))) {
        refuse(
          503,
          'E2EE_UNAVAILABLE',
          'Encrypted projects are unavailable until the database is updated.'
        );
      }
      return await handleProjectPreferenceRequest(
        request,
        rawDb,
        userId,
        db.authorization,
        () => readBody(request)
      );
    }
    // Slice 7-1: the staging lease, only while migration is open.
    const migrationLease = migrationLeaseOf(request, migrationEnabled);
    if (isE2eeProjectMigrationPath(pathname)) {
      // Moving a plaintext project to encrypted storage.
      return await handleE2eeProjectMigrationRequest(
        request,
        env,
        userId,
        migrationEnabled,
        db.authorization,
        migrationLease
      );
    }
    if (isE2eeDeviceRemovalPath(pathname)) {
      // Revocation cutoffs and solo group resets (e2eeDeviceRemoval.ts).
      return await handleE2eeDeviceRemovalRequest(
        request,
        rawDb,
        userId,
        projectsEnabled,
        db.authorization
      );
    }
    if (isE2eeContactsPath(pathname)) {
      // Contacts lists and other people's device lists (e2eeContacts.ts).
      return await handleE2eeContactsRequest(
        request,
        rawDb,
        userId,
        db.authorization,
        () => readBody(request)
      );
    }
    if (isAssistantConsentPath(pathname)) {
      // Per-project assistant consent (e2eeAssistantConsents.ts, 6-1).
      if (!projectsEnabled) {
        refuse(
          501,
          'FEATURE_DISABLED',
          'Encrypted projects are not available for this account yet.'
        );
      }
      if (!(await isE2eeAssistantConsentStorageReady(rawDb))) {
        refuse(
          503,
          'E2EE_UNAVAILABLE',
          'The assistant on encrypted projects is unavailable until the database is updated.'
        );
      }
      return await handleAssistantConsentRequest(
        request,
        rawDb,
        userId,
        db.authorization,
        () => readBody(request)
      );
    }
    if (isE2eeContentBlobPath(pathname)) {
      // Encrypted content blobs (e2eeContentBlobs.ts).
      return await handleE2eeContentBlobRequest(
        request,
        env,
        userId,
        projectsEnabled,
        db.authorization,
        migrationLease
      );
    }
    if (isE2eeProjectDocumentPath(pathname)) {
      // Encrypted document versions (e2eeProjectDocuments.ts).
      return await handleE2eeProjectDocumentRequest(
        request,
        rawDb,
        projectBucket(env),
        userId,
        projectsEnabled,
        db.authorization,
        blobBucket(env),
        migrationLease
      );
    }
    if (isE2eeProjectEnvelopePath(pathname)) {
      // Encrypted measurements and view state (e2eeProjectEnvelopes.ts).
      return await handleE2eeProjectEnvelopeRequest(
        request,
        rawDb,
        userId,
        projectsEnabled,
        db.authorization,
        migrationLease
      );
    }
    if (isE2eeShareLinkPath(pathname)) {
      // Share links of encrypted projects and share delegations
      // (e2eeShareLinks.ts, slice 5-10).
      return await handleE2eeShareLinkRequest(
        request,
        rawDb,
        projectBucket(env),
        userId,
        projectsEnabled,
        invitations.sharingEnabled,
        db.authorization
      );
    }
    if (isE2eeInvitationPath(pathname)) {
      // Invitations, KeyPackages and Welcomes (e2eeInvitations.ts, 5-3a).
      return await handleE2eeInvitationRequest(
        request,
        rawDb,
        userId,
        projectsEnabled,
        db.authorization,
        invitations,
        () => readBody(request)
      );
    }
    if (isE2eeProjectPath(pathname)) {
      // Encrypted projects' MLS groups and key store (e2eeProjects.ts).
      return await handleE2eeProjectRequest(
        request,
        rawDb,
        userId,
        projectsEnabled,
        db.authorization,
        migrationLease
      );
    }
    if (pathname === '/api/e2ee/account' && method === 'GET') {
      return json(await loadAccount(db, userId));
    }
    if (pathname === '/api/e2ee/account-key-history' && method === 'GET') {
      // Only the session's own rows: wraps open nothing without the newer
      // account key, but another user's history is still not theirs to read.
      const { results } = await db
        .prepare(
          `SELECT generation, key_sequence, wrapped, created_at
           FROM e2ee_account_key_history WHERE user_id = ?
           ORDER BY generation, key_sequence`
        )
        .bind(userId)
        .all<{
          generation: number;
          key_sequence: number;
          wrapped: string;
          created_at: string;
        }>();
      return json({
        history: (results ?? []).map((row): E2eeAccountKeyHistoryRecord => ({
          generation: row.generation,
          keySequence: row.key_sequence,
          wrapped: row.wrapped,
          createdAt: row.created_at
        }))
      });
    }
    if (pathname === '/api/e2ee/setup' && method === 'POST') {
      return json(await handleSetup(db, userId, await readBody(request)), 201);
    }
    if (pathname === '/api/e2ee/device-list' && method === 'POST') {
      return json(
        await handleAppend(
          db,
          userId,
          // Room for a revocation's cutoff statement next to the entry.
          await readBody(request, MAX_BODY_BYTES + MAX_APPEND_CUTOFFS_CHARS),
          projectsEnabled
        )
      );
    }
    if (pathname === '/api/e2ee/identity' && method === 'POST') {
      return json(
        await handleReplaceIdentity(db, userId, await readBody(request))
      );
    }
    if (pathname === '/api/e2ee/approvals') {
      if (method === 'POST') {
        return json(
          await handleCreateApproval(db, userId, await readBody(request)),
          201
        );
      }
      if (method === 'GET') {
        const now = new Date().toISOString();
        const { results } = await db
          .prepare(
            `SELECT ${APPROVAL_COLUMNS} FROM e2ee_device_approvals
             WHERE user_id = ? AND expires_at > ? AND state <> 'completed'
             ORDER BY created_at`
          )
          .bind(userId, now)
          .all<ApprovalRow>();
        return json({ approvals: (results ?? []).map(approvalRecord) });
      }
    }
    const single = APPROVALS_ROUTE.exec(pathname);
    if (single) {
      const id = approvalIdOf(single[1]!);
      if (method === 'GET') {
        return json(
          approvalRecord(
            await approvalRow(db, userId, id, new Date().toISOString())
          )
        );
      }
      if (method === 'DELETE') {
        // Cancellation hides the request immediately but cannot refund the
        // hourly attempt budget. Normal retention pruning removes the receipt.
        await db
          .prepare(
            `UPDATE e2ee_device_approvals SET expires_at = MIN(expires_at, ?)
             WHERE id = ? AND user_id = ? AND ${db.authorization.sql}`
          )
          .bind(new Date().toISOString(), id, userId, ...db.authorization.binds)
          .run();
        return json({ ok: true });
      }
    }
    const action = APPROVAL_ACTION_ROUTE.exec(pathname);
    if (action && method === 'POST') {
      const id = approvalIdOf(action[1]!);
      const body = await readBody(request);
      if (action[2] === 'respond') {
        const approverKey = bytesField(body.approverKey, 'approverKey', {
          exact: 65
        });
        await p256(approverKey, 'ECDSA', 'approverKey');
        bytesField(body.approverNonce, 'approverNonce', { exact: 32 });
        return json(
          await moveApproval(
            db,
            userId,
            id,
            {
              set: `state = 'responded', approver_key = ?, approver_nonce = ?`,
              binds: [toBase64Url(approverKey), body.approverNonce],
              from: ['requested']
            },
            'AND commitment IS NOT NULL'
          )
        );
      }
      if (action[2] === 'reveal') {
        bytesField(body.nonce, 'nonce', { exact: 32 });
        return json(
          await moveApproval(db, userId, id, {
            set: `state = 'revealed', device_nonce = ?`,
            binds: [body.nonce],
            from: ['responded']
          })
        );
      }
      return json(await handleCompleteApproval(db, userId, id, body));
    }
    return refuse(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    if (error instanceof E2eeRouteError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof RouteError) {
      // A refusal of the shared project-route helpers (the cutoffs a
      // device-list append carries).
      return json(
        { error: error.message, code: error.code, ...error.extra },
        error.status
      );
    }
    throw error;
  } finally {
    await releaseDevelopmentE2eeWrite(session);
    if (env.AUTH_MODE !== 'development') await authorization?.dispose();
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
