/**
 * End-to-end encryption key routes (ADR-024 Phase 3, first slice; roadmap
 * L11). The Worker is a store and relay here: it keeps public keys,
 * identity-signed device-list entries, wrapped keys and the device-approval
 * exchange, and it never sees a secret key.
 *
 * It still checks what it can, as defense in depth: every chain it stores
 * verifies under the user's identity key, entries extend the stored head,
 * a rotation replaces every account-key wrap at once, and a setup carries
 * the wraps without which the account could not be unlocked again. Browsers
 * verify all of it themselves and never trust these checks.
 *
 * Closed unless `isE2eeKeysEnabled`; refused with 503 until migration 0029
 * is in D1.
 */
import {
  E2eeError,
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
  E2eeAccountResponse,
  E2eeApprovalRecord,
  E2eeApprovalState,
  E2eeIdentityRecord,
  E2eePreviousIdentityRecord,
  E2eeWrapInput,
  E2eeWrapPurpose,
  E2eeWrapRecord
} from '@openzcad/shared';

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

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
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
    if (size > MAX_BODY_BYTES) {
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
  const { results: identities } = await db
    .prepare(
      `SELECT generation, identity_key, transition_statement,
              transition_signature, created_at
       FROM e2ee_identities WHERE user_id = ?
       ORDER BY generation DESC LIMIT ?`
    )
    .bind(userId, PREVIOUS_GENERATIONS + 1)
    .all<IdentityRow>();
  const [current, ...previous] = identities ?? [];
  if (!current) return { current: null, previous: [] };
  const [entries, wraps] = await Promise.all([
    entryRows(db, userId, current.generation),
    db
      .prepare(
        `SELECT purpose, target_id, key_sequence, wrapped
         FROM e2ee_key_wraps WHERE user_id = ? AND generation = ?
         ORDER BY purpose, target_id`
      )
      .bind(userId, current.generation)
      .all<WrapRow>()
  ]);
  const previousRecords: E2eePreviousIdentityRecord[] = [];
  for (const row of previous) {
    const head = await db
      .prepare(
        `SELECT sequence, entry, signature, entry_hash
         FROM e2ee_device_list_entries
         WHERE user_id = ? AND generation = ?
         ORDER BY sequence DESC LIMIT 1`
      )
      .bind(userId, row.generation)
      .first<EntryRow>();
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
    wraps: (wraps.results ?? []).map((row): E2eeWrapRecord => ({
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
  db: D1Database,
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
  }
): Promise<boolean> {
  const now = new Date().toISOString();
  const previousHead = input.previousHead;
  const guard = {
    sql: `EXISTS (SELECT 1 FROM e2ee_identities
                  WHERE user_id = ? AND generation = ? AND identity_key = ?)`,
    binds: [userId, input.generation, input.identityKeyText]
  };
  const statements: D1PreparedStatement[] = [
    // A development or legacy session may predate its users row; every key
    // row hangs off it so it goes on erasure.
    db
      .prepare(
        `INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(userId, now),
    db
      .prepare(
        `INSERT INTO e2ee_identities
           (user_id, generation, identity_key, transition_statement,
            transition_signature, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (SELECT COALESCE(MAX(generation), 0) FROM e2ee_identities
                WHERE user_id = ?) = ?
           AND ${
             previousHead
               ? `(SELECT entry_hash FROM e2ee_device_list_entries
                   WHERE user_id = ? AND generation = ?
                   ORDER BY sequence DESC LIMIT 1) = ?
                  AND (SELECT MAX(sequence) FROM e2ee_device_list_entries
                       WHERE user_id = ? AND generation = ?) = ?`
               : '1 = 1'
           }`
      )
      .bind(
        userId,
        input.generation,
        input.identityKeyText,
        input.transition?.statement ?? null,
        input.transition?.signature ?? null,
        now,
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
          : [])
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
    // A replaced identity's wraps open nothing anyone should use again, and
    // pending approvals were for the old identity.
    db
      .prepare(
        `DELETE FROM e2ee_key_wraps
         WHERE user_id = ? AND generation < ? AND ${guard.sql}`
      )
      .bind(userId, input.generation, ...guard.binds),
    db
      .prepare(
        `DELETE FROM e2ee_device_approvals WHERE user_id = ? AND ${guard.sql}`
      )
      .bind(userId, ...guard.binds)
  ];
  const results = await db.batch(statements);
  return (results[1]?.meta?.changes ?? 0) === 1;
}

async function handleSetup(
  db: D1Database,
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
    previousHead: null
  });
  if (!written) {
    refuse(409, 'E2EE_ALREADY_SET_UP', 'Encryption keys are already set up.');
  }
  return loadAccount(db, userId);
}

async function handleReplaceIdentity(
  db: D1Database,
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
    }
  });
  if (!written) {
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  return loadAccount(db, userId);
}

async function handleAppend(
  db: D1Database,
  userId: string,
  body: Record<string, unknown>
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
  if (rotation) {
    checkCompleteWraps(list.head, wraps, { identity: false });
  } else if (wraps.some((w) => w.purpose === 'encryption-key')) {
    invalid('Only a rotation replaces the encryption key wrap');
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
  const now = new Date().toISOString();
  const entryHash = toHex(list.headHash);
  const guard = {
    sql: `EXISTS (SELECT 1 FROM e2ee_device_list_entries
                  WHERE user_id = ? AND generation = ? AND sequence = ?
                    AND entry_hash = ?)`,
    binds: [userId, current.generation, list.head.sequence, entryHash]
  };
  const revokedIds = list.head.revoked.map((r) => r.id);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO e2ee_device_list_entries
           (user_id, generation, sequence, entry, signature, entry_hash, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT MAX(sequence) FROM e2ee_device_list_entries
                WHERE user_id = ? AND generation = ?) = ?
           AND (SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?) = ?`
      )
      .bind(
        userId,
        current.generation,
        list.head.sequence,
        entryText,
        signatureText,
        entryHash,
        now,
        userId,
        current.generation,
        before.sequence,
        userId,
        current.generation
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
    )
  ];
  const results = await db.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
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
  db: D1Database,
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
      `DELETE FROM e2ee_device_approvals WHERE user_id = ? AND created_at < ?`
    )
    .bind(userId, new Date(nowMs - APPROVAL_RETENTION_MS).toISOString())
    .run();
  const counts = await db
    .prepare(
      `SELECT
         COUNT(*) AS recent,
         SUM(state <> 'completed' AND expires_at > ?) AS open
       FROM e2ee_device_approvals WHERE user_id = ?`
    )
    .bind(now, userId)
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
  await db
    .prepare(
      `INSERT INTO e2ee_device_approvals
         (id, user_id, device_id, label, signing_key, unlock_key, commitment,
          state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`
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
      new Date(nowMs + APPROVAL_TTL_MS).toISOString()
    )
    .run();
  return approvalRecord(await approvalRow(db, userId, id, now));
}

async function moveApproval(
  db: D1Database,
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
         AND state IN (${update.from.map(() => '?').join(', ')}) ${extraWhere}`
    )
    .bind(...update.binds, id, userId, now, ...update.from)
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
  db: D1Database,
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
  if (grant.headSequence !== list.head.sequence) {
    refuse(
      409,
      'E2EE_DEVICE_LIST_CONFLICT',
      'The device list changed meanwhile. Reload and try again.'
    );
  }
  const statementText = grantBody.statement as string;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE e2ee_device_approvals
         SET state = 'completed', grant_statement = ?, grant_signature = ?
         WHERE id = ? AND user_id = ? AND expires_at > ?
           AND state IN ('requested', 'revealed')
           AND (state = 'revealed' OR commitment IS NULL OR approver_key IS NULL)`
      )
      .bind(statementText, grantBody.signature, id, userId, now)
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
          sql: `EXISTS (SELECT 1 FROM e2ee_device_approvals
                        WHERE id = ? AND state = 'completed' AND grant_statement = ?)`,
          binds: [id, statementText]
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

export async function isE2eeKeyStorageReady(db: D1Database): Promise<boolean> {
  if (readyDatabases.has(db)) return true;
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS tables FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'e2ee_identities', 'e2ee_device_list_entries',
           'e2ee_key_wraps', 'e2ee_device_approvals'
         )`
      )
      .first<{ tables: number }>();
    const ready = row?.tables === 4;
    if (ready) readyDatabases.add(db);
    return ready;
  } catch {
    return false;
  }
}

/**
 * Handles `/api/e2ee/*` for an authenticated session. `enabled` is the
 * rollout decision for this account; `config` answers either way so the
 * browser can tell "off" from "unreachable".
 */
export async function handleE2eeRequest(
  request: Request,
  env: E2eeRouteEnv,
  session: E2eeRouteSession,
  enabled: boolean
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  try {
    if (pathname === '/api/e2ee/config' && method === 'GET') {
      return json({
        enabled:
          enabled && Boolean(env.DB) && (await isE2eeKeyStorageReady(env.DB!))
      });
    }
    if (!enabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'End-to-end encryption is not available for this account yet.'
      );
    }
    const db = database(env);
    if (!(await isE2eeKeyStorageReady(db))) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Encryption keys are unavailable until the database is updated.'
      );
    }
    const userId = session.userId;
    if (pathname === '/api/e2ee/account' && method === 'GET') {
      return json(await loadAccount(db, userId));
    }
    if (pathname === '/api/e2ee/setup' && method === 'POST') {
      return json(await handleSetup(db, userId, await readBody(request)), 201);
    }
    if (pathname === '/api/e2ee/device-list' && method === 'POST') {
      return json(await handleAppend(db, userId, await readBody(request)));
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
        await db
          .prepare(
            `DELETE FROM e2ee_device_approvals WHERE id = ? AND user_id = ?`
          )
          .bind(id, userId)
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
              binds: [body.approverKey, body.approverNonce],
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
    refuse(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    if (error instanceof E2eeRouteError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
