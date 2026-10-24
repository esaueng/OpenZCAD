/**
 * Moving an existing plaintext project to encrypted storage (ADR-024 Phase
 * 7, slice 7-1; roadmap L11), under `/api/e2ee/projects/:id/migration…`.
 * The owner's browser does all the encrypting (slice 7-2); the Worker's
 * role is a state machine and a janitor. It never transforms content:
 *
 * - `POST …/migration` starts (or resumes, once a lease lapsed) a staging:
 *   owner only, a live plaintext project with no members or pending
 *   invitations (decision M7), nothing staged left over. It hands the
 *   owner's device a lease. While staging, the plaintext routes refuse
 *   writes, named saves and the room with 409 PROJECT_MIGRATING
 *   (`projectFormatGate.ts`), reads keep working, and the encrypted-project
 *   routes take ciphertext for this format-1 project from the lease holder
 *   only (`e2eeMigrationLease.ts`, `projectFence` in `e2eeProjects.ts`).
 * - `POST …/migration/lease` renews the lease.
 * - `POST …/migration/cutover` is one D1 batch: it checks what the server
 *   can see (every retained plaintext revision id has a staged named save
 *   with a retained body, decision M9; a staged head newer than the
 *   plaintext head, with its group and project info; the plaintext did not
 *   move since staging began; still no members or pending invitations),
 *   flips `storage_format` to 2 with the staged
 *   head, revokes plaintext share links and unaccepted invitations
 *   (decision M8), and starts counting the staged blobs as artifact usage
 *   (decision M10: staged ciphertext counts toward nothing before).
 * - `POST …/migration/abandon` drops the staged rows and objects, a bounded
 *   step per call, and unlocks the plaintext at once.
 * - `POST …/migration/purge` deletes the plaintext a bounded step per call:
 *   the room's plaintext keys (through its internal migration endpoint),
 *   the plaintext head and name, revisions, R2 documents, assets and
 *   artifacts (an object another project's row still names is kept),
 *   upload sessions, measurements and workspace sessions. Share links
 *   serve a projection built from the plaintext document on each read, so
 *   with the links revoked and the document gone nothing of it remains.
 *   The owner's browser drives it; the scheduled sweep finishes purges
 *   and abandons a browser left behind.
 *
 * Served by `handleE2eeRequest` after the key rollout gate, key-table
 * readiness and, for writes, the session/erasure write authorization.
 * Here: E2EE_MIGRATION_ENABLED (with encrypted projects) and migrations
 * 0031–0034 and 0042, 503 without them.
 */
import { toBase64Url } from '@openzcad/crypto';
import {
  E2EE_MIGRATION_CODES,
  E2EE_MIGRATION_LEASE_TTL_MS,
  type E2eeMigrationCutoverResponse,
  type E2eeMigrationLeaseResponse,
  type E2eeMigrationStepResponse,
  type E2eeProjectMigrationRecord,
  type E2eeProjectMigrationResponse
} from '@openzcad/shared';
import {
  D1R2PersistenceService,
  isE2eeContentBlobStorageReady,
  isE2eeDeviceRemovalStorageReady,
  isE2eeProjectGroupStorageReady,
  isE2eeProjectMigrationStorageReady,
  isE2eeProjectVersionStorageReady,
  isProjectStorageFormatReady,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  RouteError,
  idField,
  invalid,
  json,
  record,
  refuse,
  requireCertifiedDevice,
  runBatch,
  type Authorization
} from './e2eeProjects';
import { ENCRYPTED_DOCUMENT_MARKER } from './e2eeProjectDocuments';

const ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/migration(?:\/(lease|cutover|abandon|purge))?$/;

/** The migration routes this module serves. */
export function isE2eeProjectMigrationPath(pathname: string): boolean {
  return ROUTE.test(pathname);
}

/**
 * Objects one abandon or purge call deletes at most (judgment: well within
 * a Worker invocation's subrequest budget), and plaintext rows one step
 * deletes without objects.
 */
export const MIGRATION_STEP_OBJECTS = 40;
const MIGRATION_STEP_ROWS = 200;
const MAX_BODY_CHARS = 4096;
/** The sweep leaves a browser this long before it finishes for it. */
export const MIGRATION_SWEEP_IDLE_MS = 60 * 60 * 1000;
const MIGRATION_SWEEP_ROWS = 5;
const MIGRATION_SWEEP_STEPS = 3;

/** The purge steps, in order. */
const PURGE_STEPS = [
  'room',
  'head',
  'revisions',
  'documents',
  'assets',
  'artifacts',
  'uploads',
  'records'
] as const;
type PurgeStep = (typeof PURGE_STEPS)[number];
const CLEANUP = 'cleanup';

/** The bindings the migration routes use. */
export interface MigrationEnv {
  DB?: D1Database;
  PROJECT_STORAGE?: unknown;
  ARTIFACTS?: unknown;
  PROJECT_ROOM?: unknown;
}

interface ObjectBucket {
  delete(key: string): Promise<void>;
}

interface RoomNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

interface Context {
  db: D1Database;
  env: MigrationEnv;
  userId: string;
  authorization: Authorization;
}

interface MigrationRow {
  project_id: string;
  direction: 'encrypt' | 'decrypt';
  state: E2eeProjectMigrationRecord['state'];
  owner_user_id: string;
  device_id: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
  source_version: number;
  source_measurement_revision: number;
  staged_version: number;
  staged_hash: string | null;
  revision_count: number;
  blob_count: number;
  blob_bytes: number;
  purge_cursor: string | null;
  purged_rows: number;
  purged_objects: number;
  started_at: string;
  updated_at: string;
  cutover_at: string | null;
  finished_at: string | null;
}

// --- Rows ------------------------------------------------------------------

async function migrationRow(
  db: D1Database,
  projectId: string
): Promise<MigrationRow | null> {
  return db
    .prepare('SELECT * FROM e2ee_project_migrations WHERE project_id = ?')
    .bind(projectId)
    .first<MigrationRow>();
}

