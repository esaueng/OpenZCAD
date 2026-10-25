/**
 * Encrypted measurements and view state (ADR-024 Phase 4, slice 4-7;
 * roadmap L11): the format-2 variants of `/api/projects/:id/measurements`
 * and `/api/projects/:id/workspace-sessions`, under
 * `/api/e2ee/projects/:id/measurements` and `…/view-states[/:sessionId]`.
 * Both are small signed project envelopes the account replaces as a whole,
 * kept in `e2ee_project_envelopes` (migration 0033):
 *
 * - **Measurements**, scoped to the project. The revision stays plaintext
 *   (the header's document version, and the row's sequence), so a write
 *   names the revision it builds on and loses a race with 409
 *   `MEASUREMENT_REVISION_CONFLICT`, as plaintext measurements do. Each
 *   envelope names the hash of the one it replaces.
 * - **View state**, scoped to the caller and one workspace session
 *   (`<userId>:<sessionId>`). The session's sequence stays plaintext and
 *   only moves forward, only the device that started a session continues
 *   it, and a view of a document version the account has not stored yet is
 *   refused. Reads return the caller's sessions of the last 30 days, at most
 *   20, and a write keeps only the newest 20: the plaintext limits.
 *
 * What the Worker checks, as for the other encrypted routes: the envelope's
 * shape and size (`parseEnvelope`), its kind, project and version, no
 * content blobs, the group's current key epoch, and a signature by a device
 * the caller's newest device list certifies. Served by `handleE2eeRequest`
 * after the key rollout gate and, for writes, the session/erasure write
 * authorization; here: E2EE_PROJECTS_ENABLED, migrations 0031–0033 (503
 * without them), owner only and format-2 projects only. The plaintext
 * routes keep refusing format 2, and are untouched.
 */
import {
  fromBase64Url,
  parseEnvelope,
  toHex,
  verifyProjectEnvelopeSignature,
  versionHash,
  type ProjectEnvelopeHeader
} from '@openzcad/crypto';
import {
  E2EE_MEASUREMENT_CONFLICT_CODE,
  MAX_WORKSPACE_SESSION_BYTES,
  type E2eeMeasurementsResponse,
  type E2eeProjectEnvelopeRecord,
  type E2eeReplacedEnvelopeKind,
  type E2eeViewStatesResponse
} from '@openzcad/shared';
import {
  isE2eeProjectGroupStorageReady,
  isE2eeProjectVersionStorageReady,
  isProjectStorageFormatReady
} from '@openzcad/cloudflare-adapters';
import {
  PROJECT_FENCE,
  RouteError,
  bytesField,
  deviceListMoved,
  deviceListUnchanged,
  idField,
  invalid,
  json,
  record,
  refuse,
  refuseDeviceListMoved,
  requireCertifiedDevice,
  requireOwnedEncryptedProject,
  runBatch,
  uintField,
  type Authorization
} from './e2eeProjects';

const ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/(measurements|view-states|view-states\/[^/]+)$/;

/** The encrypted measurement and view-state routes this module serves. */
export function isE2eeProjectEnvelopePath(pathname: string): boolean {
  return ROUTE.test(pathname);
}

const WRAP_BYTES = 41;
const VERSION_SIGNATURE_BYTES = 73;
/** 512 KiB of measurements (MAX_PROJECT_MEASUREMENT_BYTES) plus framing. */
const MAX_MEASUREMENTS_ENVELOPE_BYTES = 512 * 1024 + 4176;
/**
 * A plaintext session is at most MAX_WORKSPACE_SESSION_BYTES of JSON; its
 * envelope gets twice that, plus framing (judgment).
 */
const MAX_VIEW_STATE_ENVELOPE_BYTES = 2 * MAX_WORKSPACE_SESSION_BYTES + 4176;
const MAX_JSON_BODY_CHARS = 1_000_000;
/** The plaintext session limits (`workspaceSessions.ts`). */
export const VIEW_STATE_RETENTION_MS = 30 * 86_400_000;
export const VIEW_STATE_SESSIONS_KEPT = 20;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_SCOPE_LENGTH = 128;

interface Context {
  db: D1Database;
  userId: string;
  authorization: Authorization;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (
    Number(request.headers.get('content-length') ?? '0') > MAX_JSON_BODY_CHARS
  ) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_CHARS) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  try {
    return record(JSON.parse(text), 'Body');
  } catch (error) {
    if (error instanceof RouteError) throw error;
    invalid('Body must be JSON');
  }
}

interface EnvelopeInput {
  header: ProjectEnvelopeHeader;
  envelope: string;
  wrappedVersionKey: string;
  signature: string;
  signerDeviceId: string;
  /** The device-list head the signer was certified in; the write fences on it. */
  signerList: { generation: number; headSequence: number };
}

