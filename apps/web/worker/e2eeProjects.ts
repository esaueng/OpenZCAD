/**
 * Encrypted projects' MLS groups (ADR-024 Phase 4, solo groups; roadmap
 * L11): the sequencer, the leaf registry and the project key store, under
 * `/api/e2ee/projects/:id/…`. The Worker is the Delivery Service here. It
 * picks the first Commit for each epoch and refuses the rest (RFC 9420 §14:
 * the loser rebases), keeps the newest GroupInfo for an owner device's
 * external Commit, and stores what the browsers wrapped, signed and
 * encrypted. It never sees a project key, a rejoin PSK or an MLS secret.
 *
 * It still checks what it can, as defense in depth: the sender is a device
 * the caller's newest device list certifies (a read-only approved device
 * holds no leaf, decision D4), every write names the epoch it builds on, a
 * Commit lands together with everything its new epoch needs (GroupInfo,
 * project key and rejoin PSK under the account key, key archive) in one D1
 * batch or not at all, and archives carry the key-archive header for this
 * project and epoch. Browsers verify all of it themselves.
 *
 * Served by `handleE2eeRequest`, which has applied the key rollout gate,
 * key-table readiness and, for writes, the session/erasure write
 * authorization. Here: E2EE_PROJECTS_ENABLED, migrations 0031 and 0032
 * (503 without them), owner only, format-2 projects only.
 */
import {
  decodeDeviceListEntry,
  fromBase64Url,
  parseEnvelope
} from '@openzcad/crypto';
import type {
  E2eeKeyArchiveRecord,
  E2eeKeyArchivesResponse,
  E2eeMlsCommitKind,
  E2eeMlsCommitRecord,
  E2eeMlsCommitResponse,
  E2eeMlsCommitsResponse,
  E2eeProjectGroupRecord,
  E2eeProjectGroupResponse,
  E2eeProjectKeyPurpose,
  E2eeProjectKeyWrap,
  E2eeProjectKeysResponse,
  E2eeProjectLeafInput,
  E2eeProjectLeafRecord,
  E2eeProjectLeavesResponse
} from '@openzcad/shared';
import {
  isE2eeProjectGroupStorageReady,
  isProjectStorageFormatReady
} from '@openzcad/cloudflare-adapters';

export const E2EE_PROJECT_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/(mls\/commits|mls\/group-info|mls\/leaves|keys|keys\/archives)$/;

/** True for any path under the encrypted-project prefix, known or not. */
export function isE2eeProjectPath(pathname: string): boolean {
  return pathname.startsWith('/api/e2ee/projects/');
}

/** Raw sizes (judgment): solo trees are a few KiB; Phase 5 groups grow. */
const MAX_MLS_MESSAGE_BYTES = 256 * 1024;
/** A key-archive envelope: 1 MiB of plaintext plus framing (header.ts). */
const MAX_ARCHIVE_ENVELOPE_BYTES = 1024 * 1024 + 4176;
const MAX_BODY_CHARS = 2_400_000;
const WRAP_BYTES = 41;
const LEAF_KEY_BYTES = 65;
const LEAF_CERTIFICATION_BYTES = 73;
const LEAF_CERTIFICATION_VERSION = 2;
const VERSION_SIGNATURE_BYTES = 73;
const MAX_ID_LENGTH = 128;
const MAX_U32 = 0xffffffff;
const COMMITS_PAGE = 100;
const WRAPS_PAGE = 500;
const ARCHIVES_PAGE = 32;
const MAX_LEAVES = 1000;

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export function refuse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): never {
  throw new RouteError(status, code, message, extra);
}

export function invalid(message: string): never {
  refuse(400, 'E2EE_REQUEST_INVALID', message);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

// --- Input -----------------------------------------------------------------

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_CHARS) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid('Body must be JSON');
  }
  return record(value, 'Body');
}