/** While staging, what is staged so far; afterwards, what the cutover saw. */
async function stagedCounts(
  db: D1Database,
  projectId: string
): Promise<{ revisions: number; blobs: number; blobBytes: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM e2ee_project_revisions WHERE project_id = ?)
           AS revisions,
         (SELECT COUNT(*) FROM e2ee_content_blobs WHERE project_id = ?)
           AS blobs,
         (SELECT COALESCE(SUM(ciphertext_bytes), 0) FROM e2ee_content_blobs
          WHERE project_id = ?) AS blob_bytes`
    )
    .bind(projectId, projectId, projectId)
    .first<{ revisions: number; blobs: number; blob_bytes: number }>();
  return {
    revisions: row?.revisions ?? 0,
    blobs: row?.blobs ?? 0,
    blobBytes: row?.blob_bytes ?? 0
  };
}

async function recordOf(
  db: D1Database,
  row: MigrationRow,
  lease: string | null,
  now = Date.now()
): Promise<E2eeProjectMigrationRecord> {
  const counts =
    row.state === 'staging'
      ? await stagedCounts(db, row.project_id)
      : {
          revisions: row.revision_count,
          blobs: row.blob_count,
          blobBytes: row.blob_bytes
        };
  return {
    projectId: row.project_id,
    direction: row.direction,
    state: row.state,
    deviceId: row.device_id,
    leaseExpiresAt: row.lease_expires_at,
    leaseHeld:
      row.state === 'staging' &&
      lease !== null &&
      row.lease_id === lease &&
      (row.lease_expires_at ?? 0) > now,
    sourceVersion: row.source_version,
    stagedVersion: row.staged_version,
    stagedHash: row.staged_hash,
    revisionCount: counts.revisions,
    blobCount: counts.blobs,
    blobBytes: counts.blobBytes,
    purgeCursor: row.purge_cursor,
    purgedRows: row.purged_rows,
    purgedObjects: row.purged_objects,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    cutoverAt: row.cutover_at,
    finishedAt: row.finished_at
  };
}

async function currentRecord(
  ctx: Context,
  projectId: string,
  lease: string | null
): Promise<E2eeProjectMigrationRecord> {
  const row = await migrationRow(ctx.db, projectId);
  if (!row) refuse(404, 'E2EE_MIGRATION_NOT_FOUND', 'No migration found.');
  return recordOf(ctx.db, row, lease);
}

interface OwnedProject {
  storage_format: number;
  status: string | null;
  document_version: number;
}

/** The caller owns the project; a member learns only that, others nothing. */
async function requireOwnedProject(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<OwnedProject> {
  const row = await db
    .prepare(
      `SELECT p.user_id, p.storage_format, p.status, p.document_version,
         EXISTS (SELECT 1 FROM project_members m
                 WHERE m.project_id = p.id AND m.user_id = ?) AS member
       FROM projects p WHERE p.id = ?`
    )
    .bind(userId, projectId)
    .first<OwnedProject & { user_id: string; member: number }>();
  if (!row) refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  if (row.user_id !== userId) {
    if (row.member && row.status !== 'deleted') {
      refuse(
        403,
        'E2EE_PROJECT_OWNER_ONLY',
        'Only the owner can encrypt this project.'
      );
    }
    refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  }
  return row;
}

/** Decision M7: members and pending invitations, by the same SQL as the fences. */
const SHARED_SQL = `(EXISTS (SELECT 1 FROM project_members sm
                     WHERE sm.project_id = ?)
  OR EXISTS (SELECT 1 FROM project_invitations si
             WHERE si.project_id = ? AND si.accepted_at IS NULL
               AND si.revoked_at IS NULL AND si.expires_at >= ?))`;
const sharedBinds = (projectId: string, nowSeconds: number) => [
  projectId,
  projectId,
  nowSeconds
];

async function requireUnshared(
  db: D1Database,
  projectId: string,
  nowSeconds: number
): Promise<void> {
  const shared = await db
    .prepare(`SELECT ${SHARED_SQL} AS shared`)
    .bind(...sharedBinds(projectId, nowSeconds))
    .first<{ shared: number }>();
  if (shared?.shared) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.shared,
      'A shared project cannot be encrypted yet. Remove its members and pending invitations first.'
    );
  }
}

/** Anything staged for the project, which a fresh start must not mix with. */
const STAGED_ROWS_SQL = `(EXISTS (SELECT 1 FROM e2ee_project_groups WHERE project_id = ?)
  OR EXISTS (SELECT 1 FROM e2ee_project_versions WHERE project_id = ?)
  OR EXISTS (SELECT 1 FROM e2ee_project_envelopes WHERE project_id = ?)
  OR EXISTS (SELECT 1 FROM e2ee_content_blobs WHERE project_id = ?))`;
const stagedRowsBinds = (projectId: string) => [
  projectId,
  projectId,
  projectId,
  projectId
];

function newLeaseId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length === 0) return {};
  if (text.length > MAX_BODY_CHARS) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  try {
    return record(JSON.parse(text), 'Body');
  } catch (error) {
    if (error instanceof RouteError) throw error;
    invalid('Body must be JSON');
  }
}

/** Tells the project's room to lock or purge; true when there is none. */
async function tellRoom(
  env: MigrationEnv,
  projectId: string,
  action: 'lock' | 'purge'
): Promise<boolean> {
  const rooms = env.PROJECT_ROOM as RoomNamespace | undefined;
  if (!rooms || typeof rooms.getByName !== 'function') return true;
  const url = new URL('https://project-room.internal/_internal/migration');
  url.searchParams.set('projectId', projectId);
  const response = await rooms.getByName(projectId).fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'x-openzcad-internal-migration': 'v1',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ action })
    })
  );
  return response.ok;
}

const leaseLost = (): never =>
  refuse(
    409,
    E2EE_MIGRATION_CODES.leaseLost,
    'This project’s migration lease lapsed or moved to another device. Start the migration again to resume.'
  );

// --- Start and lease ---------------------------------------------------------

async function start(
  ctx: Context,
  projectId: string,
  body: Record<string, unknown>,
  lease: string | null
): Promise<Response> {
  if (body.direction === 'decrypt') {
    refuse(
      501,
      'FEATURE_DISABLED',
      'Turning encryption off for a project is not available yet.'
    );
  }
  if (body.direction !== 'encrypt') invalid('direction must be encrypt');
  const deviceId = idField(body.deviceId, 'deviceId');
  await requireCertifiedDevice(ctx.db, ctx.userId, deviceId);
  const project = await requireOwnedProject(ctx.db, ctx.userId, projectId);
  if (project.status === 'deleted') {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'Restore this project from the recycle bin before encrypting it.'
    );
  }
  const existing = await migrationRow(ctx.db, projectId);
  if (
    project.storage_format !== 1 ||
    existing?.state === 'cutover' ||
    existing?.state === 'purging'
  ) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'This project is already end-to-end encrypted.'
    );
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const nowSeconds = Math.floor(now / 1000);
  await requireUnshared(ctx.db, projectId, nowSeconds);
  const leaseId = newLeaseId();
  const expiresAt = now + E2EE_MIGRATION_LEASE_TTL_MS;
  if (existing?.state === 'staging') {
    // Resume: the same lease renews, a lapsed one is taken over (the
    // staged rows stay; the new holder reads them back and carries on).
    const own = lease !== null && existing.lease_id === lease;
    if (!own && (existing.lease_expires_at ?? 0) > now) {
      refuse(
        409,
        E2EE_MIGRATION_CODES.leased,
        'Another device is encrypting this project.',
        {
          deviceId: existing.device_id,
          leaseExpiresAt: existing.lease_expires_at
        }
      );
    }
    const results = await runBatch(ctx.db, [
      ctx.db
        .prepare(
          `UPDATE e2ee_project_migrations
           SET device_id = ?, lease_id = ?, lease_expires_at = ?, updated_at = ?
           WHERE project_id = ? AND state = 'staging' AND owner_user_id = ?
             AND (lease_id IS ? OR lease_expires_at <= ?)
             AND ${ctx.authorization.sql}`
        )
        .bind(
          deviceId,
          leaseId,
          expiresAt,
          nowIso,
          projectId,
          ctx.userId,
          existing.lease_id,
          now,
          ...ctx.authorization.binds
        )
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      const current = await migrationRow(ctx.db, projectId);
      if (current?.state === 'staging') {
        refuse(
          409,
          E2EE_MIGRATION_CODES.leased,
          'Another device is encrypting this project.'
        );
      }
      refuse(
        401,
        'E2EE_SESSION_REQUIRED',
        'Sign in again before encrypting this project.'
      );
    }
  } else {
    if (existing?.purge_cursor === CLEANUP) {
      refuse(
        409,
        E2EE_MIGRATION_CODES.cleanupPending,
        'An earlier attempt is still being cleaned up. Finish abandoning it first.'
      );
    }
    const leftover = await ctx.db
      .prepare(`SELECT ${STAGED_ROWS_SQL} AS staged`)
      .bind(...stagedRowsBinds(projectId))
      .first<{ staged: number }>();
    if (leftover?.staged) {
      refuse(
        409,
        E2EE_MIGRATION_CODES.cleanupPending,
        'Encrypted rows of an earlier attempt remain. Finish abandoning it first.'
      );
    }
    // One statement, fenced on everything checked above.
    const results = await runBatch(ctx.db, [
      ctx.db
        .prepare(
          `INSERT INTO e2ee_project_migrations
             (project_id, direction, state, owner_user_id, device_id, lease_id,
              lease_expires_at, source_version, source_measurement_revision,
              started_at, updated_at)
           SELECT ?, 'encrypt', 'staging', ?, ?, ?, ?, p.document_version,
                  COALESCE((SELECT revision FROM project_measurements
                            WHERE project_id = p.id), 0), ?, ?
           FROM projects p
           WHERE p.id = ? AND p.user_id = ? AND p.storage_format = 1
             AND p.status <> 'deleted' AND ${ctx.authorization.sql}
             AND NOT ${SHARED_SQL} AND NOT ${STAGED_ROWS_SQL}
           ON CONFLICT (project_id) DO UPDATE SET
             direction = excluded.direction, state = 'staging',
             device_id = excluded.device_id, lease_id = excluded.lease_id,
             lease_expires_at = excluded.lease_expires_at,
             source_version = excluded.source_version,
             source_measurement_revision = excluded.source_measurement_revision,
             staged_version = 0, staged_hash = NULL, revision_count = 0,
             blob_count = 0, blob_bytes = 0, purge_cursor = NULL,
             purged_rows = 0, purged_objects = 0,
             started_at = excluded.started_at, updated_at = excluded.updated_at,
             cutover_at = NULL, finished_at = NULL
           WHERE e2ee_project_migrations.state IN ('abandoned', 'done')
             AND e2ee_project_migrations.purge_cursor IS NULL`
        )
        .bind(
          projectId,
          ctx.userId,
          deviceId,
          leaseId,
          expiresAt,
          nowIso,
          nowIso,
          projectId,
          ctx.userId,
          ...ctx.authorization.binds,
          ...sharedBinds(projectId, nowSeconds),
          ...stagedRowsBinds(projectId)
        )
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      const current = await migrationRow(ctx.db, projectId);
      if (current?.state === 'staging') {
        refuse(
          409,
          E2EE_MIGRATION_CODES.leased,
          'Another device is encrypting this project.'
        );
      }
      await requireUnshared(ctx.db, projectId, nowSeconds);
      refuse(
        401,
        'E2EE_SESSION_REQUIRED',
        'Sign in again before encrypting this project.'
      );
    }
  }
  // Nothing the room holds may move on while the browser stages. A room
  // that cannot be told still meets the cutover's check that the
  // plaintext did not move.
  try {
    await tellRoom(ctx.env, projectId, 'lock');
  } catch {
    // Best effort; see above.
  }
  return json(
    {
      migration: await currentRecord(ctx, projectId, leaseId),
      leaseId
    } satisfies E2eeMigrationLeaseResponse,
    201
  );
}

async function renew(
  ctx: Context,
  projectId: string,
  lease: string | null
): Promise<Response> {
  if (!lease) leaseLost();
  const now = Date.now();
  const results = await runBatch(ctx.db, [
    ctx.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET lease_expires_at = ?, updated_at = ?
         WHERE project_id = ? AND owner_user_id = ? AND state = 'staging'
           AND lease_id = ? AND ${ctx.authorization.sql}`
      )
      .bind(
        now + E2EE_MIGRATION_LEASE_TTL_MS,
        new Date(now).toISOString(),
        projectId,
        ctx.userId,
        lease,
        ...ctx.authorization.binds
      )
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) leaseLost();
  return json({
    migration: await currentRecord(ctx, projectId, lease),
    leaseId: lease!
  } satisfies E2eeMigrationLeaseResponse);
}