/**
 * A replaced envelope of `kind` for this project at `version`, naming no
 * content blobs and signed by a certified device of the caller.
 */
async function envelopeInput(
  ctx: Context,
  input: Record<string, unknown>,
  projectId: string,
  kind: 'measurements' | 'view-state',
  version: number,
  maxBytes: number
): Promise<EnvelopeInput> {
  const envelope = bytesField(input.envelope, 'envelope', { max: maxBytes });
  let header: ReturnType<typeof parseEnvelope>['header'];
  try {
    header = parseEnvelope(envelope.bytes).header;
  } catch {
    invalid('envelope is not an envelope');
  }
  if (
    header.class !== 'project' ||
    header.kind !== kind ||
    header.projectId !== projectId ||
    header.blobIds.length > 0
  ) {
    invalid(`envelope must be this project’s ${kind} envelope, without files`);
  }
  if (header.documentVersion !== version) {
    invalid(`envelope must carry version ${version}`);
  }
  const signature = bytesField(input.signature, 'signature', {
    exact: VERSION_SIGNATURE_BYTES
  });
  const signerDeviceId = idField(input.signerDeviceId, 'signerDeviceId');
  const { signingKey, generation, headSequence } = await requireCertifiedDevice(
    ctx.db,
    ctx.userId,
    signerDeviceId
  );
  const verified = await verifyProjectEnvelopeSignature(
    signingKey,
    envelope.bytes,
    signature.bytes
  ).catch(() => null);
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The envelope is not signed by the device it names.'
    );
  }
  return {
    header,
    envelope: envelope.text,
    wrappedVersionKey: bytesField(
      input.wrappedVersionKey,
      'wrappedVersionKey',
      {
        exact: WRAP_BYTES
      }
    ).text,
    signature: signature.text,
    signerDeviceId,
    signerList: { generation, headSequence }
  };
}

/** The group's current key epoch; a write under another is stale. */
async function requireCurrentEpoch(
  ctx: Context,
  projectId: string,
  keyEpoch: number
): Promise<void> {
  const group = await ctx.db
    .prepare(
      `SELECT key_epoch_base + epoch AS key_epoch FROM e2ee_project_groups
       WHERE project_id = ?`
    )
    .bind(projectId)
    .first<{ key_epoch: number }>();
  if (!group) {
    refuse(
      404,
      'E2EE_GROUP_NOT_FOUND',
      'This encrypted project has no MLS group yet.'
    );
  }
  if (group.key_epoch !== keyEpoch) {
    refuse(
      409,
      'E2EE_EPOCH_STALE',
      'The project’s keys moved to a newer epoch. Catch up and save again.',
      { keyEpoch: group.key_epoch }
    );
  }
}

interface EnvelopeRow {
  scope: string;
  sequence: number;
  key_epoch: number;
  envelope: string;
  wrapped_version_key: string;
  signature: string;
  signer_device_id: string;
  updated_at: string;
}

const ROW_COLUMNS = `scope, sequence, key_epoch, envelope, wrapped_version_key,
  signature, signer_device_id, updated_at`;

const envelopeRecord = (
  projectId: string,
  kind: E2eeReplacedEnvelopeKind,
  row: EnvelopeRow
): E2eeProjectEnvelopeRecord => ({
  projectId,
  kind,
  keyEpoch: row.key_epoch,
  sequence: row.sequence,
  envelope: row.envelope,
  wrappedVersionKey: row.wrapped_version_key,
  signature: row.signature,
  signerDeviceId: row.signer_device_id,
  updatedAt: row.updated_at
});

/** The upsert both kinds share; `guard` is the conflict update's fence. */
function upsert(
  ctx: Context,
  projectId: string,
  kind: 'measurements' | 'view-state',
  scope: string,
  input: EnvelopeInput,
  now: string,
  guard: { sql: string; binds: readonly unknown[] },
  extra: { sql: string; binds: readonly unknown[] } = { sql: '1', binds: [] }
): D1PreparedStatement {
  const signer = deviceListUnchanged(ctx.userId, input.signerList);
  return ctx.db
    .prepare(
      `INSERT INTO e2ee_project_envelopes
         (project_id, kind, scope, sequence, key_epoch, envelope,
          wrapped_version_key, signature, signer_device_id, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${ctx.authorization.sql} AND ${PROJECT_FENCE}
         AND EXISTS (SELECT 1 FROM e2ee_project_groups
                     WHERE project_id = ? AND key_epoch_base + epoch = ?)
         AND ${extra.sql}
         AND ${signer.sql}
       ON CONFLICT (project_id, kind, scope) DO UPDATE SET
         sequence = excluded.sequence, key_epoch = excluded.key_epoch,
         envelope = excluded.envelope,
         wrapped_version_key = excluded.wrapped_version_key,
         signature = excluded.signature,
         signer_device_id = excluded.signer_device_id,
         updated_at = excluded.updated_at
       WHERE excluded.sequence > e2ee_project_envelopes.sequence
         AND ${guard.sql}`
    )
    .bind(
      projectId,
      kind,
      scope,
      input.header.documentVersion,
      input.header.keyEpoch,
      input.envelope,
      input.wrappedVersionKey,
      input.signature,
      input.signerDeviceId,
      now,
      ...ctx.authorization.binds,
      projectId,
      ctx.userId,
      projectId,
      input.header.keyEpoch,
      ...extra.binds,
      ...signer.binds,
      ...guard.binds
    );
}