export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Base64url text whose bytes have an exact or maximum length. */
export function bytesField(
  value: unknown,
  what: string,
  length: { exact?: number; max?: number }
): { text: string; bytes: Uint8Array } {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${what} must be base64url text`);
  }
  const max = length.exact ?? length.max!;
  if (value.length > Math.ceil((max * 4) / 3)) invalid(`${what} is too long`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    invalid(`${what} is not base64url`);
  }
  if (bytes.byteLength === 0) invalid(`${what} is empty`);
  if (length.exact !== undefined && bytes.byteLength !== length.exact) {
    invalid(`${what} must be ${length.exact} bytes`);
  }
  return { text: value, bytes };
}

export function idField(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    invalid(
      `${what} must be a printable id of at most ${MAX_ID_LENGTH} characters`
    );
  }
  return value;
}

export function uintField(
  value: unknown,
  what: string,
  max = Number.MAX_SAFE_INTEGER
) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  ) {
    invalid(`${what} must be a non-negative integer`);
  }
  return value as number;
}

export function queryUint(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw))
    invalid(`${name} must be a non-negative integer`);
  return Number(raw);
}

export function leafField(value: unknown): E2eeProjectLeafInput {
  const leaf = record(value, 'leaf');
  const key = bytesField(leaf.leafKey, 'leaf.leafKey', {
    exact: LEAF_KEY_BYTES
  });
  if (key.bytes[0] !== 0x04)
    invalid('leaf.leafKey must be an uncompressed P-256 key');
  const certification = bytesField(leaf.certification, 'leaf.certification', {
    exact: LEAF_CERTIFICATION_BYTES
  });
  if (certification.bytes[0] !== LEAF_CERTIFICATION_VERSION) {
    invalid('leaf.certification must be a version 2 leaf certification');
  }
  return { leafKey: key.text, certification: certification.text };
}

export interface CurrentAccountKey {
  generation: number;
  headSequence: number;
  /** The device's certified signing key (65-byte P-256 point). */
  signingKey: Uint8Array;
}

/**
 * Exactly one project-key and one rejoin-psk wrap for `keyEpoch`, under the
 * caller's current identity generation.
 */
export function wrapsField(
  value: unknown,
  keyEpoch: number,
  account: CurrentAccountKey
): E2eeProjectKeyWrap[] {
  if (!Array.isArray(value) || value.length !== 2) {
    invalid('wraps must hold the project key and the rejoin PSK');
  }
  const wraps = value.map((item, index): E2eeProjectKeyWrap => {
    const wrap = record(item, `wraps[${index}]`);
    const purpose = wrap.purpose;
    if (purpose !== 'project-key' && purpose !== 'rejoin-psk') {
      invalid(`wraps[${index}].purpose must be project-key or rejoin-psk`);
    }
    if (wrap.keyEpoch !== keyEpoch) {
      invalid(`wraps[${index}] must be for key epoch ${keyEpoch}`);
    }
    const generation = uintField(
      wrap.accountKeyGeneration,
      `wraps[${index}].accountKeyGeneration`
    );
    const sequence = uintField(
      wrap.accountKeySequence,
      `wraps[${index}].accountKeySequence`
    );
    if (generation !== account.generation || sequence > account.headSequence) {
      invalid(`wraps[${index}] must be under the current account key`);
    }
    return {
      keyEpoch,
      purpose,
      accountKeyGeneration: generation,
      accountKeySequence: sequence,
      wrapped: bytesField(wrap.wrapped, `wraps[${index}].wrapped`, {
        exact: WRAP_BYTES
      }).text
    };
  });
  if (new Set(wraps.map((wrap) => wrap.purpose)).size !== 2) {
    invalid('wraps must hold the project key and the rejoin PSK');
  }
  return wraps;
}

/** The key archive for `keyEpoch`, signed by the sending device. */
export function archiveField(
  value: unknown,
  projectId: string,
  keyEpoch: number,
  deviceId: string
): E2eeKeyArchiveRecord {
  const archive = record(value, 'archive');
  if (archive.keyEpoch !== keyEpoch) {
    invalid(`archive must be for key epoch ${keyEpoch}`);
  }
  if (archive.signerDeviceId !== deviceId) {
    invalid('archive must be signed by the sending device');
  }
  const envelope = bytesField(archive.envelope, 'archive.envelope', {
    max: MAX_ARCHIVE_ENVELOPE_BYTES
  });
  let header: ReturnType<typeof parseEnvelope>['header'];
  try {
    header = parseEnvelope(envelope.bytes).header;
  } catch {
    invalid('archive.envelope is not an envelope');
  }
  if (
    header.class !== 'project' ||
    header.kind !== 'key-archive' ||
    header.projectId !== projectId ||
    header.keyEpoch !== keyEpoch
  ) {
    invalid(
      `archive.envelope must be this project's key archive for key epoch ${keyEpoch}`
    );
  }
  return {
    keyEpoch,
    envelope: envelope.text,
    wrappedVersionKey: bytesField(
      archive.wrappedVersionKey,
      'archive.wrappedVersionKey',
      { exact: WRAP_BYTES }
    ).text,
    signature: bytesField(archive.signature, 'archive.signature', {
      exact: VERSION_SIGNATURE_BYTES
    }).text,
    signerDeviceId: deviceId
  };
}