// --- Cutover ---------------------------------------------------------------

/** Retained plaintext revisions without a staged named save (decision M9). */
const UNCOVERED_SQL = `SELECT pr.id FROM revisions pr
  WHERE pr.project_id = ? AND NOT EXISTS (
    SELECT 1 FROM e2ee_project_revisions sr
    JOIN e2ee_project_versions sv
      ON sv.project_id = sr.project_id
     AND sv.document_version = sr.document_version
    WHERE sr.project_id = pr.project_id AND sr.revision_id = pr.id
      AND sr.document_version <= ?
      AND (sv.envelope_key IS NOT NULL OR sv.envelope_inline IS NOT NULL))`;

/** A staged head with its body, its group and its project info. */
const STAGED_SQL = `(EXISTS (SELECT 1 FROM e2ee_project_versions sh
          WHERE sh.project_id = ? AND sh.document_version = ?
            AND sh.version_hash = ?
            AND (sh.envelope_key IS NOT NULL OR sh.envelope_inline IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM e2ee_project_versions sa
                  WHERE sa.project_id = ? AND sa.document_version > ?)
  AND EXISTS (SELECT 1 FROM e2ee_project_groups WHERE project_id = ?)
  AND EXISTS (SELECT 1 FROM e2ee_project_envelopes
              WHERE project_id = ? AND kind = 'project-info' AND scope = ''))`;

