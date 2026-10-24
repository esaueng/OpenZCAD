/**
 * Device removal across encrypted projects and the owner-only solo group
 * reset (ADR-024 Phase 4, slice 4-10; roadmap L11; decision D9):
 *
 * - `GET /api/e2ee/revocation-cutoffs`: the caller's identity-signed
 *   revocation cutoff statements, and each owned encrypted project's group
 *   state and newest head, which a removing browser names cutoffs from.
 * - `PUT /api/e2ee/revocation-cutoffs`: store the statement of one revoking
 *   device-list entry. A later statement for the same entry may replace it
 *   only if every project keeps a cutoff no lower.
 * - `GET /api/e2ee/projects/:id/mls/resets`: the project's recorded resets.
 * - `POST /api/e2ee/projects/:id/mls/reset`: replace a solo project's MLS
 *   group under an identity-signed reset. The group's generation and
 *   key-epoch base move on (decision D10: key epochs keep rising), the old
 *   group's Commit log goes (its epochs restart), and the new epoch 0's
 *   leaf, wraps and key archive land in the same D1 batch.
 *
 * The Worker verifies every statement against the stored device list with
 * the identity key, as defense in depth; browsers verify it themselves.
 * Served by `handleE2eeRequest` after the key gate, key-table readiness and,
 * for writes, the session/erasure write authorization. Here:
 * E2EE_PROJECTS_ENABLED and migrations 0031-0033 and 0036 (503 without
 * them); resets are owner only and refused while anyone else is a member
 * or holds a leaf.
 */
import {
  E2eeError,
  decodeRevocationCutoffs,
  fromBase64Url,
  toBase64Url,
  toHex,
  verifyDeviceList,
  verifyGroupReset,
  verifyRevocationCutoffs,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeGroupResetRecord,
  E2eeGroupResetsResponse,
  E2eeProjectGroupResponse,
  E2eeRemovalProjectRecord,
  E2eeRevocationCutoffRecord,
  E2eeRevocationCutoffResponse,
  E2eeRevocationCutoffsResponse
} from '@openzcad/shared';
import {
  isE2eeDeviceRemovalStorageReady,
  isE2eeProjectGroupStorageReady,
  isE2eeProjectVersionStorageReady,
  isProjectStorageFormatReady
} from '@openzcad/cloudflare-adapters';
import {
  CHAINED,
  PROJECT_FENCE,
  RouteError,
  allChanged,
  archiveField,
  bytesField,
  idField,
  insertArchive,
  insertLeaf,
  insertWraps,
  invalid,
  json,
  leafField,
  record,
  refuse,
  requireCertifiedDevice,
  requireOwnedEncryptedProject,
  runBatch,
  uintField,
  wrapsField,
  type Authorization
} from './e2eeProjects';

export const REVOCATION_CUTOFFS_ROUTE = '/api/e2ee/revocation-cutoffs';
const RESET_ROUTE = /^\/api\/e2ee\/projects\/([^/]+)\/mls\/(reset|resets)$/;

/** The routes this module serves. */
export function isE2eeDeviceRemovalPath(pathname: string): boolean {
  return pathname === REVOCATION_CUTOFFS_ROUTE || RESET_ROUTE.test(pathname);
}

/** A statement naming every project at its longest, in base64url. */
const MAX_STATEMENT_CHARS = 966_900;
const MAX_RESET_STATEMENT_BYTES = 322;
const STATEMENT_SIGNATURE_BYTES = 65;
const MAX_MLS_MESSAGE_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 2_400_000;
const MAX_PROJECTS = 4096;

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

// --- The caller's device list ------------------------------------------------

interface CurrentList {
  generation: number;
  list: VerifiedDeviceList;
}

/** The caller's current identity generation and its verified device list. */
async function currentList(
  db: D1Database,
  userId: string
): Promise<CurrentList> {
  const identity = await db
    .prepare(
      `SELECT generation, identity_key FROM e2ee_identities
       WHERE user_id = ? ORDER BY generation DESC LIMIT 1`
    )
    .bind(userId)
    .first<{ generation: number; identity_key: string }>();
  if (!identity) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  const { results } = await db
    .prepare(
      `SELECT entry, signature FROM e2ee_device_list_entries
       WHERE user_id = ? AND generation = ? ORDER BY sequence`
    )
    .bind(userId, identity.generation)
    .all<{ entry: string; signature: string }>();
  const chain: SignedDeviceListEntry[] = (results ?? []).map((row) => ({
    entry: fromBase64Url(row.entry),
    signature: fromBase64Url(row.signature)
  }));
  try {
    return {
      generation: identity.generation,
      list: await verifyDeviceList(fromBase64Url(identity.identity_key), chain)
    };
  } catch {
    return refuse(
      503,
      'E2EE_UNAVAILABLE',
      'The stored device list does not verify.'
    );
  }
}