// --- Access ----------------------------------------------------------------

interface ProjectRow {
  user_id: string;
  storage_format: number | null;
  status: string | null;
  member: number;
}

/** Owner of a live format-2 project; anything else is refused. */
export async function requireOwnedEncryptedProject(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT p.user_id, p.storage_format, p.status,
         EXISTS (SELECT 1 FROM project_members m
                 WHERE m.project_id = p.id AND m.user_id = ?) AS member
       FROM projects p WHERE p.id = ?`
    )
    .bind(userId, projectId)
    .first<ProjectRow>();
  const notFound = (): never =>
    refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  if (!row || row.status === 'deleted') return notFound();
  if (row.user_id !== userId) {
    // A member learns only that this is owner-only; anyone else learns nothing.
    if (row.member) {
      refuse(
        403,
        'E2EE_PROJECT_OWNER_ONLY',
        'Only the owner can use this encrypted project until sharing arrives.'
      );
    }
    return notFound();
  }
  if (row.storage_format !== 2) {
    refuse(
      409,
      'E2EE_PROJECT_NOT_ENCRYPTED',
      'This project is not end-to-end encrypted.'
    );
  }
}

/** The same ownership and format, inside every write statement. */
export const PROJECT_FENCE = `EXISTS (SELECT 1 FROM projects
  WHERE id = ? AND user_id = ? AND storage_format = 2 AND status <> 'deleted')`;

/**
 * Holds while the caller's device list is still the head a signer was
 * checked against (`requireCertifiedDevice`): a write fenced by it cannot
 * land after a removal of its signer, whose own write refuses once the
 * device signed anything (`e2ee.ts`).
 */
export function deviceListUnchanged(
  userId: string,
  key: { generation: number; headSequence: number }
): { sql: string; binds: (string | number)[] } {
  return {
    sql: `(SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?) = ?
          AND (SELECT MAX(sequence) FROM e2ee_device_list_entries
               WHERE user_id = ? AND generation = ?) = ?`,
    binds: [userId, key.generation, userId, key.generation, key.headSequence]
  };
}

/** Whether the caller's device list moved past `key`. */
export async function deviceListMoved(
  db: D1Database,
  userId: string,
  key: { generation: number; headSequence: number }
): Promise<boolean> {
  const fence = deviceListUnchanged(userId, key);
  const row = await db
    .prepare(`SELECT (${fence.sql}) AS same`)
    .bind(...fence.binds)
    .first<{ same: number | null }>();
  return row?.same !== 1;
}

export function refuseDeviceListMoved(): never {
  refuse(
    409,
    'E2EE_DEVICE_LIST_CHANGED',
    'Your devices changed while this was saving. Save again.'
  );
}

/**
 * The sending device is certified in the caller's newest device list:
 * listed, so not revoked, and not a read-only approved device (decision D4:
 * those read project keys through account-key wraps and hold no leaves).
 * Returns the current account-key position for checking wraps.
 */
export async function requireCertifiedDevice(
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<CurrentAccountKey> {
  const head = await db
    .prepare(
      `SELECT e.generation, e.sequence, e.entry
       FROM e2ee_device_list_entries e
       WHERE e.user_id = ? AND e.generation =
         (SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?)
       ORDER BY e.sequence DESC LIMIT 1`
    )
    .bind(userId, userId)
    .first<{ generation: number; sequence: number; entry: string }>();
  let listed: Uint8Array | null = null;
  if (head) {
    try {
      listed =
        decodeDeviceListEntry(fromBase64Url(head.entry)).devices.find(
          (device) => device.deviceId === deviceId
        )?.signingKey ?? null;
    } catch {
      listed = null;
    }
  }
  if (!head || !listed) {
    refuse(
      403,
      'E2EE_DEVICE_NOT_CERTIFIED',
      'Only a device certified in your device list can hold a leaf in an encrypted project.'
    );
  }
  return {
    generation: head.generation,
    headSequence: head.sequence,
    signingKey: listed
  };
}

// --- Rows ------------------------------------------------------------------

interface GroupRow {
  group_id: string;
  generation: number;
  key_epoch_base: number;
  epoch: number;
  group_info: string;
  group_info_epoch: number;
  initial_group_info: string;
  updated_at: string;
}

interface CommitRow {
  epoch: number;
  kind: E2eeMlsCommitKind;
  sender_user_id: string | null;
  sender_device_id: string | null;
  message: string;
  created_at: string;
}

const groupRecord = (row: GroupRow): E2eeProjectGroupRecord => ({
  groupId: row.group_id,
  generation: row.generation,
  keyEpochBase: row.key_epoch_base,
  epoch: row.epoch,
  groupInfo: row.group_info,
  groupInfoEpoch: row.group_info_epoch,
  initialGroupInfo: row.initial_group_info,
  updatedAt: row.updated_at
});

const commitRecord = (row: CommitRow): E2eeMlsCommitRecord => ({
  epoch: row.epoch,
  kind: row.kind,
  senderUserId: row.sender_user_id,
  senderDeviceId: row.sender_device_id,
  message: row.message,
  createdAt: row.created_at
});

async function groupRow(
  db: D1Database,
  projectId: string
): Promise<GroupRow | null> {
  return db
    .prepare(
      `SELECT group_id, generation, key_epoch_base, epoch, group_info,
              group_info_epoch, initial_group_info, updated_at
       FROM e2ee_project_groups WHERE project_id = ?`
    )
    .bind(projectId)
    .first<GroupRow>();
}

async function requireGroup(db: D1Database, projectId: string) {
  const row = await groupRow(db, projectId);
  if (!row) {
    refuse(
      404,
      'E2EE_GROUP_NOT_FOUND',
      'This encrypted project has no MLS group yet.'
    );
  }
  return row;
}

async function commitRow(
  db: D1Database,
  projectId: string,
  epoch: number
): Promise<CommitRow | null> {
  return db
    .prepare(
      `SELECT epoch, kind, sender_user_id, sender_device_id, message, created_at
       FROM e2ee_mls_commits WHERE project_id = ? AND epoch = ?`
    )
    .bind(projectId, epoch)
    .first<CommitRow>();
}

async function epochTaken(
  db: D1Database,
  projectId: string,
  epoch: number
): Promise<never> {
  const winner = await commitRow(db, projectId, epoch);
  refuse(
    409,
    'EPOCH_TAKEN',
    'Another Commit was accepted for this epoch. Process it and try again.',
    winner ? { winner: commitRecord(winner) } : {}
  );
}

/**
 * A Commit that lost its epoch to one that landed after this request read
 * the group: answers 409 EPOCH_TAKEN with the stored winner, so the sender
 * can discard its Commit and rebase, exactly as when the read already saw
 * the winner. Returns when no Commit holds the epoch.
 */
async function refuseIfEpochTaken(
  db: D1Database,
  projectId: string,
  epoch: number
): Promise<void> {
  if (await commitRow(db, projectId, epoch)) {
    await epochTaken(db, projectId, epoch);
  }
}

// --- Writes ----------------------------------------------------------------

export interface Authorization {
  sql: string;
  binds: readonly unknown[];
}

/** Each later statement lands only if the one before it changed one row. */
export const CHAINED = 'changes() = 1';

export function insertLeaf(
  db: D1Database,
  projectId: string,
  userId: string,
  deviceId: string,
  leaf: E2eeProjectLeafInput,
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO e2ee_project_leaves
         (project_id, user_id, device_id, leaf_key, certification, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${CHAINED}`
    )
    .bind(projectId, userId, deviceId, leaf.leafKey, leaf.certification, now);
}