async function cutover(
  ctx: Context,
  projectId: string,
  lease: string | null
): Promise<Response> {
  const project = await requireOwnedProject(ctx.db, ctx.userId, projectId);
  const row = await migrationRow(ctx.db, projectId);
  if (!row || row.state !== 'staging' || row.direction !== 'encrypt') {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'This project is not being staged for encryption.'
    );
  }
  const now = Date.now();
  if (!lease || row.lease_id !== lease || (row.lease_expires_at ?? 0) <= now) {
    leaseLost();
  }
  if (project.status === 'deleted') {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'Restore this project from the recycle bin before encrypting it.'
    );
  }
  const measurement = await ctx.db
    .prepare('SELECT revision FROM project_measurements WHERE project_id = ?')
    .bind(projectId)
    .first<{ revision: number }>();
  if (
    project.document_version !== row.source_version ||
    (measurement?.revision ?? 0) !== row.source_measurement_revision
  ) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.stale,
      'This project changed after its encryption began. Abandon it and start again.'
    );
  }
  const nowSeconds = Math.floor(now / 1000);
  await requireUnshared(ctx.db, projectId, nowSeconds);
  const stagedBinds = [
    projectId,
    row.staged_version,
    row.staged_hash ?? '',
    projectId,
    row.staged_version,
    projectId,
    projectId
  ];
  const staged = await ctx.db
    .prepare(`SELECT ${STAGED_SQL} AS staged`)
    .bind(...stagedBinds)
    .first<{ staged: number }>();
  if (row.staged_version < 1 || !staged?.staged) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.notStaged,
      'Stage the encrypted head, its group and its project info first.'
    );
  }
  // The project's version only moves forward: a browser that knew the
  // plaintext head sees the encrypted one as newer.
  if (row.staged_version <= project.document_version) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.headBehind,
      'The staged head must be newer than the plaintext head it replaces.',
      { sourceVersion: project.document_version }
    );
  }
  const uncovered = await ctx.db
    .prepare(`${UNCOVERED_SQL} ORDER BY pr.created_at LIMIT 65`)
    .bind(projectId, row.staged_version)
    .all<{ id: string }>();
  if ((uncovered.results ?? []).length) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.revisionsIncomplete,
      'Every save state must be staged before the cutover.',
      { revisionIds: (uncovered.results ?? []).slice(0, 64).map((r) => r.id) }
    );
  }
  const counts = await stagedCounts(ctx.db, projectId);
  const last = await ctx.db
    .prepare(
      `SELECT revision_id FROM e2ee_project_revisions WHERE project_id = ?
       ORDER BY document_version DESC LIMIT 1`
    )
    .bind(projectId)
    .first<{ revision_id: string }>();
  const nowIso = new Date(now).toISOString();
  // Everything after the first statement lands only beside this cutover.
  const cut = {
    sql: `EXISTS (SELECT 1 FROM e2ee_project_migrations
                  WHERE project_id = ? AND state = 'cutover' AND cutover_at = ?)`,
    binds: [projectId, nowIso]
  };
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET state = 'cutover', lease_id = NULL, lease_expires_at = NULL,
             revision_count = ?, blob_count = ?, blob_bytes = ?,
             purge_cursor = ?, cutover_at = ?, updated_at = ?
         WHERE project_id = ? AND state = 'staging' AND direction = 'encrypt'
           AND owner_user_id = ? AND lease_id = ? AND lease_expires_at > ?
           AND staged_version = ? AND ${ctx.authorization.sql}
           AND EXISTS (SELECT 1 FROM projects cp
                       WHERE cp.id = ? AND cp.user_id = ?
                         AND cp.storage_format = 1 AND cp.status <> 'deleted'
                         AND cp.document_version = e2ee_project_migrations.source_version
                         AND cp.document_version < e2ee_project_migrations.staged_version)
           AND COALESCE((SELECT revision FROM project_measurements
                         WHERE project_id = ?), 0)
               = e2ee_project_migrations.source_measurement_revision
           AND NOT ${SHARED_SQL}
           AND ${STAGED_SQL}
           AND NOT EXISTS (${UNCOVERED_SQL})`
      )
      .bind(
        counts.revisions,
        counts.blobs,
        counts.blobBytes,
        PURGE_STEPS[0],
        nowIso,
        nowIso,
        projectId,
        ctx.userId,
        lease,
        now,
        row.staged_version,
        ...ctx.authorization.binds,
        projectId,
        ctx.userId,
        projectId,
        ...sharedBinds(projectId, nowSeconds),
        ...stagedBinds,
        projectId,
        row.staged_version
      ),
    // The format flips with the staged head; the plaintext row's name and
    // document go in the purge's first steps.
    ctx.db
      .prepare(
        `UPDATE projects
         SET storage_format = 2, document_version = ?, revision_count = ?,
             last_revision_id = ?, updated_at = ?
         WHERE id = ? AND storage_format = 1 AND ${cut.sql}`
      )
      .bind(
        row.staged_version,
        counts.revisions,
        last?.revision_id ?? null,
        nowIso,
        projectId,
        ...cut.binds
      ),
    // Decision M8: no plaintext link outlives the cutover.
    ctx.db
      .prepare(
        `UPDATE project_share_links SET revoked_at = MAX(?, created_at)
         WHERE project_id = ? AND revoked_at IS NULL AND ${cut.sql}`
      )
      .bind(nowSeconds, projectId, ...cut.binds),
    ctx.db
      .prepare(
        `UPDATE project_invitations SET revoked_at = MAX(?, created_at)
         WHERE project_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
           AND ${cut.sql}`
      )
      .bind(nowSeconds, projectId, ...cut.binds),
    // Decision M10: the staged blobs count as artifact usage from now on,
    // as every later blob of a format-2 project does (migration 0042).
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO artifact_account_usage
           (owner_user_id, finalized_bytes, reserved_bytes, active_sessions)
         SELECT ?, 0, 0, 0 WHERE ${cut.sql}`
      )
      .bind(ctx.userId, ...cut.binds),
    ctx.db
      .prepare(
        `UPDATE artifact_account_usage
         SET finalized_bytes = finalized_bytes + (
           SELECT COALESCE(SUM(ciphertext_bytes), 0) FROM e2ee_content_blobs
           WHERE project_id = ?)
         WHERE owner_user_id = ? AND ${cut.sql}`
      )
      .bind(projectId, ctx.userId, ...cut.binds)
  ];
  const results = await runBatch(ctx.db, statements);
  if (
    (results[0]?.meta?.changes ?? 0) !== 1 ||
    (results[1]?.meta?.changes ?? 0) !== 1
  ) {
    // Something moved between the checks and the batch: say what.
    const current = await migrationRow(ctx.db, projectId);
    if (current?.state !== 'staging') {
      refuse(
        409,
        E2EE_MIGRATION_CODES.state,
        'This project is not being staged for encryption.'
      );
    }
    if (current.lease_id !== lease || (current.lease_expires_at ?? 0) <= now) {
      leaseLost();
    }
    refuse(
      409,
      E2EE_MIGRATION_CODES.stale,
      'This project changed during the cutover. Check it and try again.'
    );
  }
  return json({
    migration: await currentRecord(ctx, projectId, null),
    revokedShareLinks: results[2]?.meta?.changes ?? 0,
    revokedInvitations: results[3]?.meta?.changes ?? 0
  } satisfies E2eeMigrationCutoverResponse);
}