function statementError(error: unknown): never {
  if (error instanceof E2eeError) {
    invalid(`The statement did not verify: ${error.message}`);
  }
  throw error;
}

// --- Revocation cutoffs ------------------------------------------------------

interface CutoffRow {
  generation: number;
  entry_sequence: number;
  entry_hash: string;
  statement: string;
  signature: string;
  updated_at: string;
}

const cutoffRecord = (row: CutoffRow): E2eeRevocationCutoffRecord => ({
  generation: row.generation,
  entrySequence: row.entry_sequence,
  entryHash: row.entry_hash,
  statement: row.statement,
  signature: row.signature,
  updatedAt: row.updated_at
});

async function listCutoffs(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT generation, entry_sequence, entry_hash, statement, signature, updated_at
       FROM e2ee_revocation_cutoffs WHERE user_id = ?
       ORDER BY generation, entry_sequence`
    )
    .bind(userId)
    .all<CutoffRow>();
  const { results: projects } = await db
    .prepare(
      `SELECT g.project_id, g.generation, g.key_epoch_base, g.epoch,
              (SELECT v.document_version FROM e2ee_project_versions v
               WHERE v.project_id = g.project_id
               ORDER BY v.document_version DESC LIMIT 1) AS head_version,
              (SELECT v.version_hash FROM e2ee_project_versions v
               WHERE v.project_id = g.project_id
               ORDER BY v.document_version DESC LIMIT 1) AS head_hash,
              p.status = 'deleted' AS trashed
       FROM e2ee_project_groups g JOIN projects p ON p.id = g.project_id
       -- A project in the recycle bin (slice 4-8) is named too: it can be
       -- restored, and its removed device's versions must stay readable.
       WHERE p.user_id = ? AND p.storage_format = 2
       ORDER BY g.project_id LIMIT ?`
    )
    .bind(userId, MAX_PROJECTS)
    .all<{
      project_id: string;
      generation: number;
      key_epoch_base: number;
      epoch: number;
      head_version: number | null;
      head_hash: string | null;
      trashed: number;
    }>();
  return json({
    statements: (results ?? []).map(cutoffRecord),
    projects: (projects ?? []).map((row): E2eeRemovalProjectRecord => ({
      projectId: row.project_id,
      groupGeneration: row.generation,
      keyEpochBase: row.key_epoch_base,
      epoch: row.epoch,
      head:
        row.head_version === null || row.head_hash === null
          ? null
          : { documentVersion: row.head_version, versionHash: row.head_hash },
      ...(row.trashed ? { trashed: true } : {})
    }))
  } satisfies E2eeRevocationCutoffsResponse);
}

async function storeCutoffs(
  db: D1Database,
  userId: string,
  authorization: Authorization,
  body: Record<string, unknown>
) {
  const generation = uintField(body.generation, 'generation');
  const entrySequence = uintField(body.entrySequence, 'entrySequence');
  const statement = bytesField(body.statement, 'statement', {
    max: Math.floor((MAX_STATEMENT_CHARS * 3) / 4)
  });
  const signature = bytesField(body.signature, 'signature', {
    exact: STATEMENT_SIGNATURE_BYTES
  });
  const current = await currentList(db, userId);
  if (generation !== current.generation) {
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  const value = await verifyRevocationCutoffs(
    { statement: statement.bytes, signature: signature.bytes },
    current.list,
    { generation }
  ).catch(statementError);
  if (value.entrySequence !== entrySequence) {
    invalid('entrySequence must be the entry the statement names');
  }
  const previous = await db
    .prepare(
      `SELECT statement FROM e2ee_revocation_cutoffs
       WHERE user_id = ? AND generation = ? AND entry_sequence = ?`
    )
    .bind(userId, generation, entrySequence)
    .first<{ statement: string }>();
  if (previous) {
    // A replacement only ever moves cutoffs later: nothing it drops or
    // lowers lets a revoked device's work back in.
    const before = decodeRevocationCutoffs(fromBase64Url(previous.statement));
    const after = new Map(value.cutoffs.map((c) => [c.projectId, c]));
    for (const cutoff of before.cutoffs) {
      const next = after.get(cutoff.projectId);
      if (!next || next.cutoffEpoch < cutoff.cutoffEpoch) {
        refuse(
          409,
          'E2EE_CUTOFF_REGRESSION',
          'A new cutoff statement must keep every project with a cutoff no lower.'
        );
      }
    }
  }
  const now = new Date().toISOString();
  const entryHash = toHex(value.entryHash);
  const result = await runBatch(db, [
    db
      .prepare(
        `INSERT INTO e2ee_revocation_cutoffs
           (user_id, generation, entry_sequence, entry_hash, statement, signature,
            created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authorization.sql}
         ON CONFLICT (user_id, generation, entry_sequence) DO UPDATE SET
           statement = excluded.statement, signature = excluded.signature,
           updated_at = excluded.updated_at
         WHERE e2ee_revocation_cutoffs.statement = ?`
      )
      .bind(
        userId,
        generation,
        entrySequence,
        entryHash,
        statement.text,
        signature.text,
        now,
        now,
        ...authorization.binds,
        previous?.statement ?? ''
      )
  ]);
  if (!allChanged(result, 1)) {
    if (previous) {
      refuse(
        409,
        'E2EE_CONFLICT',
        'The cutoff statement changed meanwhile. Reload and try again.'
      );
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  const row = await db
    .prepare(
      `SELECT generation, entry_sequence, entry_hash, statement, signature, updated_at
       FROM e2ee_revocation_cutoffs
       WHERE user_id = ? AND generation = ? AND entry_sequence = ?`
    )
    .bind(userId, generation, entrySequence)
    .first<CutoffRow>();
  return json({
    statement: cutoffRecord(row!)
  } satisfies E2eeRevocationCutoffResponse);
}

// --- Group resets ------------------------------------------------------------

interface ResetRow {
  generation: number;
  key_epoch_base: number;
  prior_group_id: string;
  prior_epoch: number;
  identity_generation: number;
  statement: string;
  signature: string;
  created_at: string;
}

async function listResets(db: D1Database, projectId: string) {
  const { results } = await db
    .prepare(
      `SELECT generation, key_epoch_base, prior_group_id, prior_epoch,
              identity_generation, statement, signature, created_at
       FROM e2ee_group_resets WHERE project_id = ? ORDER BY generation`
    )
    .bind(projectId)
    .all<ResetRow>();
  return json({
    resets: (results ?? []).map((row): E2eeGroupResetRecord => ({
      generation: row.generation,
      keyEpochBase: row.key_epoch_base,
      priorGroupId: row.prior_group_id,
      priorEpoch: row.prior_epoch,
      identityGeneration: row.identity_generation,
      statement: row.statement,
      signature: row.signature,
      createdAt: row.created_at
    }))
  } satisfies E2eeGroupResetsResponse);
}

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

async function groupRow(db: D1Database, projectId: string) {
  return db
    .prepare(
      `SELECT group_id, generation, key_epoch_base, epoch, group_info,
              group_info_epoch, initial_group_info, updated_at
       FROM e2ee_project_groups WHERE project_id = ?`
    )
    .bind(projectId)
    .first<GroupRow>();
}

async function resetGroup(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>
) {
  const statement = bytesField(body.statement, 'statement', {
    max: MAX_RESET_STATEMENT_BYTES
  });
  const signature = bytesField(body.signature, 'signature', {
    exact: STATEMENT_SIGNATURE_BYTES
  });
  const groupId = idField(body.groupId, 'groupId');
  const deviceId = idField(body.deviceId, 'deviceId');
  const groupInfo = bytesField(body.groupInfo, 'groupInfo', {
    max: MAX_MLS_MESSAGE_BYTES
  }).text;
  const leaf = leafField(body.leaf);
  // Only while the owner is alone: no member, and no leaf of anyone else.
  const others = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM project_members
          WHERE project_id = ? AND user_id <> ?) +
         (SELECT COUNT(*) FROM e2ee_project_leaves
          WHERE project_id = ? AND user_id <> ?) AS n`
    )
    .bind(projectId, userId, projectId, userId)
    .first<{ n: number }>();
  if ((others?.n ?? 0) > 0) {
    refuse(
      409,
      'E2EE_RESET_NOT_SOLO',
      'Only a project nobody else is in can have its encryption group reset.'
    );
  }
  const current = await currentList(db, userId);
  const reset = await verifyGroupReset(
    { statement: statement.bytes, signature: signature.bytes },
    current.list,
    { generation: current.generation }
  ).catch(statementError);
  if (reset.userId !== userId || reset.projectId !== projectId) {
    invalid('The reset names another account or project');
  }
  const group = await groupRow(db, projectId);
  if (!group) {
    refuse(
      404,
      'E2EE_GROUP_NOT_FOUND',
      'This encrypted project has no MLS group yet.'
    );
  }
  if (
    group.generation !== reset.priorGroupGeneration ||
    group.key_epoch_base + group.epoch !== reset.priorKeyEpoch
  ) {
    refuse(
      409,
      'E2EE_RESET_STALE',
      'The project’s encryption group moved on since this reset was signed. Reload and try again.',
      {
        generation: group.generation,
        keyEpoch: group.key_epoch_base + group.epoch
      }
    );
  }
  const account = await requireCertifiedDevice(db, userId, deviceId);
  const keyEpochBase = reset.priorKeyEpoch + 1;
  const generation = reset.priorGroupGeneration + 1;
  const wraps = wrapsField(body.wraps, keyEpochBase, account);
  const archive = archiveField(body.archive, projectId, keyEpochBase, deviceId);
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO e2ee_group_resets
           (project_id, generation, key_epoch_base, prior_group_id, prior_epoch,
            identity_generation, statement, signature, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${authorization.sql} AND ${PROJECT_FENCE}
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
                       WHERE project_id = ? AND group_id = ? AND generation = ?
                         AND key_epoch_base = ? AND epoch = ?)`
      )
      .bind(
        projectId,
        generation,
        keyEpochBase,
        group.group_id,
        group.epoch,
        current.generation,
        toBase64Url(statement.bytes),
        toBase64Url(signature.bytes),
        now,
        ...authorization.binds,
        projectId,
        userId,
        projectId,
        group.group_id,
        group.generation,
        group.key_epoch_base,
        group.epoch
      ),
    // The trigger of migration 0036 allows exactly this move.
    db
      .prepare(
        `UPDATE e2ee_project_groups
         SET group_id = ?, generation = ?, key_epoch_base = ?, epoch = 0,
             initial_group_info = ?, group_info = ?, group_info_epoch = 0,
             updated_at = ?
         WHERE project_id = ? AND generation = ? AND ${CHAINED}`
      )
      .bind(
        groupId,
        generation,
        keyEpochBase,
        groupInfo,
        groupInfo,
        now,
        projectId,
        group.generation
      ),
    insertLeaf(db, projectId, userId, deviceId, leaf, now),
    ...insertWraps(db, projectId, userId, wraps, now),
    insertArchive(db, projectId, archive, now),
    // The old group's epochs restart: its Commits go once the new group
    // stands. Its epoch records stay in the key archives.
    db
      .prepare(
        `DELETE FROM e2ee_mls_commits
         WHERE project_id = ? AND EXISTS (
           SELECT 1 FROM e2ee_key_archives WHERE project_id = ? AND key_epoch = ?)
           AND EXISTS (
           SELECT 1 FROM e2ee_project_groups
           WHERE project_id = ? AND generation = ? AND epoch = 0)`
      )
      .bind(projectId, projectId, keyEpochBase, projectId, generation)
  ];
  const results = await runBatch(db, statements);
  if (!allChanged(results.slice(0, -1), statements.length - 1)) {
    const now = await groupRow(db, projectId);
    if (now && now.generation !== group.generation) {
      refuse(
        409,
        'E2EE_RESET_STALE',
        'The project’s encryption group moved on since this reset was signed. Reload and try again.'
      );
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  const after = (await groupRow(db, projectId))!;
  return json(
    {
      group: {
        groupId: after.group_id,
        generation: after.generation,
        keyEpochBase: after.key_epoch_base,
        epoch: after.epoch,
        groupInfo: after.group_info,
        groupInfoEpoch: after.group_info_epoch,
        initialGroupInfo: after.initial_group_info,
        updatedAt: after.updated_at
      }
    } satisfies E2eeProjectGroupResponse,
    201
  );
}

// --- Dispatch ----------------------------------------------------------------

/**
 * Handles the device-removal and reset routes. `projectsEnabled` is the
 * account's E2EE_PROJECTS_ENABLED decision; `authorization` is the
 * session/erasure write predicate (an always-false one for reads).
 */
export async function handleE2eeDeviceRemovalRequest(
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
      !(await isE2eeProjectGroupStorageReady(db)) ||
      !(await isE2eeProjectVersionStorageReady(db)) ||
      !(await isE2eeDeviceRemovalStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Device removal for encrypted projects is unavailable until the database is updated.'
      );
    }
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === REVOCATION_CUTOFFS_ROUTE) {
      if (method === 'GET') return await listCutoffs(db, userId);
      if (method === 'PUT') {
        return await storeCutoffs(
          db,
          userId,
          authorization,
          await readBody(request)
        );
      }
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    const match = RESET_ROUTE.exec(url.pathname)!;
    let projectId: string;
    try {
      projectId = decodeURIComponent(match[1]!);
    } catch {
      refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    }
    const route = match[2];
    if (
      !(route === 'resets' && method === 'GET') &&
      !(route === 'reset' && method === 'POST')
    ) {
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    await requireOwnedEncryptedProject(db, userId, projectId);
    if (route === 'resets') return await listResets(db, projectId);
    return await resetGroup(
      db,
      userId,
      projectId,
      authorization,
      await readBody(request)
    );
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
 * Account erasure (migration 0036): the cutoff statements are profile data,
 * signed by the identity erasure deletes. Resets are project data and go
 * with their projects. Empty until the tables exist.
 */
export async function deviceRemovalErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeDeviceRemovalStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_revocation_cutoffs WHERE user_id = ?')
      .bind(userId)
  ];
}