// --- Measurements ------------------------------------------------------------

async function measurementsRow(
  db: D1Database,
  projectId: string
): Promise<EnvelopeRow | null> {
  return db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM e2ee_project_envelopes
       WHERE project_id = ? AND kind = 'measurements' AND scope = ''`
    )
    .bind(projectId)
    .first<EnvelopeRow>();
}

const measurementsResponse = (
  projectId: string,
  row: EnvelopeRow | null
): E2eeMeasurementsResponse => ({
  revision: row?.sequence ?? 0,
  measurements: row ? envelopeRecord(projectId, 'measurements', row) : null
});

const measurementConflict = (currentRevision: number): never =>
  refuse(
    409,
    E2EE_MEASUREMENT_CONFLICT_CODE,
    `Project measurements are at revision ${currentRevision}.`,
    { currentRevision }
  );

async function saveMeasurements(
  ctx: Context,
  projectId: string,
  request: Request
): Promise<Response> {
  const body = await readJson(request);
  const expectedRevision = uintField(body.expectedRevision, 'expectedRevision');
  const input = await envelopeInput(
    ctx,
    body,
    projectId,
    'measurements',
    expectedRevision + 1,
    MAX_MEASUREMENTS_ENVELOPE_BYTES
  );
  await requireCurrentEpoch(ctx, projectId, input.header.keyEpoch);
  const stored = await measurementsRow(ctx.db, projectId);
  const storedRevision = stored?.sequence ?? 0;
  if (storedRevision !== expectedRevision) {
    measurementConflict(storedRevision);
  }
  // Each envelope names the one it replaces; one built on another copy
  // conflicts as a stale revision would, so the browser reads again.
  const storedHash = stored
    ? toHex(await versionHash(fromBase64Url(stored.envelope)))
    : null;
  const previous = input.header.previousVersionHash;
  if ((previous ? toHex(previous) : null) !== storedHash) {
    measurementConflict(storedRevision);
  }
  const now = new Date().toISOString();
  const [result] = await runBatch(ctx.db, [
    upsert(ctx, projectId, 'measurements', '', input, now, {
      sql: 'e2ee_project_envelopes.sequence = ?',
      binds: [expectedRevision]
    })
  ]);
  if ((result?.meta?.changes ?? 0) !== 1) {
    if (await deviceListMoved(ctx.db, ctx.userId, input.signerList)) {
      refuseDeviceListMoved();
    }
    const current = (await measurementsRow(ctx.db, projectId))?.sequence ?? 0;
    if (current !== expectedRevision) measurementConflict(current);
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before saving this encrypted project.'
    );
  }
  return json(
    measurementsResponse(projectId, await measurementsRow(ctx.db, projectId))
  );
}

// --- View state ----------------------------------------------------------------

const scopePrefix = (userId: string) => `${userId}:`;

async function loadViewStates(
  ctx: Context,
  projectId: string
): Promise<Response> {
  const prefix = scopePrefix(ctx.userId);
  const { results } = await ctx.db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM e2ee_project_envelopes
       WHERE project_id = ? AND kind = 'view-state'
         AND substr(scope, 1, ?) = ? AND updated_at > ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .bind(
      projectId,
      prefix.length,
      prefix,
      new Date(Date.now() - VIEW_STATE_RETENTION_MS).toISOString(),
      VIEW_STATE_SESSIONS_KEPT
    )
    .all<EnvelopeRow>();
  return json({
    sessions: (results ?? []).map((row) => ({
      ...envelopeRecord(projectId, 'view-state', row),
      sessionId: row.scope.slice(prefix.length)
    }))
  } satisfies E2eeViewStatesResponse);
}

async function saveViewState(
  ctx: Context,
  projectId: string,
  sessionId: string,
  request: Request
): Promise<Response> {
  if (!SESSION_ID.test(sessionId)) invalid('Invalid workspace session id');
  const scope = `${scopePrefix(ctx.userId)}${sessionId}`;
  if (scope.length > MAX_SCOPE_LENGTH) invalid('Invalid workspace session id');
  const body = await readJson(request);
  const sequence = uintField(body.sequence, 'sequence');
  const documentVersion = uintField(body.documentVersion, 'documentVersion');
  if (sequence < 1 || documentVersion < 1) {
    invalid('sequence and documentVersion start at 1');
  }
  const input = await envelopeInput(
    ctx,
    body,
    projectId,
    'view-state',
    sequence,
    MAX_VIEW_STATE_ENVELOPE_BYTES
  );
  if (input.header.previousVersionHash !== null) {
    invalid('A view state names no previous one');
  }
  await requireCurrentEpoch(ctx, projectId, input.header.keyEpoch);
  const now = new Date().toISOString();
  const [result] = await runBatch(ctx.db, [
    upsert(
      ctx,
      projectId,
      'view-state',
      scope,
      input,
      now,
      // Only the device that started a session continues it.
      {
        sql: 'excluded.signer_device_id = e2ee_project_envelopes.signer_device_id',
        binds: []
      },
      // A view of a version the account has not stored yet waits for it.
      {
        sql: 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND document_version >= ?)',
        binds: [projectId, documentVersion]
      }
    ),
    ctx.db
      .prepare(
        `DELETE FROM e2ee_project_envelopes
         WHERE project_id = ? AND kind = 'view-state'
           AND substr(scope, 1, ?) = ?
           AND scope NOT IN (
             SELECT scope FROM e2ee_project_envelopes
             WHERE project_id = ? AND kind = 'view-state'
               AND substr(scope, 1, ?) = ?
             ORDER BY updated_at DESC LIMIT ?
           )
           AND ${ctx.authorization.sql}`
      )
      .bind(
        projectId,
        scopePrefix(ctx.userId).length,
        scopePrefix(ctx.userId),
        projectId,
        scopePrefix(ctx.userId).length,
        scopePrefix(ctx.userId),
        VIEW_STATE_SESSIONS_KEPT,
        ...ctx.authorization.binds
      )
  ]);
  if ((result?.meta?.changes ?? 0) !== 1) {
    if (await deviceListMoved(ctx.db, ctx.userId, input.signerList)) {
      refuseDeviceListMoved();
    }
    const existing = await ctx.db
      .prepare(
        `SELECT sequence, signer_device_id FROM e2ee_project_envelopes
         WHERE project_id = ? AND kind = 'view-state' AND scope = ?`
      )
      .bind(projectId, scope)
      .first<{ sequence: number; signer_device_id: string }>();
    // Already stored at this sequence or later: as for plaintext sessions,
    // a repeated or late save is not an error.
    if (
      existing &&
      existing.sequence >= sequence &&
      existing.signer_device_id === input.signerDeviceId
    ) {
      return new Response(null, { status: 204 });
    }
    if (existing && existing.signer_device_id !== input.signerDeviceId) {
      refuse(
        409,
        'E2EE_VIEW_STATE_DEVICE',
        'Another device continues this workspace session.'
      );
    }
    const project = await ctx.db
      .prepare('SELECT document_version FROM projects WHERE id = ?')
      .bind(projectId)
      .first<{ document_version: number }>();
    if (!project || project.document_version < documentVersion) {
      refuse(
        409,
        'E2EE_VIEW_STATE_AHEAD',
        'Sync the project before saving its workspace session.'
      );
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before saving this encrypted project.'
    );
  }
  return new Response(null, { status: 204 });
}

// --- Dispatch ----------------------------------------------------------------

/**
 * Handles the encrypted measurement and view-state routes. `projectsEnabled`
 * is the account's E2EE_PROJECTS_ENABLED decision; `authorization` is the
 * session/erasure write predicate (an always-false one for reads).
 */
export async function handleE2eeProjectEnvelopeRequest(
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
      !(await isE2eeProjectVersionStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Encrypted projects are unavailable until the database is updated.'
      );
    }
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    let sessionId: string | null = null;
    const route = match[2]!;
    try {
      projectId = decodeURIComponent(match[1]!);
      if (route.startsWith('view-states/')) {
        sessionId = decodeURIComponent(route.slice('view-states/'.length));
      }
    } catch {
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    const method = request.method;
    const ctx: Context = { db, userId, authorization };
    const known =
      (route === 'measurements' && (method === 'GET' || method === 'PUT')) ||
      (route === 'view-states' && method === 'GET') ||
      (sessionId !== null && method === 'PUT');
    if (!known) refuse(404, 'NOT_FOUND', 'Not found.');
    // The owner reads a project in the recycle bin, as in plaintext (4-8).
    await requireOwnedEncryptedProject(db, userId, projectId, {
      allowDeleted: method === 'GET'
    });
    if (route === 'measurements') {
      return method === 'GET'
        ? json(
            measurementsResponse(
              projectId,
              await measurementsRow(db, projectId)
            )
          )
        : await saveMeasurements(ctx, projectId, request);
    }
    if (sessionId === null) return await loadViewStates(ctx, projectId);
    return await saveViewState(ctx, projectId, sessionId, request);
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