// --- Abandon -----------------------------------------------------------------

function objectBucket(value: unknown): ObjectBucket | null {
  const bucket = value as Partial<ObjectBucket> | undefined;
  return bucket && typeof bucket.delete === 'function'
    ? (bucket as ObjectBucket)
    : null;
}

const projectStorageBucket = (env: MigrationEnv) =>
  objectBucket(env.PROJECT_STORAGE ?? env.ARTIFACTS);
const artifactBucket = (env: MigrationEnv) => objectBucket(env.ARTIFACTS);

function persistence(env: MigrationEnv): D1R2PersistenceService {
  return new D1R2PersistenceService(env as unknown as CloudflareEnv);
}

/** An abandoned staging of a plaintext project, inside a cleanup statement. */
const ABANDONED_FENCE = `EXISTS (SELECT 1 FROM e2ee_project_migrations am
  JOIN projects ap ON ap.id = am.project_id
  WHERE am.project_id = ? AND am.state = 'abandoned'
    AND am.purge_cursor = 'cleanup' AND ap.storage_format = 1)`;

/**
 * One bounded step of dropping an abandoned staging's rows and objects:
 * its encrypted upload sessions, its blobs, its R2 bodies, then every
 * staged row. True once nothing is left.
 */
async function dropStaged(
  db: D1Database,
  env: MigrationEnv,
  projectId: string
): Promise<{ complete: boolean; objects: number }> {
  let objects = 0;
  const sessions = await persistence(env).discardProjectUploadSessions(
    projectId,
    true,
    MIGRATION_STEP_OBJECTS
  );
  objects += sessions.discarded;
  if (sessions.remaining) return { complete: false, objects };
  const blobs = await db
    .prepare(
      `SELECT blob_id, object_key FROM e2ee_content_blobs
       WHERE project_id = ? ORDER BY blob_id LIMIT ?`
    )
    .bind(projectId, MIGRATION_STEP_OBJECTS + 1)
    .all<{ blob_id: string; object_key: string }>();
  const blobRows = (blobs.results ?? []).slice(0, MIGRATION_STEP_OBJECTS);
  if (blobRows.length) {
    const bucket = artifactBucket(env);
    if (!bucket) {
      refuse(503, 'E2EE_UNAVAILABLE', 'Encrypted storage is unavailable.');
    }
    // Objects first: a failed delete keeps the rows, so a retry finds them.
    await Promise.all(blobRows.map((row) => bucket.delete(row.object_key)));
    objects += blobRows.length;
    const ids = JSON.stringify(blobRows.map((row) => row.blob_id));
    await runBatch(db, [
      db
        .prepare(
          `DELETE FROM e2ee_version_blobs WHERE project_id = ?
             AND blob_id IN (SELECT value FROM json_each(?))
             AND ${ABANDONED_FENCE}`
        )
        .bind(projectId, ids, projectId),
      db
        .prepare(
          `UPDATE e2ee_content_blobs SET state = 'deleting'
           WHERE project_id = ? AND state = 'committed'
             AND blob_id IN (SELECT value FROM json_each(?))
             AND ${ABANDONED_FENCE}`
        )
        .bind(projectId, ids, projectId),
      db
        .prepare(
          `DELETE FROM e2ee_content_blobs WHERE project_id = ?
             AND state = 'deleting'
             AND blob_id IN (SELECT value FROM json_each(?))
             AND ${ABANDONED_FENCE}`
        )
        .bind(projectId, ids, projectId)
    ]);
    if ((blobs.results ?? []).length > MIGRATION_STEP_OBJECTS) {
      return { complete: false, objects };
    }
  }
  const bodies = await db
    .prepare(
      `SELECT document_version, envelope_key FROM e2ee_project_versions
       WHERE project_id = ? AND envelope_key IS NOT NULL
       ORDER BY document_version LIMIT ?`
    )
    .bind(projectId, MIGRATION_STEP_OBJECTS + 1)
    .all<{ document_version: number; envelope_key: string }>();
  const bodyRows = (bodies.results ?? []).slice(0, MIGRATION_STEP_OBJECTS);
  if (bodyRows.length) {
    const bucket = projectStorageBucket(env);
    if (!bucket) {
      refuse(503, 'E2EE_UNAVAILABLE', 'Encrypted storage is unavailable.');
    }
    await Promise.all(bodyRows.map((row) => bucket.delete(row.envelope_key)));
    objects += bodyRows.length;
    await runBatch(db, [
      db
        .prepare(
          `UPDATE e2ee_project_versions
           SET envelope_key = NULL, envelope_inline = NULL
           WHERE project_id = ?
             AND document_version IN (SELECT value FROM json_each(?))
             AND ${ABANDONED_FENCE}`
        )
        .bind(
          projectId,
          JSON.stringify(bodyRows.map((row) => row.document_version)),
          projectId
        )
    ]);
    if ((bodies.results ?? []).length > MIGRATION_STEP_OBJECTS) {
      return { complete: false, objects };
    }
  }
  const tables = [
    'e2ee_version_blobs',
    'e2ee_project_revisions',
    'e2ee_project_versions',
    'e2ee_project_envelopes',
    'e2ee_key_archives',
    'e2ee_project_keys',
    'e2ee_project_leaves',
    'e2ee_mls_commits',
    ...((await isE2eeDeviceRemovalStorageReady(db))
      ? ['e2ee_group_resets']
      : []),
    'e2ee_project_groups'
  ];
  await runBatch(
    db,
    tables.map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE project_id = ? AND ${ABANDONED_FENCE}`
        )
        .bind(projectId, projectId)
    )
  );
  return { complete: true, objects };
}

async function finishCleanup(
  db: D1Database,
  projectId: string,
  objects: number,
  complete: boolean
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE e2ee_project_migrations
       SET purged_objects = purged_objects + ?, updated_at = ?
           ${complete ? ', purge_cursor = NULL, staged_version = 0, staged_hash = NULL, finished_at = ?' : ''}
       WHERE project_id = ? AND state = 'abandoned' AND purge_cursor = 'cleanup'`
    )
    .bind(objects, now, ...(complete ? [now] : []), projectId)
    .run();
}