export function insertWraps(
  db: D1Database,
  projectId: string,
  userId: string,
  wraps: readonly E2eeProjectKeyWrap[],
  now: string
): D1PreparedStatement[] {
  return wraps.map((wrap) =>
    db
      .prepare(
        `INSERT INTO e2ee_project_keys
           (user_id, project_id, key_epoch, purpose, account_key_generation,
            account_key_sequence, wrapped, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${CHAINED}`
      )
      .bind(
        userId,
        projectId,
        wrap.keyEpoch,
        wrap.purpose,
        wrap.accountKeyGeneration,
        wrap.accountKeySequence,
        wrap.wrapped,
        now
      )
  );
}

export function insertArchive(
  db: D1Database,
  projectId: string,
  archive: E2eeKeyArchiveRecord,
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO e2ee_key_archives
         (project_id, key_epoch, envelope, wrapped_version_key, signature,
          signer_device_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${CHAINED}`
    )
    .bind(
      projectId,
      archive.keyEpoch,
      archive.envelope,
      archive.wrappedVersionKey,
      archive.signature,
      archive.signerDeviceId,
      now
    );
}

export type BatchResult = Awaited<ReturnType<D1Database['batch']>>[number];

/**
 * Runs a write batch; a fence or key conflict becomes a 409. `onConflict`
 * may answer a key conflict more precisely first (it returns to fall back
 * to the generic one).
 */
export async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  onConflict?: () => Promise<void>
): Promise<BatchResult[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ACCOUNT_ERASURE_IN_PROGRESS')) {
      refuse(
        409,
        'ACCOUNT_ERASURE_IN_PROGRESS',
        'Cloud data deletion is in progress. Retry that deletion before making other cloud changes.'
      );
    }
    if (/UNIQUE constraint|PRIMARY KEY|E2EE_GROUP_EPOCH/i.test(message)) {
      await onConflict?.();
      refuse(
        409,
        'E2EE_CONFLICT',
        'This encrypted project changed meanwhile. Reload and try again.'
      );
    }
    throw error;
  }
}

export const allChanged = (results: readonly BatchResult[], count: number) =>
  results.length === count &&
  results.every((result) => (result.meta?.changes ?? 0) === 1);

async function createGroup(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>
): Promise<Response> {
  const groupId = idField(body.groupId, 'groupId');
  const deviceId = idField(body.deviceId, 'deviceId');
  const groupInfo = bytesField(body.groupInfo, 'groupInfo', {
    max: MAX_MLS_MESSAGE_BYTES
  }).text;
  const leaf = leafField(body.leaf);
  const account = await requireCertifiedDevice(db, userId, deviceId);
  const wraps = wrapsField(body.wraps, 0, account);
  const archive = archiveField(body.archive, projectId, 0, deviceId);
  const now = new Date().toISOString();
  const results = await runBatch(db, [
    db
      .prepare(
        `INSERT INTO e2ee_project_groups
           (project_id, group_id, generation, key_epoch_base, epoch,
            initial_group_info, group_info, group_info_epoch, updated_at)
         SELECT ?, ?, 0, 0, 0, ?, ?, 0, ?
         WHERE ${authorization.sql} AND ${PROJECT_FENCE}
           AND NOT EXISTS (SELECT 1 FROM e2ee_project_groups WHERE project_id = ?)`
      )
      .bind(
        projectId,
        groupId,
        groupInfo,
        groupInfo,
        now,
        ...authorization.binds,
        projectId,
        userId,
        projectId
      ),
    insertLeaf(db, projectId, userId, deviceId, leaf, now),
    ...insertWraps(db, projectId, userId, wraps, now),
    insertArchive(db, projectId, archive, now)
  ]);
  if (!allChanged(results, 5)) {
    if (await groupRow(db, projectId)) {
      refuse(
        409,
        'E2EE_GROUP_EXISTS',
        'This encrypted project already has an MLS group.'
      );
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  return json(
    {
      group: groupRecord((await groupRow(db, projectId))!)
    } satisfies E2eeProjectGroupResponse,
    201
  );
}

async function submitCommit(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>
): Promise<Response> {
  const epoch = uintField(body.epoch, 'epoch');
  const kind = body.kind;
  if (kind !== 'commit' && kind !== 'external') {
    invalid('kind must be commit or external');
  }
  const deviceId = idField(body.deviceId, 'deviceId');
  const message = bytesField(body.message, 'message', {
    max: MAX_MLS_MESSAGE_BYTES
  }).text;
  const groupInfo = bytesField(body.groupInfo, 'groupInfo', {
    max: MAX_MLS_MESSAGE_BYTES
  }).text;
  if (kind === 'external' && body.leaf === undefined) {
    invalid('An external Commit carries the joining device’s leaf');
  }
  const leaf = body.leaf === undefined ? null : leafField(body.leaf);
  const account = await requireCertifiedDevice(db, userId, deviceId);
  const group = await requireGroup(db, projectId);
  if (epoch < group.epoch) await epochTaken(db, projectId, epoch);
  if (epoch > group.epoch) {
    refuse(
      409,
      'E2EE_EPOCH_AHEAD',
      `The group is at epoch ${group.epoch}; catch up before committing.`,
      { epoch: group.epoch }
    );
  }
  const keyEpoch = group.key_epoch_base + epoch + 1;
  if (keyEpoch > MAX_U32) invalid('The key epoch is exhausted');
  const wraps = wrapsField(body.wraps, keyEpoch, account);
  const archive = archiveField(body.archive, projectId, keyEpoch, deviceId);
  const now = new Date().toISOString();
  const statements = [
    // The sequencer: one Commit per epoch, only on top of the current one.
    db
      .prepare(
        `INSERT INTO e2ee_mls_commits
           (project_id, epoch, kind, sender_user_id, sender_device_id, message, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE ${authorization.sql} AND ${PROJECT_FENCE}
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
                       WHERE project_id = ? AND epoch = ? AND key_epoch_base = ?)`
      )
      .bind(
        projectId,
        epoch,
        kind,
        userId,
        deviceId,
        message,
        now,
        ...authorization.binds,
        projectId,
        userId,
        projectId,
        epoch,
        group.key_epoch_base
      ),
    db
      .prepare(
        `UPDATE e2ee_project_groups
         SET epoch = epoch + 1, group_info = ?, group_info_epoch = ?, updated_at = ?
         WHERE project_id = ? AND epoch = ? AND ${CHAINED}`
      )
      .bind(groupInfo, epoch + 1, now, projectId, epoch),
    ...(leaf ? [insertLeaf(db, projectId, userId, deviceId, leaf, now)] : []),
    ...insertWraps(db, projectId, userId, wraps, now),
    insertArchive(db, projectId, archive, now)
  ];
  // Two submissions for one epoch can both pass the read above. Whichever
  // batch runs second either finds the epoch fence moved (no rows change)
  // or, on a store that checks the Commit log's primary key first, fails
  // on (project_id, epoch): both mean the epoch is taken.
  const results = await runBatch(db, statements, () =>
    refuseIfEpochTaken(db, projectId, epoch)
  );
  if (!allChanged(results, statements.length)) {
    await refuseIfEpochTaken(db, projectId, epoch);
    const current = await groupRow(db, projectId);
    if (current && current.epoch > epoch)
      await epochTaken(db, projectId, epoch);
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  return json({
    commit: commitRecord((await commitRow(db, projectId, epoch))!),
    group: groupRecord((await groupRow(db, projectId))!)
  } satisfies E2eeMlsCommitResponse);
}

// --- Reads -----------------------------------------------------------------

async function listCommits(db: D1Database, projectId: string, url: URL) {
  // `after` is the reader's current epoch: every Commit that moves it on.
  const after = queryUint(url, 'after') ?? 0;
  const { results } = await db
    .prepare(
      `SELECT epoch, kind, sender_user_id, sender_device_id, message, created_at
       FROM e2ee_mls_commits WHERE project_id = ? AND epoch >= ?
       ORDER BY epoch LIMIT ?`
    )
    .bind(projectId, after, COMMITS_PAGE + 1)
    .all<CommitRow>();
  const rows = results ?? [];
  return json({
    commits: rows.slice(0, COMMITS_PAGE).map(commitRecord),
    more: rows.length > COMMITS_PAGE
  } satisfies E2eeMlsCommitsResponse);
}

async function listLeaves(db: D1Database, projectId: string) {
  const { results } = await db
    .prepare(
      `SELECT user_id, device_id, leaf_key, certification, created_at
       FROM e2ee_project_leaves WHERE project_id = ?
       ORDER BY created_at, leaf_key LIMIT ?`
    )
    .bind(projectId, MAX_LEAVES)
    .all<{
      user_id: string;
      device_id: string;
      leaf_key: string;
      certification: string;
      created_at: string;
    }>();
  return json({
    leaves: (results ?? []).map((row): E2eeProjectLeafRecord => ({
      userId: row.user_id,
      deviceId: row.device_id,
      leafKey: row.leaf_key,
      certification: row.certification,
      createdAt: row.created_at
    }))
  } satisfies E2eeProjectLeavesResponse);
}

async function listWraps(
  db: D1Database,
  userId: string,
  projectId: string,
  url: URL
) {
  const purpose = url.searchParams.get('purpose');
  if (
    purpose !== null &&
    purpose !== 'project-key' &&
    purpose !== 'rejoin-psk'
  ) {
    invalid('purpose must be project-key or rejoin-psk');
  }
  const exact = queryUint(url, 'keyEpoch');
  const after = queryUint(url, 'after');
  // Only the caller's own wraps: another user's open nothing without their
  // account key, but they are still not this caller's to read.
  const { results } = await db
    .prepare(
      `SELECT key_epoch, purpose, account_key_generation, account_key_sequence, wrapped
       FROM e2ee_project_keys
       WHERE user_id = ? AND project_id = ?
         AND (? IS NULL OR purpose = ?)
         AND (? IS NULL OR key_epoch = ?)
         AND (? IS NULL OR key_epoch > ?)
       ORDER BY key_epoch, purpose LIMIT ?`
    )
    .bind(
      userId,
      projectId,
      purpose,
      purpose,
      exact,
      exact,
      after,
      after,
      WRAPS_PAGE + 1
    )
    .all<{
      key_epoch: number;
      purpose: E2eeProjectKeyPurpose;
      account_key_generation: number;
      account_key_sequence: number;
      wrapped: string;
    }>();
  const rows = results ?? [];
  return json({
    wraps: rows.slice(0, WRAPS_PAGE).map((row) => ({
      keyEpoch: row.key_epoch,
      purpose: row.purpose,
      accountKeyGeneration: row.account_key_generation,
      accountKeySequence: row.account_key_sequence,
      wrapped: row.wrapped
    })),
    more: rows.length > WRAPS_PAGE
  } satisfies E2eeProjectKeysResponse);
}

async function listArchives(db: D1Database, projectId: string, url: URL) {
  const exact = queryUint(url, 'keyEpoch');
  const after = queryUint(url, 'after');
  const { results } = await db
    .prepare(
      `SELECT key_epoch, envelope, wrapped_version_key, signature, signer_device_id
       FROM e2ee_key_archives
       WHERE project_id = ?
         AND (? IS NULL OR key_epoch = ?)
         AND (? IS NULL OR key_epoch > ?)
       ORDER BY key_epoch LIMIT ?`
    )
    .bind(projectId, exact, exact, after, after, ARCHIVES_PAGE + 1)
    .all<{
      key_epoch: number;
      envelope: string;
      wrapped_version_key: string;
      signature: string;
      signer_device_id: string;
    }>();
  const rows = results ?? [];
  return json({
    archives: rows.slice(0, ARCHIVES_PAGE).map((row) => ({
      keyEpoch: row.key_epoch,
      envelope: row.envelope,
      wrappedVersionKey: row.wrapped_version_key,
      signature: row.signature,
      signerDeviceId: row.signer_device_id
    })),
    more: rows.length > ARCHIVES_PAGE
  } satisfies E2eeKeyArchivesResponse);
}

// --- Dispatch --------------------------------------------------------------

/**
 * Handles `/api/e2ee/projects/:id/…`. `projectsEnabled` is the account's
 * E2EE_PROJECTS_ENABLED decision; `authorization` is the session/erasure
 * write predicate (an always-false one for reads).
 */
export async function handleE2eeProjectRequest(
  request: Request,
  db: D1Database,
  userId: string,
  projectsEnabled: boolean,
  authorization: Authorization
): Promise<Response> {
  try {
    if (!projectsEnabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Encrypted projects are not available for this account yet.'
      );
    }
    if (
      !(await isProjectStorageFormatReady(db)) ||
      !(await isE2eeProjectGroupStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Encrypted projects are unavailable until the database is updated.'
      );
    }
    const url = new URL(request.url);
    const match = E2EE_PROJECT_ROUTE.exec(url.pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    try {
      projectId = decodeURIComponent(match[1]!);
    } catch {
      refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    }
    const route = match[2]!;
    const method = request.method;
    const known =
      (method === 'GET' &&
        [
          'mls/commits',
          'mls/group-info',
          'mls/leaves',
          'keys',
          'keys/archives'
        ].includes(route)) ||
      (method === 'POST' && ['mls/commits', 'mls/group-info'].includes(route));
    if (!known) refuse(404, 'NOT_FOUND', 'Not found.');
    await requireOwnedEncryptedProject(db, userId, projectId);
    if (method === 'POST') {
      const body = await readBody(request);
      return route === 'mls/group-info'
        ? await createGroup(db, userId, projectId, authorization, body)
        : await submitCommit(db, userId, projectId, authorization, body);
    }
    switch (route) {
      case 'mls/group-info':
        return json({
          group: groupRecord(await requireGroup(db, projectId))
        } satisfies E2eeProjectGroupResponse);
      case 'mls/commits':
        return await listCommits(db, projectId, url);
      case 'mls/leaves':
        return await listLeaves(db, projectId);
      case 'keys':
        return await listWraps(db, userId, projectId, url);
      default:
        return await listArchives(db, projectId, url);
    }
  } catch (error) {
    if (error instanceof RouteError) {
      return json(
        { error: error.message, code: error.code, ...error.extra },
        error.status
      );
    }
    throw error;
  }
}

/**
 * Account erasure (migration 0032): the account's own wraps (under the
 * account key erasure deletes) and leaf certifications are profile data.
 * With `all`, the owned projects and their group rows are already gone, and
 * Commits the account sent in other owners' projects keep their bytes but
 * lose the sender. A profile-only erasure keeps the owned projects' Commit
 * log as project data. Empty until the tables exist.
 */
export async function projectGroupErasureStatements(
  db: D1Database,
  userId: string,
  scope: 'profile' | 'all'
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeProjectGroupStorageReady(db))) return [];
  return [
    db.prepare('DELETE FROM e2ee_project_keys WHERE user_id = ?').bind(userId),
    db
      .prepare('DELETE FROM e2ee_project_leaves WHERE user_id = ?')
      .bind(userId),
    ...(scope === 'all'
      ? [
          db
            .prepare(
              `UPDATE e2ee_mls_commits SET sender_user_id = NULL, sender_device_id = NULL
               WHERE sender_user_id = ?`
            )
            .bind(userId)
        ]
      : [])
  ];
}