async function abandon(
  ctx: Context,
  projectId: string,
  lease: string | null
): Promise<Response> {
  await requireOwnedProject(ctx.db, ctx.userId, projectId);
  const row = await migrationRow(ctx.db, projectId);
  if (!row) refuse(404, 'E2EE_MIGRATION_NOT_FOUND', 'No migration found.');
  const now = Date.now();
  if (row.state === 'staging') {
    // The lease holder abandons; anyone of the owner's once it lapsed.
    if (lease !== row.lease_id && (row.lease_expires_at ?? 0) > now) {
      refuse(
        409,
        E2EE_MIGRATION_CODES.leased,
        'Another device is encrypting this project.',
        { deviceId: row.device_id, leaseExpiresAt: row.lease_expires_at }
      );
    }
    const results = await runBatch(ctx.db, [
      ctx.db
        .prepare(
          `UPDATE e2ee_project_migrations
           SET state = 'abandoned', lease_id = NULL, lease_expires_at = NULL,
               purge_cursor = 'cleanup', updated_at = ?
           WHERE project_id = ? AND state = 'staging' AND owner_user_id = ?
             AND (lease_id IS ? OR lease_expires_at <= ?)
             AND ${ctx.authorization.sql}`
        )
        .bind(
          new Date(now).toISOString(),
          projectId,
          ctx.userId,
          row.lease_id,
          now,
          ...ctx.authorization.binds
        )
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      refuse(
        409,
        E2EE_MIGRATION_CODES.leased,
        'The migration changed meanwhile. Reload it.'
      );
    }
  } else if (row.state !== 'abandoned') {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'This project is already encrypted; it can only be purged now.'
    );
  } else if (row.purge_cursor !== CLEANUP) {
    return json({
      migration: await recordOf(ctx.db, row, lease),
      complete: true
    } satisfies E2eeMigrationStepResponse);
  }
  const step = await dropStaged(ctx.db, ctx.env, projectId);
  await finishCleanup(ctx.db, projectId, step.objects, step.complete);
  return json({
    migration: await currentRecord(ctx, projectId, null),
    complete: step.complete
  } satisfies E2eeMigrationStepResponse);
}

// --- Purge -------------------------------------------------------------------

/** The cutover project being purged, inside a purge statement. */
const PURGING_FENCE = `EXISTS (SELECT 1 FROM e2ee_project_migrations pm
  JOIN projects pp ON pp.id = pm.project_id
  WHERE pm.project_id = ? AND pm.state = 'purging' AND pp.storage_format = 2)`;

/**
 * Object keys among `keys` that a row of another project still names
 * (plaintext documents, assets, artifacts, upload sessions or encrypted
 * blobs): those stay in R2. Keys are per project today; the check keeps a
 * purge from ever deleting bytes a copy shares.
 */
async function keysInUseElsewhere(
  db: D1Database,
  projectId: string,
  keys: readonly string[]
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const blobs = (await isE2eeContentBlobStorageReady(db))
    ? `OR EXISTS (SELECT 1 FROM e2ee_content_blobs b
                  WHERE b.object_key = k.value AND b.project_id <> ?)`
    : '';
  const { results } = await db
    .prepare(
      `SELECT k.value AS object_key FROM json_each(?) k
       WHERE EXISTS (SELECT 1 FROM artifacts a
                     WHERE a.object_key = k.value AND a.project_id <> ?)
          OR EXISTS (SELECT 1 FROM project_storage_assets s
                     WHERE s.object_key = k.value AND s.project_id <> ?)
          OR EXISTS (SELECT 1 FROM project_document_objects d
                     WHERE d.object_key = k.value AND d.project_id <> ?)
          OR EXISTS (SELECT 1 FROM upload_sessions u
                     WHERE u.object_key = k.value AND u.project_id <> ?)
          ${blobs}`
    )
    .bind(
      JSON.stringify(keys),
      projectId,
      projectId,
      projectId,
      projectId,
      ...(blobs ? [projectId] : [])
    )
    .all<{ object_key: string }>();
  return new Set((results ?? []).map((row) => row.object_key));
}

interface StepOutcome {
  /** The step has more to do (false: move on). */
  more: boolean;
  rows: number;
  objects: number;
}

/** Deletes up to a step's worth of one table's objects, then their rows. */
async function purgeObjects(
  db: D1Database,
  projectId: string,
  bucket: ObjectBucket | null,
  table: 'project_document_objects' | 'project_storage_assets' | 'artifacts',
  extraDeletes: readonly string[] = []
): Promise<StepOutcome> {
  const { results } = await db
    .prepare(
      `SELECT id, object_key FROM ${table} WHERE project_id = ?
       ORDER BY id LIMIT ?`
    )
    .bind(projectId, MIGRATION_STEP_OBJECTS + 1)
    .all<{ id: string; object_key: string }>();
  const rows = (results ?? []).slice(0, MIGRATION_STEP_OBJECTS);
  if (rows.length === 0) return { more: false, rows: 0, objects: 0 };
  if (!bucket) {
    refuse(
      503,
      'PROJECT_STORAGE_UNAVAILABLE',
      'Project storage is unavailable.'
    );
  }
  const shared = await keysInUseElsewhere(
    db,
    projectId,
    rows.map((row) => row.object_key)
  );
  const owned = rows.filter((row) => !shared.has(row.object_key));
  // Objects first: a failed delete keeps the rows, so a retry finds them.
  await Promise.all(owned.map((row) => bucket.delete(row.object_key)));
  const ids = JSON.stringify(rows.map((row) => row.id));
  await runBatch(db, [
    ...extraDeletes.map((sql) =>
      db
        .prepare(
          `${sql} IN (SELECT value FROM json_each(?)) AND ${PURGING_FENCE}`
        )
        .bind(ids, projectId)
    ),
    db
      .prepare(
        `DELETE FROM ${table} WHERE project_id = ?
           AND id IN (SELECT value FROM json_each(?)) AND ${PURGING_FENCE}`
      )
      .bind(projectId, ids, projectId)
  ]);
  return {
    more: (results ?? []).length > MIGRATION_STEP_OBJECTS,
    rows: rows.length,
    objects: owned.length
  };
}

async function purgeStep(
  db: D1Database,
  env: MigrationEnv,
  projectId: string,
  step: PurgeStep
): Promise<StepOutcome> {
  switch (step) {
    case 'room': {
      let cleared: boolean;
      try {
        cleared = await tellRoom(env, projectId, 'purge');
      } catch {
        cleared = false;
      }
      if (!cleared) {
        refuse(
          503,
          'PROJECT_ROOM_UNAVAILABLE',
          'The project’s room could not be cleared right now. Try again.'
        );
      }
      return { more: false, rows: 0, objects: 0 };
    }
    case 'head': {
      const results = await runBatch(db, [
        db
          .prepare(
            `UPDATE projects
             SET name = '', document_json = ?, document_object_id = NULL,
                 document_bytes = 0
             WHERE id = ? AND storage_format = 2 AND ${PURGING_FENCE}`
          )
          .bind(ENCRYPTED_DOCUMENT_MARKER, projectId, projectId)
      ]);
      return { more: false, rows: results[0]?.meta?.changes ?? 0, objects: 0 };
    }
    case 'revisions': {
      const results = await runBatch(db, [
        db
          .prepare(
            `DELETE FROM revisions WHERE id IN (
               SELECT id FROM revisions WHERE project_id = ? LIMIT ?)
               AND ${PURGING_FENCE}`
          )
          .bind(projectId, MIGRATION_STEP_ROWS, projectId)
      ]);
      const rows = results[0]?.meta?.changes ?? 0;
      return { more: rows >= MIGRATION_STEP_ROWS, rows, objects: 0 };
    }
    case 'documents':
      return purgeObjects(
        db,
        projectId,
        projectStorageBucket(env),
        'project_document_objects'
      );
    case 'assets':
      return purgeObjects(
        db,
        projectId,
        projectStorageBucket(env),
        'project_storage_assets'
      );
    case 'artifacts':
      return purgeObjects(db, projectId, artifactBucket(env), 'artifacts', [
        'DELETE FROM project_copy_source_archives WHERE artifact_id',
        'DELETE FROM artifact_mesh_discards WHERE artifact_id'
      ]);
    case 'uploads': {
      const sessions = await persistence(env).discardProjectUploadSessions(
        projectId,
        false,
        MIGRATION_STEP_OBJECTS
      );
      return {
        more: sessions.remaining,
        rows: sessions.discarded,
        objects: sessions.discarded
      };
    }
    case 'records': {
      const results = await runBatch(db, [
        db
          .prepare(
            `DELETE FROM project_measurements
             WHERE project_id = ? AND ${PURGING_FENCE}`
          )
          .bind(projectId, projectId),
        db
          .prepare(
            `DELETE FROM project_workspace_sessions
             WHERE project_id = ? AND ${PURGING_FENCE}`
          )
          .bind(projectId, projectId),
        db
          .prepare(
            `DELETE FROM artifact_mesh_discards
             WHERE project_id = ? AND ${PURGING_FENCE}`
          )
          .bind(projectId, projectId)
      ]);
      return {
        more: false,
        rows: results.reduce(
          (total, result) => total + (result.meta?.changes ?? 0),
          0
        ),
        objects: 0
      };
    }
  }
}

/**
 * One bounded purge call: steps run in order until one has more to do or
 * the object budget is spent. True once the purge is done.
 */
export async function purgeMigratedProject(
  db: D1Database,
  env: MigrationEnv,
  projectId: string,
  authorization: Authorization
): Promise<boolean> {
  let row = await migrationRow(db, projectId);
  if (!row) return true;
  if (row.state === 'done') return true;
  if (row.state === 'cutover') {
    await runBatch(db, [
      db
        .prepare(
          `UPDATE e2ee_project_migrations SET state = 'purging', updated_at = ?
           WHERE project_id = ? AND state = 'cutover' AND ${authorization.sql}`
        )
        .bind(new Date().toISOString(), projectId, ...authorization.binds)
    ]);
    row = await migrationRow(db, projectId);
    if (row?.state !== 'purging') {
      refuse(
        401,
        'E2EE_SESSION_REQUIRED',
        'Sign in again before purging this project.'
      );
    }
  }
  if (row.state !== 'purging') {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'This project has not been cut over to encrypted storage.'
    );
  }
  let index = Math.max(
    0,
    PURGE_STEPS.indexOf((row.purge_cursor ?? PURGE_STEPS[0]) as PurgeStep)
  );
  let spent = 0;
  while (index < PURGE_STEPS.length && spent < MIGRATION_STEP_OBJECTS) {
    const step = PURGE_STEPS[index]!;
    const outcome = await purgeStep(db, env, projectId, step);
    spent += Math.max(outcome.objects, outcome.rows > 0 ? 1 : 0);
    const next = outcome.more ? index : index + 1;
    const done = next >= PURGE_STEPS.length;
    const now = new Date().toISOString();
    const previousCursor = row.purge_cursor;
    const moved = await runBatch(db, [
      db
        .prepare(
          `UPDATE e2ee_project_migrations
           SET purge_cursor = ?, purged_rows = purged_rows + ?,
               purged_objects = purged_objects + ?, updated_at = ?
               ${done ? ", state = 'done', finished_at = ?" : ''}
           WHERE project_id = ? AND state = 'purging' AND purge_cursor IS ?
             AND ${authorization.sql}`
        )
        .bind(
          done ? null : PURGE_STEPS[next]!,
          outcome.rows,
          outcome.objects,
          now,
          ...(done ? [now] : []),
          projectId,
          row.purge_cursor ?? PURGE_STEPS[0],
          ...authorization.binds
        )
    ]);
    const current = await migrationRow(db, projectId);
    if (!current || current.state !== 'purging') return true;
    // Nothing moved it, not even another purge: the session predicate
    // refused the write.
    if (
      (moved[0]?.meta?.changes ?? 0) !== 1 &&
      current.purge_cursor === previousCursor
    ) {
      refuse(
        401,
        'E2EE_SESSION_REQUIRED',
        'Sign in again before purging this project.'
      );
    }
    row = current;
    index = Math.max(
      0,
      PURGE_STEPS.indexOf((row.purge_cursor ?? PURGE_STEPS[0]) as PurgeStep)
    );
    if (outcome.more && outcome.objects === 0 && outcome.rows === 0) break;
  }
  return false;
}

async function purge(ctx: Context, projectId: string): Promise<Response> {
  const project = await requireOwnedProject(ctx.db, ctx.userId, projectId);
  const row = await migrationRow(ctx.db, projectId);
  if (!row || project.storage_format !== 2) {
    refuse(
      409,
      E2EE_MIGRATION_CODES.state,
      'This project has not been cut over to encrypted storage.'
    );
  }
  const complete = await purgeMigratedProject(
    ctx.db,
    ctx.env,
    projectId,
    ctx.authorization
  );
  return json({
    migration: await currentRecord(ctx, projectId, null),
    complete
  } satisfies E2eeMigrationStepResponse);
}

// --- Dispatch ----------------------------------------------------------------

/**
 * Handles `/api/e2ee/projects/:id/migration…`. `migrationEnabled` is the
 * account's E2EE_MIGRATION_ENABLED decision (encrypted projects included);
 * `authorization` is the session/erasure write predicate (an always-false
 * one for reads); `lease` is the request's migration lease header.
 */
export async function handleE2eeProjectMigrationRequest(
  request: Request,
  env: MigrationEnv,
  userId: string,
  migrationEnabled: boolean,
  authorization: Authorization,
  lease: string | null
): Promise<Response> {
  try {
    if (!migrationEnabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Encrypting existing projects is not available for this account yet.'
      );
    }
    const db = env.DB;
    if (
      !db ||
      !(await isProjectStorageFormatReady(db)) ||
      !(await isE2eeProjectGroupStorageReady(db)) ||
      !(await isE2eeProjectVersionStorageReady(db)) ||
      !(await isE2eeContentBlobStorageReady(db)) ||
      !(await isE2eeProjectMigrationStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Encrypting existing projects is unavailable until the database is updated.'
      );
    }
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    try {
      projectId = decodeURIComponent(match[1]!);
    } catch {
      refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    }
    const action = match[2] ?? null;
    const method = request.method;
    const ctx: Context = { db, env, userId, authorization };
    if (action === null && method === 'GET') {
      await requireOwnedProject(db, userId, projectId);
      const row = await migrationRow(db, projectId);
      return json({
        migration: row ? await recordOf(db, row, lease) : null
      } satisfies E2eeProjectMigrationResponse);
    }
    if (method !== 'POST') refuse(404, 'NOT_FOUND', 'Not found.');
    switch (action) {
      case null:
        return await start(ctx, projectId, await readBody(request), lease);
      case 'lease':
        await requireOwnedProject(db, userId, projectId);
        return await renew(ctx, projectId, lease);
      case 'cutover':
        return await cutover(ctx, projectId, lease);
      case 'abandon':
        return await abandon(ctx, projectId, lease);
      default:
        return await purge(ctx, projectId);
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

// --- Erasure and the sweep ---------------------------------------------------

/**
 * Account erasure (migration 0042). A profile erasure forgets the device
 * and lease of every migration the account owns and abandons a staging it
 * can no longer finish (its keys go with the profile); the owner, or the
 * sweep, then drops the staged rows. With `all` the owned projects, and
 * their migration rows, are already gone. Empty until the table exists.
 */
export async function projectMigrationErasureStatements(
  db: D1Database,
  userId: string,
  scope: 'profile' | 'all'
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeProjectMigrationStorageReady(db))) return [];
  if (scope === 'all') {
    return [
      db
        .prepare('DELETE FROM e2ee_project_migrations WHERE owner_user_id = ?')
        .bind(userId)
    ];
  }
  return [
    db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET device_id = NULL, lease_id = NULL, lease_expires_at = NULL,
             purge_cursor = CASE WHEN state = 'staging' THEN 'cleanup'
                                 ELSE purge_cursor END,
             state = CASE WHEN state = 'staging' THEN 'abandoned'
                          ELSE state END
         WHERE owner_user_id = ?`
      )
      .bind(userId)
  ];
}

/**
 * The scheduled sweep: finishes purges and abandons whose browser left
 * them for {@link MIGRATION_SWEEP_IDLE_MS}, a few bounded steps each. Only
 * while E2EE_MIGRATION_ENABLED is on and migration 0042 is installed; it
 * never fails the scheduled run.
 */
export async function sweepProjectMigrations(
  env: MigrationEnv,
  enabled: boolean,
  now = Date.now()
): Promise<void> {
  const db = env.DB;
  if (!enabled || !db) return;
  try {
    if (!(await isE2eeProjectMigrationStorageReady(db))) return;
    const { results } = await db
      .prepare(
        `SELECT project_id, state FROM e2ee_project_migrations
         WHERE (state IN ('cutover', 'purging')
                OR (state = 'abandoned' AND purge_cursor = 'cleanup'))
           AND updated_at < ?
         ORDER BY updated_at LIMIT ?`
      )
      .bind(
        new Date(now - MIGRATION_SWEEP_IDLE_MS).toISOString(),
        MIGRATION_SWEEP_ROWS
      )
      .all<{ project_id: string; state: string }>();
    const always: Authorization = { sql: '1', binds: [] };
    for (const row of results ?? []) {
      try {
        for (let step = 0; step < MIGRATION_SWEEP_STEPS; step++) {
          if (row.state === 'abandoned') {
            const outcome = await dropStaged(db, env, row.project_id);
            await finishCleanup(
              db,
              row.project_id,
              outcome.objects,
              outcome.complete
            );
            if (outcome.complete) break;
          } else if (
            await purgeMigratedProject(db, env, row.project_id, always)
          ) {
            break;
          }
        }
      } catch {
        // The next sweep, or the owner's browser, tries again.
      }
    }
  } catch {
    // Housekeeping never fails the scheduled run.
  }
}
