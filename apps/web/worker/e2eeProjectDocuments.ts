/**
 * Encrypted document versions (ADR-024 Phase 4, encrypted documents;
 * roadmap L11): create, autosave, named save, load and the version log,
 * under `/api/e2ee/projects` and `/api/e2ee/projects/:id/…`. The Worker
 * stores envelopes it cannot read and keeps the log of every signed header
 * it accepted (decision D1); browsers check that log for rollback and forks.
 *
 * It still checks what it can, as defense in depth:
 *
 * - the envelope's shape and size (`parseEnvelope`): a project envelope of
 *   kind document for this project, with no content blobs (refused until
 *   slice 4-6);
 * - the document version moves forward from the head the write names, and
 *   the header's previous-version hash is the stored head's, which the
 *   Worker computed itself when it accepted that head;
 * - the key epoch is the group's current one, fenced in the same batch
 *   against `e2ee_project_groups`;
 * - the signer is a device the caller's newest device list certifies, and
 *   the signature verifies under its signing key;
 * - retained ciphertext counts against the owner's project storage.
 *
 * Served by `handleE2eeRequest` after the key rollout gate, key-table
 * readiness and, for writes, the session/erasure write authorization. Here:
 * E2EE_PROJECTS_ENABLED, migrations 0031–0033 (503 without them), owner
 * only and format-2 projects only. The plaintext project routes keep
 * refusing format 2.
 */
import {
  parseEnvelope,
  fromBase64Url,
  toBase64Url,
  toHex,
  verifyProjectEnvelopeSignature,
  versionHash as hashVersion,
  type ProjectEnvelopeHeader
} from '@openzcad/crypto';
import {
  E2EE_FRAME_CONTENT_TYPE,
  E2EE_VERSION_LOG_PAGE,
  E2EE_VERSION_LOG_RETAINED_HEADS,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_DOCUMENT_VERSION_ADVANCE,
  MAX_PROJECT_REVISIONS,
  decodeE2eeFrame,
  encodeE2eeFrame,
  type E2eeCreateProjectResponse,
  type E2eeDocumentHeadMetadata,
  type E2eeListProjectsExtension,
  type E2eeProjectEnvelopeRecord,
  type E2eeProjectInfoResponse,
  type E2eeProjectState,
  type E2eeRevisionMetadata,
  type E2eeRevisionsResponse,
  type E2eeSaveVersionResponse,
  type E2eeStoredVersion,
  type E2eeVersionLogEntry,
  type E2eeVersionLogResponse,
  type ListProjectsResponse,
  type ProjectStatus
} from '@openzcad/shared';
import {
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
  deviceListMoved,
  deviceListUnchanged,
  idField,
  insertArchive,
  insertLeaf,
  insertWraps,
  invalid,
  json,
  leafField,
  queryUint,
  record,
  refuse,
  refuseDeviceListMoved,
  requireCertifiedDevice,
  requireOwnedEncryptedProject,
  runBatch,
  uintField,
  wrapsField,
  type Authorization
} from './e2eeProjects';

const CREATE_ROUTE = '/api/e2ee/projects';
const PROJECT_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/(document|versions|revisions|revisions\/[^/]+|info)$/;

/** The encrypted document routes this module serves. */
export function isE2eeProjectDocumentPath(pathname: string): boolean {
  return pathname === CREATE_ROUTE || PROJECT_ROUTE.test(pathname);
}

/** What a format-2 row keeps in `document_json`: never a document. */
export const ENCRYPTED_DOCUMENT_MARKER = 'e2ee-v1';

const WRAP_BYTES = 41;
const VERSION_SIGNATURE_BYTES = 73;
/**
 * A document envelope: the 24 MiB plaintext ceiling, gzip's worst-case
 * growth, a tag per chunk and the prefix (judgment, with room to spare).
 */
const MAX_DOCUMENT_ENVELOPE_BYTES =
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES + 512 * 1024;
const MAX_FRAME_METADATA_BYTES = 512 * 1024;
/** A project-info envelope: 1 MiB of plaintext plus framing (header.ts). */
const MAX_INFO_ENVELOPE_BYTES = 1024 * 1024 + 4176;
const MAX_JSON_BODY_CHARS = 1_500_000;
/**
 * Bodies up to this size are kept inline in D1 (well under its row limit);
 * larger ones go to R2 under an opaque key.
 */
const INLINE_ENVELOPE_BYTES = 256 * 1024;
/** Without an R2 bucket, the most a body may be inline. */
const INLINE_ENVELOPE_LIMIT = 1024 * 1024;

export interface E2eeObjectBucket {
  put(key: string, body: ArrayBuffer | Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

interface Context {
  db: D1Database;
  bucket: E2eeObjectBucket | null;
  userId: string;
  authorization: Authorization;
}

// --- Input -----------------------------------------------------------------

async function readFrame(
  request: Request,
  maxPayload: number
): Promise<{ metadata: Record<string, unknown>; payload: Uint8Array }> {
  const max = 4 + MAX_FRAME_METADATA_BYTES + maxPayload;
  if (Number(request.headers.get('content-length') ?? '0') > max) {
    refuse(413, 'DOCUMENT_TOO_LARGE', 'This document is too large to save.', {
      limitBytes: MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) {
    refuse(413, 'DOCUMENT_TOO_LARGE', 'This document is too large to save.', {
      limitBytes: MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    });
  }
  let frame: ReturnType<typeof decodeE2eeFrame>;
  try {
    frame = decodeE2eeFrame(bytes, MAX_FRAME_METADATA_BYTES);
  } catch {
    invalid('Body must be an encrypted-project frame');
  }
  if (frame.payload.byteLength > maxPayload) {
    refuse(413, 'DOCUMENT_TOO_LARGE', 'This document is too large to save.', {
      limitBytes: MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    });
  }
  return {
    metadata: record(frame.metadata, 'Frame metadata'),
    payload: frame.payload
  };
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

function frameResponse(metadata: unknown, payload: Uint8Array): Response {
  return new Response(encodeE2eeFrame(metadata, payload), {
    status: 200,
    headers: {
      'content-type': E2EE_FRAME_CONTENT_TYPE,
      'cache-control': 'no-store'
    }
  });
}

interface VersionInput {
  expectedVersion: number;
  signature: Uint8Array;
  signatureText: string;
  wrappedVersionKey: string;
  signerDeviceId: string;
}

function versionInput(value: unknown, what: string): VersionInput {
  const input = record(value, what);
  const signature = bytesField(input.signature, `${what}.signature`, {
    exact: VERSION_SIGNATURE_BYTES
  });
  return {
    expectedVersion: uintField(
      input.expectedVersion,
      `${what}.expectedVersion`
    ),
    signature: signature.bytes,
    signatureText: signature.text,
    wrappedVersionKey: bytesField(
      input.wrappedVersionKey,
      `${what}.wrappedVersionKey`,
      { exact: WRAP_BYTES }
    ).text,
    signerDeviceId: idField(input.signerDeviceId, `${what}.signerDeviceId`)
  };
}

interface CheckedVersion {
  header: ProjectEnvelopeHeader;
  prefix: string;
  hash: string;
  envelope: Uint8Array;
  /** The device-list head the signer was certified in. */
  signerList: SignerList;
}

type SignerList = { generation: number; headSequence: number };

/**
 * A document envelope for this project that moves forward from
 * `expectedVersion`, signed by a certified device of the caller.
 */
async function checkedDocumentEnvelope(
  ctx: Context,
  projectId: string,
  envelope: Uint8Array,
  input: VersionInput
): Promise<CheckedVersion> {
  let shape: ReturnType<typeof parseEnvelope>;
  try {
    shape = parseEnvelope(envelope);
  } catch {
    invalid('The body is not an envelope');
  }
  const header = shape.header;
  if (
    header.class !== 'project' ||
    header.kind !== 'document' ||
    header.projectId !== projectId
  ) {
    invalid('The body must be a document envelope for this project');
  }
  if (header.blobIds.length > 0) {
    refuse(
      409,
      'E2EE_CONTENT_BLOBS_UNAVAILABLE',
      'Encrypted projects cannot store imported files, meshes or reference images yet.'
    );
  }
  if (
    header.documentVersion <= input.expectedVersion ||
    header.documentVersion >
      input.expectedVersion + MAX_DOCUMENT_VERSION_ADVANCE
  ) {
    invalid('The document version must move forward from expectedVersion');
  }
  if ((input.expectedVersion === 0) !== (header.previousVersionHash === null)) {
    invalid('Only the first version has no previous version');
  }
  const signerList = await requireSignature(
    ctx,
    envelope,
    input.signature,
    input.signerDeviceId
  );
  return {
    signerList,
    header,
    prefix: toBase64Url(shape.prefix),
    hash: toHex(await hashVersion(envelope)),
    envelope
  };
}

/**
 * The signer is certified in the caller's newest list and signed these
 * bytes. Returns that list's head, which the write is fenced on.
 */
async function requireSignature(
  ctx: Context,
  envelope: Uint8Array,
  signature: Uint8Array,
  deviceId: string
): Promise<SignerList> {
  const { signingKey, generation, headSequence } = await requireCertifiedDevice(
    ctx.db,
    ctx.userId,
    deviceId
  );
  let verified: boolean;
  try {
    verified =
      (await verifyProjectEnvelopeSignature(
        signingKey,
        envelope,
        signature
      )) !== null;
  } catch {
    verified = false;
  }
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The envelope is not signed by the device it names.'
    );
  }
  return { generation, headSequence };
}

interface InfoInput {
  sequence: number;
  envelope: string;
  envelopeBytes: Uint8Array;
  keyEpoch: number;
  wrappedVersionKey: string;
  signature: string;
  signerDeviceId: string;
  signerList: SignerList;
}

async function infoInput(
  ctx: Context,
  value: unknown,
  projectId: string
): Promise<InfoInput> {
  const input = record(value, 'info');
  const envelope = bytesField(input.envelope, 'info.envelope', {
    max: MAX_INFO_ENVELOPE_BYTES
  });
  let header: ReturnType<typeof parseEnvelope>['header'];
  try {
    header = parseEnvelope(envelope.bytes).header;
  } catch {
    invalid('info.envelope is not an envelope');
  }
  if (
    header.class !== 'project' ||
    header.kind !== 'project-info' ||
    header.projectId !== projectId ||
    header.blobIds.length > 0
  ) {
    invalid(
      'info.envelope must be this project’s project-info envelope, without content blobs'
    );
  }
  const signature = bytesField(input.signature, 'info.signature', {
    exact: VERSION_SIGNATURE_BYTES
  });
  const signerDeviceId = idField(input.signerDeviceId, 'info.signerDeviceId');
  const signerList = await requireSignature(
    ctx,
    envelope.bytes,
    signature.bytes,
    signerDeviceId
  );
  return {
    signerList,
    sequence: uintField(input.sequence, 'info.sequence'),
    envelope: envelope.text,
    envelopeBytes: envelope.bytes,
    keyEpoch: header.keyEpoch,
    wrappedVersionKey: bytesField(
      input.wrappedVersionKey,
      'info.wrappedVersionKey',
      { exact: WRAP_BYTES }
    ).text,
    signature: signature.text,
    signerDeviceId
  };
}

// --- Rows ------------------------------------------------------------------

interface VersionRow {
  document_version: number;
  key_epoch: number;
  version_hash: string;
  prefix: string;
  signature: string;
  signer_user_id: string | null;
  signer_device_id: string;
  envelope_key: string | null;
  envelope_inline: string | null;
  envelope_bytes: number;
  wrapped_version_key: string;
  created_at: string;
}

const VERSION_COLUMNS = `document_version, key_epoch, version_hash, prefix,
  signature, signer_user_id, signer_device_id, envelope_key, envelope_inline,
  envelope_bytes, wrapped_version_key, created_at`;

const LOG_COLUMNS = `document_version, key_epoch, version_hash, prefix,
  signature, signer_user_id, signer_device_id, created_at`;

const logEntry = (
  row: Pick<
    VersionRow,
    | 'document_version'
    | 'key_epoch'
    | 'version_hash'
    | 'prefix'
    | 'signature'
    | 'signer_user_id'
    | 'signer_device_id'
    | 'created_at'
  >
): E2eeVersionLogEntry => ({
  documentVersion: row.document_version,
  keyEpoch: row.key_epoch,
  versionHash: row.version_hash,
  prefix: row.prefix,
  signature: row.signature,
  signerUserId: row.signer_user_id,
  signerDeviceId: row.signer_device_id,
  createdAt: row.created_at
});

const storedVersion = (row: VersionRow): E2eeStoredVersion => ({
  ...logEntry(row),
  wrappedVersionKey: row.wrapped_version_key,
  envelopeBytes: row.envelope_bytes
});

interface ProjectRow {
  id: string;
  document_version: number;
  revision_count: number | null;
  last_revision_id: string | null;
  updated_at: string;
  status: string | null;
  pinned: number | null;
  sort_order: number | null;
  deleted_at: string | null;
  archived_at: string | null;
}

const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'active',
  'archived',
  'deleted'
];

function projectState(row: ProjectRow): E2eeProjectState {
  const status = PROJECT_STATUSES.includes(row.status as ProjectStatus)
    ? (row.status as ProjectStatus)
    : 'active';
  return {
    projectId: row.id,
    documentVersion: row.document_version,
    revisionCount: row.revision_count ?? 0,
    lastRevisionId: row.last_revision_id,
    updatedAt: row.updated_at,
    organization: {
      status,
      pinned: row.pinned === 1,
      sortOrder: row.sort_order ?? 0,
      ...(status === 'deleted' && row.deleted_at
        ? { deletedAt: row.deleted_at }
        : {}),
      ...(status === 'archived' && row.archived_at
        ? { archivedAt: row.archived_at }
        : {})
    }
  };
}

async function projectRow(
  db: D1Database,
  projectId: string
): Promise<ProjectRow> {
  const row = await db
    .prepare(
      `SELECT id, document_version, revision_count, last_revision_id,
              updated_at, status, pinned, sort_order, deleted_at, archived_at
       FROM projects WHERE id = ?`
    )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row) refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  return row;
}

async function headRow(
  db: D1Database,
  projectId: string
): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM e2ee_project_versions
       WHERE project_id = ? ORDER BY document_version DESC LIMIT 1`
    )
    .bind(projectId)
    .first<VersionRow>();
}

async function currentKeyEpoch(
  db: D1Database,
  projectId: string
): Promise<number> {
  const group = await db
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
  return group.key_epoch;
}

/** The body of a retained version, or a 503 when its storage lost it. */
async function versionBody(ctx: Context, row: VersionRow): Promise<Uint8Array> {
  if (row.envelope_inline !== null) return fromBase64Url(row.envelope_inline);
  if (row.envelope_key !== null && ctx.bucket) {
    const stored = await ctx.bucket.get(row.envelope_key);
    if (stored) return new Uint8Array(await stored.arrayBuffer());
  }
  refuse(
    503,
    'PROJECT_DOCUMENT_UNAVAILABLE',
    'The account copy of this encrypted project cannot be read right now.'
  );
}

// --- Writes ----------------------------------------------------------------

interface StoredBody {
  key: string | null;
  inline: string | null;
}

/** Puts a body where it belongs: inline when small, R2 otherwise. */
async function storeBody(
  ctx: Context,
  projectId: string,
  version: CheckedVersion
): Promise<StoredBody> {
  const size = version.envelope.byteLength;
  if (size <= INLINE_ENVELOPE_BYTES || !ctx.bucket) {
    if (size > INLINE_ENVELOPE_LIMIT) {
      refuse(
        413,
        'DOCUMENT_TOO_LARGE',
        'This document is too large to save without project storage.',
        { limitBytes: INLINE_ENVELOPE_LIMIT }
      );
    }
    return { key: null, inline: toBase64Url(version.envelope) };
  }
  // Opaque: the project id the row already names and the version hash.
  const key = `e2ee/${projectId}/v/${version.hash}`;
  await ctx.bucket.put(key, version.envelope);
  return { key, inline: null };
}

/** After a refused write: drop an R2 body no row references. */
async function discardBody(ctx: Context, body: StoredBody): Promise<void> {
  if (!body.key || !ctx.bucket) return;
  try {
    const used = await ctx.db
      .prepare(
        'SELECT 1 AS used FROM e2ee_project_versions WHERE envelope_key = ? LIMIT 1'
      )
      .bind(body.key)
      .first<{ used: number }>();
    if (!used) await ctx.bucket.delete(body.key);
  } catch {
    // Housekeeping; an orphan costs storage, never correctness.
  }
}

function insertVersion(
  ctx: Context,
  projectId: string,
  version: CheckedVersion,
  input: VersionInput,
  body: StoredBody,
  now: string,
  fence: { sql: string; binds: readonly unknown[] }
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO e2ee_project_versions
         (project_id, document_version, version_hash, key_epoch, prefix,
          signature, signer_user_id, signer_device_id, envelope_key,
          envelope_inline, envelope_bytes, wrapped_version_key, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence.sql}`
    )
    .bind(
      projectId,
      version.header.documentVersion,
      version.hash,
      version.header.keyEpoch,
      version.prefix,
      input.signatureText,
      ctx.userId,
      input.signerDeviceId,
      body.key,
      body.inline,
      version.envelope.byteLength,
      input.wrappedVersionKey,
      now,
      ...fence.binds
    );
}

/** A quota trigger's refusal, with the owner's limit. */
async function quotaRefusal(ctx: Context, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('project_account_count_quota')) {
    const row = await ctx.db
      .prepare('SELECT project_limit FROM users WHERE id = ?')
      .bind(ctx.userId)
      .first<{ project_limit: number }>();
    refuse(
      413,
      'PROJECT_COUNT_QUOTA',
      'This account cannot hold more projects.',
      { limitCount: row?.project_limit ?? 100 }
    );
  }
  if (message.includes('project_account_storage_quota')) {
    const row = await ctx.db
      .prepare('SELECT project_storage_limit_bytes FROM users WHERE id = ?')
      .bind(ctx.userId)
      .first<{ project_storage_limit_bytes: number }>();
    refuse(
      413,
      'PROJECT_STORAGE_QUOTA',
      'This account has no project storage left for this save.',
      { limitBytes: row?.project_storage_limit_bytes ?? 2147483648 }
    );
  }
  throw error;
}

async function runVersionBatch(
  ctx: Context,
  statements: D1PreparedStatement[]
) {
  try {
    return await runBatch(ctx.db, statements);
  } catch (error) {
    if (error instanceof RouteError) throw error;
    return quotaRefusal(ctx, error);
  }
}

/** Why a fenced write changed nothing: a newer head, a newer epoch, or the session. */
async function explainRefusedWrite(
  ctx: Context,
  projectId: string,
  expectedVersion: number,
  keyEpoch: number,
  previousHash: string | null
): Promise<never> {
  const project = await projectRow(ctx.db, projectId);
  if (project.document_version !== expectedVersion) {
    refuse(
      409,
      'REVISION_CONFLICT',
      `Project ${projectId} has a newer remote revision.`,
      { currentVersion: project.document_version }
    );
  }
  const head = await headRow(ctx.db, projectId);
  if ((head?.version_hash ?? null) !== previousHash) {
    refuse(
      409,
      'E2EE_HEAD_MISMATCH',
      'This version does not build on the stored head. Reload the project.',
      { currentVersion: project.document_version }
    );
  }
  const current = await currentKeyEpoch(ctx.db, projectId);
  if (current !== keyEpoch) {
    refuse(
      409,
      'E2EE_EPOCH_STALE',
      'The project’s keys moved to a newer epoch. Catch up and save again.',
      { keyEpoch: current }
    );
  }
  refuse(
    401,
    'E2EE_SESSION_REQUIRED',
    'Sign in again before saving this encrypted project.'
  );
}

/**
 * Keeps the newest MAX_PROJECT_REVISIONS revisions and, in the log, every
 * retained revision plus the newest E2EE_VERSION_LOG_RETAINED_HEADS heads
 * (decision D6). Pruned bodies leave R2 after their rows commit.
 * Housekeeping: it never fails a save.
 */
async function retain(ctx: Context, projectId: string): Promise<void> {
  try {
    const head = await headRow(ctx.db, projectId);
    if (!head) return;
    // Revisions past the newest MAX_PROJECT_REVISIONS go first.
    const dropped = await ctx.db
      .prepare(
        `SELECT revision_id FROM e2ee_project_revisions WHERE project_id = ?
         ORDER BY document_version DESC LIMIT -1 OFFSET ?`
      )
      .bind(projectId, MAX_PROJECT_REVISIONS)
      .all<{ revision_id: string }>();
    if ((dropped.results ?? []).length) {
      await ctx.db.batch([
        ...(dropped.results ?? []).map((row) =>
          ctx.db
            .prepare(
              'DELETE FROM e2ee_project_revisions WHERE project_id = ? AND revision_id = ?'
            )
            .bind(projectId, row.revision_id)
        ),
        ctx.db
          .prepare(
            `UPDATE projects SET revision_count =
               (SELECT COUNT(*) FROM e2ee_project_revisions WHERE project_id = ?)
             WHERE id = ?`
          )
          .bind(projectId, projectId)
      ]);
    }
    // Bodies nothing retains any more: neither the head nor a revision.
    const orphans = await ctx.db
      .prepare(
        `SELECT document_version, envelope_key FROM e2ee_project_versions v
         WHERE project_id = ? AND document_version <> ?
           AND (envelope_key IS NOT NULL OR envelope_inline IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1 FROM e2ee_project_revisions r
             WHERE r.project_id = v.project_id
               AND r.document_version = v.document_version
           )
         LIMIT 64`
      )
      .bind(projectId, head.document_version)
      .all<{ document_version: number; envelope_key: string | null }>();
    // Another save may have moved the head since it was read: nothing at or
    // past the live head is pruned, whatever this request saw.
    const belowLiveHead = `document_version <
      (SELECT document_version FROM projects WHERE id = ?)`;
    const orphanRows = orphans.results ?? [];
    // The log keeps every retained revision's entry and the newest heads.
    const pruned = await ctx.db.batch([
      ...orphanRows.map((row) =>
        ctx.db
          .prepare(
            `UPDATE e2ee_project_versions SET envelope_key = NULL, envelope_inline = NULL
             WHERE project_id = ? AND document_version = ? AND ${belowLiveHead}
               AND NOT EXISTS (
                 SELECT 1 FROM e2ee_project_revisions r
                 WHERE r.project_id = e2ee_project_versions.project_id
                   AND r.document_version = e2ee_project_versions.document_version
               )`
          )
          .bind(projectId, row.document_version, projectId)
      ),
      ctx.db
        .prepare(
          `DELETE FROM e2ee_project_versions
           WHERE project_id = ? AND document_version < ? AND ${belowLiveHead}
             AND document_version < (
               SELECT MIN(document_version) FROM (
                 SELECT document_version FROM e2ee_project_versions
                 WHERE project_id = ?
                 ORDER BY document_version DESC LIMIT ?
               )
             )
             AND envelope_key IS NULL AND envelope_inline IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM e2ee_project_revisions r
               WHERE r.project_id = e2ee_project_versions.project_id
                 AND r.document_version = e2ee_project_versions.document_version
             )`
        )
        .bind(
          projectId,
          head.document_version,
          projectId,
          projectId,
          E2EE_VERSION_LOG_RETAINED_HEADS
        )
    ]);
    if (ctx.bucket) {
      // Only bodies whose row this request actually cleared.
      await Promise.all(
        orphanRows.flatMap((row, index) =>
          row.envelope_key && (pruned[index]?.meta?.changes ?? 0) === 1
            ? [ctx.bucket!.delete(row.envelope_key)]
            : []
        )
      );
    }
  } catch {
    // Retention is housekeeping. It does not get to fail a save.
  }
}

interface SavedVersion {
  version: CheckedVersion;
  updatedAt: string;
}

/**
 * Writes one version on top of `expectedVersion`: the projects row moves
 * (fenced on the head, the epoch and the session), the replaced head's body
 * is pruned unless a revision keeps it, and the version joins the log.
 * With `revisionId`, the version is also recorded as a named save.
 */
async function writeVersion(
  ctx: Context,
  projectId: string,
  metadata: Record<string, unknown>,
  envelope: Uint8Array,
  revisionId: string | null
): Promise<SavedVersion> {
  const input = versionInput(metadata, 'version');
  if (input.expectedVersion === 0) {
    invalid('expectedVersion must name the stored head');
  }
  const version = await checkedDocumentEnvelope(
    ctx,
    projectId,
    envelope,
    input
  );
  const project = await projectRow(ctx.db, projectId);
  const head = await headRow(ctx.db, projectId);
  if (!head || project.document_version !== input.expectedVersion) {
    refuse(
      409,
      'REVISION_CONFLICT',
      `Project ${projectId} has a newer remote revision.`,
      { currentVersion: project.document_version }
    );
  }
  const previous = version.header.previousVersionHash;
  if (
    head.document_version !== input.expectedVersion ||
    !previous ||
    toHex(previous) !== head.version_hash
  ) {
    refuse(
      409,
      'E2EE_HEAD_MISMATCH',
      'This version does not build on the stored head. Reload the project.',
      { currentVersion: project.document_version }
    );
  }
  const keyEpoch = await currentKeyEpoch(ctx.db, projectId);
  if (version.header.keyEpoch !== keyEpoch) {
    refuse(
      409,
      'E2EE_EPOCH_STALE',
      'The project’s keys moved to a newer epoch. Catch up and save again.',
      { keyEpoch }
    );
  }
  if (revisionId !== null) {
    const taken = await ctx.db
      .prepare(
        `SELECT 1 AS taken FROM e2ee_project_revisions
         WHERE project_id = ? AND revision_id = ?`
      )
      .bind(projectId, revisionId)
      .first<{ taken: number }>();
    if (taken) {
      refuse(
        409,
        'REVISION_ID_CONFLICT',
        'Revision ID conflicts with an existing save state.'
      );
    }
  }
  const body = await storeBody(ctx, projectId, version);
  const now = new Date().toISOString();
  const newVersion = version.header.documentVersion;
  const signerFence = deviceListUnchanged(ctx.userId, version.signerList);
  // Every later statement lands only once the head moved to this version.
  const moved = {
    sql: `EXISTS (SELECT 1 FROM projects WHERE id = ? AND document_version = ?
                  AND storage_format = 2)`,
    binds: [projectId, newVersion] as const
  };
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `UPDATE projects SET document_version = ?, updated_at = ?
         ${revisionId === null ? '' : ', last_revision_id = ?, revision_count = COALESCE(revision_count, 0) + 1'}
         WHERE id = ? AND user_id = ? AND storage_format = 2
           AND status <> 'deleted' AND document_version = ?
           AND ${ctx.authorization.sql}
           AND EXISTS (SELECT 1 FROM e2ee_project_versions
                       WHERE project_id = ? AND document_version = ?
                         AND version_hash = ?)
           AND NOT EXISTS (SELECT 1 FROM e2ee_project_versions
                           WHERE project_id = ? AND document_version > ?)
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
                       WHERE project_id = ? AND key_epoch_base + epoch = ?)
           AND ${signerFence.sql}`
      )
      .bind(
        newVersion,
        now,
        ...(revisionId === null ? [] : [revisionId]),
        projectId,
        ctx.userId,
        input.expectedVersion,
        ...ctx.authorization.binds,
        projectId,
        input.expectedVersion,
        head.version_hash,
        projectId,
        input.expectedVersion,
        projectId,
        keyEpoch,
        ...signerFence.binds
      ),
    // The replaced head's body goes first, so the quota sees the new one
    // replace it; a revision keeps its body.
    ctx.db
      .prepare(
        `UPDATE e2ee_project_versions SET envelope_key = NULL, envelope_inline = NULL
         WHERE project_id = ? AND document_version = ? AND ${moved.sql}
           AND NOT EXISTS (SELECT 1 FROM e2ee_project_revisions
                           WHERE project_id = ? AND document_version = ?)`
      )
      .bind(
        projectId,
        input.expectedVersion,
        ...moved.binds,
        projectId,
        input.expectedVersion
      ),
    insertVersion(ctx, projectId, version, input, body, now, moved),
    ...(revisionId === null
      ? []
      : [
          ctx.db
            .prepare(
              `INSERT INTO e2ee_project_revisions
                 (project_id, revision_id, document_version, version_hash,
                  author_user_id, created_at)
               SELECT ?, ?, ?, ?, ?, ? WHERE ${CHAINED}`
            )
            .bind(
              projectId,
              revisionId,
              newVersion,
              version.hash,
              ctx.userId,
              now
            )
        ])
  ];
  let results: Awaited<ReturnType<typeof runVersionBatch>>;
  try {
    results = await runVersionBatch(ctx, statements);
  } catch (error) {
    await discardBody(ctx, body);
    throw error;
  }
  const accepted =
    (results[0]?.meta?.changes ?? 0) === 1 &&
    (results[2]?.meta?.changes ?? 0) === 1 &&
    (revisionId === null || (results[3]?.meta?.changes ?? 0) === 1);
  if (!accepted) {
    await discardBody(ctx, body);
    if (await deviceListMoved(ctx.db, ctx.userId, version.signerList)) {
      refuseDeviceListMoved();
    }
    return explainRefusedWrite(
      ctx,
      projectId,
      input.expectedVersion,
      version.header.keyEpoch,
      head.version_hash
    );
  }
  if (
    (results[1]?.meta?.changes ?? 0) === 1 &&
    head.envelope_key &&
    ctx.bucket
  ) {
    try {
      await ctx.bucket.delete(head.envelope_key);
    } catch {
      // The row no longer names it; an orphan costs storage only.
    }
  }
  await retain(ctx, projectId);
  return { version, updatedAt: now };
}

async function saveDocument(
  ctx: Context,
  projectId: string,
  request: Request
): Promise<Response> {
  const { metadata, payload } = await readFrame(
    request,
    MAX_DOCUMENT_ENVELOPE_BYTES
  );
  const saved = await writeVersion(
    ctx,
    projectId,
    record(metadata.version, 'version'),
    payload,
    null
  );
  return json({
    projectId,
    version: saved.version.header.documentVersion,
    versionHash: saved.version.hash,
    updatedAt: saved.updatedAt
  } satisfies E2eeSaveVersionResponse);
}

async function saveRevision(
  ctx: Context,
  projectId: string,
  request: Request
): Promise<Response> {
  const { metadata, payload } = await readFrame(
    request,
    MAX_DOCUMENT_ENVELOPE_BYTES
  );
  const version = record(metadata.version, 'version');
  const revisionId = idField(version.revisionId, 'version.revisionId');
  const saved = await writeVersion(
    ctx,
    projectId,
    version,
    payload,
    revisionId
  );
  return json(
    {
      projectId,
      version: saved.version.header.documentVersion,
      versionHash: saved.version.hash,
      updatedAt: saved.updatedAt
    } satisfies E2eeSaveVersionResponse,
    201
  );
}

/**
 * `POST /api/e2ee/projects`: the format-2 project row, its MLS group at
 * epoch 0 (as `…/mls/group-info` takes it), its first version and its
 * project-info envelope land in one D1 batch or not at all.
 */
async function createProject(
  ctx: Context,
  request: Request
): Promise<Response> {
  const { metadata, payload } = await readFrame(
    request,
    MAX_DOCUMENT_ENVELOPE_BYTES
  );
  const projectId = idField(metadata.projectId, 'projectId');
  if (!/^proj_[A-Za-z0-9_-]+$/.test(projectId)) {
    invalid('projectId must be a proj_ id');
  }
  const group = record(metadata.group, 'group');
  const groupId = idField(group.groupId, 'group.groupId');
  const deviceId = idField(group.deviceId, 'group.deviceId');
  const groupInfo = bytesField(group.groupInfo, 'group.groupInfo', {
    max: 256 * 1024
  }).text;
  const leaf = leafField(group.leaf);
  const account = await requireCertifiedDevice(ctx.db, ctx.userId, deviceId);
  const wraps = wrapsField(group.wraps, 0, account);
  const archive = archiveField(group.archive, projectId, 0, deviceId);
  const input = versionInput(metadata.version, 'version');
  if (input.expectedVersion !== 0) invalid('A new project starts at 0');
  if (input.signerDeviceId !== deviceId) {
    invalid('The first version must be signed by the creating device');
  }
  const version = await checkedDocumentEnvelope(ctx, projectId, payload, input);
  if (version.header.keyEpoch !== 0) {
    invalid('The first version is written under key epoch 0');
  }
  const info = await infoInput(ctx, metadata.info, projectId);
  if (info.keyEpoch !== 0 || info.signerDeviceId !== deviceId) {
    invalid(
      'The project info is written under key epoch 0 by the creating device'
    );
  }
  const body = await storeBody(ctx, projectId, version);
  const now = new Date().toISOString();
  const db = ctx.db;
  // The version and the info were checked against this same list.
  const createFence = deviceListUnchanged(ctx.userId, account);
  const statements = [
    db
      .prepare(
        `INSERT INTO projects
           (id, user_id, name, document_json, document_version, document_bytes,
            updated_at, status, pinned, sort_order, last_revision_id,
            revision_count, storage_format)
         SELECT ?, ?, '', ?, ?, 0, ?, 'active', 0, 0, NULL, 0, 2
         WHERE ${ctx.authorization.sql}
           AND NOT EXISTS (SELECT 1 FROM projects WHERE id = ?)
           AND NOT EXISTS (SELECT 1 FROM project_adoptions WHERE cloud_project_id = ?)
           AND ${createFence.sql}`
      )
      .bind(
        projectId,
        ctx.userId,
        ENCRYPTED_DOCUMENT_MARKER,
        version.header.documentVersion,
        now,
        ...ctx.authorization.binds,
        projectId,
        projectId,
        ...createFence.binds
      ),
    db
      .prepare(
        `INSERT INTO e2ee_project_groups
           (project_id, group_id, generation, key_epoch_base, epoch,
            initial_group_info, group_info, group_info_epoch, updated_at)
         SELECT ?, ?, 0, 0, 0, ?, ?, 0, ?
         WHERE ${CHAINED} AND ${PROJECT_FENCE}`
      )
      .bind(
        projectId,
        groupId,
        groupInfo,
        groupInfo,
        now,
        projectId,
        ctx.userId
      ),
    insertLeaf(db, projectId, ctx.userId, deviceId, leaf, now),
    ...insertWraps(db, projectId, ctx.userId, wraps, now),
    insertArchive(db, projectId, archive, now),
    insertVersion(ctx, projectId, version, input, body, now, {
      sql: CHAINED,
      binds: []
    }),
    db
      .prepare(
        `INSERT INTO e2ee_project_envelopes
           (project_id, kind, scope, sequence, key_epoch, envelope,
            wrapped_version_key, signature, signer_device_id, updated_at)
         SELECT ?, 'project-info', '', ?, ?, ?, ?, ?, ?, ? WHERE ${CHAINED}`
      )
      .bind(
        projectId,
        info.sequence === 0 ? 1 : info.sequence,
        info.keyEpoch,
        info.envelope,
        info.wrappedVersionKey,
        info.signature,
        info.signerDeviceId,
        now
      )
  ];
  let results: Awaited<ReturnType<typeof runVersionBatch>>;
  try {
    results = await runVersionBatch(ctx, statements);
  } catch (error) {
    await discardBody(ctx, body);
    if (
      error instanceof RouteError &&
      error.status === 409 &&
      error.code === 'E2EE_CONFLICT'
    ) {
      refuse(409, 'PROJECT_ID_TAKEN', 'That project id is already in use.');
    }
    throw error;
  }
  if (!allChanged(results, statements.length)) {
    await discardBody(ctx, body);
    if (await deviceListMoved(db, ctx.userId, account)) {
      refuseDeviceListMoved();
    }
    const taken = await db
      .prepare(
        `SELECT 1 AS taken FROM projects WHERE id = ?
         UNION ALL SELECT 1 FROM project_adoptions WHERE cloud_project_id = ?
         LIMIT 1`
      )
      .bind(projectId, projectId)
      .first<{ taken: number }>();
    if (taken) {
      refuse(409, 'PROJECT_ID_TAKEN', 'That project id is already in use.');
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before creating an encrypted project.'
    );
  }
  return json(
    {
      projectId,
      version: version.header.documentVersion,
      versionHash: version.hash,
      updatedAt: now,
      project: projectState(await projectRow(db, projectId))
    } satisfies E2eeCreateProjectResponse,
    201
  );
}

async function saveInfo(
  ctx: Context,
  projectId: string,
  request: Request
): Promise<Response> {
  const info = await infoInput(ctx, await readJson(request), projectId);
  if (info.sequence < 1) invalid('info.sequence must be at least 1');
  const keyEpoch = await currentKeyEpoch(ctx.db, projectId);
  if (info.keyEpoch !== keyEpoch) {
    refuse(
      409,
      'E2EE_EPOCH_STALE',
      'The project’s keys moved to a newer epoch. Catch up and save again.',
      { keyEpoch }
    );
  }
  const infoFence = deviceListUnchanged(ctx.userId, info.signerList);
  const now = new Date().toISOString();
  const results = await runVersionBatch(ctx, [
    ctx.db
      .prepare(
        `INSERT INTO e2ee_project_envelopes
           (project_id, kind, scope, sequence, key_epoch, envelope,
            wrapped_version_key, signature, signer_device_id, updated_at)
         SELECT ?, 'project-info', '', ?, ?, ?, ?, ?, ?, ?
         WHERE ${ctx.authorization.sql} AND ${PROJECT_FENCE}
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
                       WHERE project_id = ? AND key_epoch_base + epoch = ?)
           AND ${infoFence.sql}
         ON CONFLICT (project_id, kind, scope) DO UPDATE SET
           sequence = excluded.sequence, key_epoch = excluded.key_epoch,
           envelope = excluded.envelope,
           wrapped_version_key = excluded.wrapped_version_key,
           signature = excluded.signature,
           signer_device_id = excluded.signer_device_id,
           updated_at = excluded.updated_at
         WHERE excluded.sequence > e2ee_project_envelopes.sequence`
      )
      .bind(
        projectId,
        info.sequence,
        info.keyEpoch,
        info.envelope,
        info.wrappedVersionKey,
        info.signature,
        info.signerDeviceId,
        now,
        ...ctx.authorization.binds,
        projectId,
        ctx.userId,
        projectId,
        keyEpoch,
        ...infoFence.binds
      )
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    if (await deviceListMoved(ctx.db, ctx.userId, info.signerList)) {
      refuseDeviceListMoved();
    }
    const stored = await infoRow(ctx.db, projectId);
    if (stored && stored.sequence >= info.sequence) {
      refuse(
        409,
        'E2EE_SEQUENCE_CONFLICT',
        'A newer project info was saved meanwhile.',
        { sequence: stored.sequence }
      );
    }
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before saving this encrypted project.'
    );
  }
  return json({
    info: envelopeRecord(projectId, (await infoRow(ctx.db, projectId))!)
  } satisfies E2eeProjectInfoResponse);
}

// --- Reads -----------------------------------------------------------------

interface EnvelopeRow {
  project_id?: string;
  sequence: number;
  key_epoch: number;
  envelope: string;
  wrapped_version_key: string;
  signature: string;
  signer_device_id: string;
  updated_at: string;
}

const envelopeRecord = (
  projectId: string,
  row: EnvelopeRow
): E2eeProjectEnvelopeRecord => ({
  projectId,
  kind: 'project-info',
  keyEpoch: row.key_epoch,
  sequence: row.sequence,
  envelope: row.envelope,
  wrappedVersionKey: row.wrapped_version_key,
  signature: row.signature,
  signerDeviceId: row.signer_device_id,
  updatedAt: row.updated_at
});

async function infoRow(
  db: D1Database,
  projectId: string
): Promise<EnvelopeRow | null> {
  return db
    .prepare(
      `SELECT sequence, key_epoch, envelope, wrapped_version_key, signature,
              signer_device_id, updated_at
       FROM e2ee_project_envelopes
       WHERE project_id = ? AND kind = 'project-info' AND scope = ''`
    )
    .bind(projectId)
    .first<EnvelopeRow>();
}

async function logPage(
  db: D1Database,
  projectId: string,
  since: number,
  through: number
): Promise<E2eeVersionLogResponse> {
  const { results } = await db
    .prepare(
      `SELECT ${LOG_COLUMNS} FROM e2ee_project_versions
       WHERE project_id = ? AND document_version >= ? AND document_version <= ?
       ORDER BY document_version LIMIT ?`
    )
    .bind(projectId, since, through, E2EE_VERSION_LOG_PAGE + 1)
    .all<VersionRow>();
  const rows = results ?? [];
  return {
    log: rows.slice(0, E2EE_VERSION_LOG_PAGE).map(logEntry),
    more: rows.length > E2EE_VERSION_LOG_PAGE
  };
}

async function loadDocument(
  ctx: Context,
  projectId: string,
  url: URL
): Promise<Response> {
  const since = queryUint(url, 'since');
  const project = await projectRow(ctx.db, projectId);
  const head = await headRow(ctx.db, projectId);
  if (!head || head.document_version !== project.document_version) {
    refuse(
      503,
      'PROJECT_DOCUMENT_UNAVAILABLE',
      'The account copy of this encrypted project cannot be read right now.'
    );
  }
  const envelope = await versionBody(ctx, head);
  const page =
    since === null
      ? { log: [logEntry(head)], more: false }
      : await logPage(ctx.db, projectId, since, head.document_version);
  return frameResponse(
    {
      project: projectState(project),
      head: storedVersion(head),
      log: page.log,
      more: page.more,
      keyEpoch: await currentKeyEpoch(ctx.db, projectId)
    } satisfies E2eeDocumentHeadMetadata,
    envelope
  );
}

async function loadVersions(
  ctx: Context,
  projectId: string,
  url: URL
): Promise<Response> {
  const since = queryUint(url, 'since') ?? 1;
  const head = await headRow(ctx.db, projectId);
  return json(
    head
      ? await logPage(ctx.db, projectId, since, head.document_version)
      : ({ log: [], more: false } satisfies E2eeVersionLogResponse)
  );
}

async function listRevisions(
  ctx: Context,
  projectId: string
): Promise<Response> {
  const { results } = await ctx.db
    .prepare(
      `SELECT r.revision_id, r.document_version, r.version_hash, r.created_at,
              r.author_user_id, v.envelope_bytes
       FROM e2ee_project_revisions r
       JOIN e2ee_project_versions v
         ON v.project_id = r.project_id AND v.document_version = r.document_version
       WHERE r.project_id = ?
       ORDER BY r.document_version DESC LIMIT ?`
    )
    .bind(projectId, MAX_PROJECT_REVISIONS)
    .all<{
      revision_id: string;
      document_version: number;
      version_hash: string;
      created_at: string;
      author_user_id: string | null;
      envelope_bytes: number;
    }>();
  return json({
    revisions: (results ?? []).map((row) => ({
      revisionId: row.revision_id,
      documentVersion: row.document_version,
      versionHash: row.version_hash,
      createdAt: row.created_at,
      authorUserId: row.author_user_id,
      documentBytes: row.envelope_bytes
    })),
    maxRevisions: MAX_PROJECT_REVISIONS
  } satisfies E2eeRevisionsResponse);
}

async function loadRevision(
  ctx: Context,
  projectId: string,
  revisionId: string
): Promise<Response> {
  const row = await ctx.db
    .prepare(
      `SELECT ${VERSION_COLUMNS.split(',')
        .map((column) => `v.${column.trim()}`)
        .join(', ')}
       FROM e2ee_project_revisions r
       JOIN e2ee_project_versions v
         ON v.project_id = r.project_id AND v.document_version = r.document_version
       WHERE r.project_id = ? AND r.revision_id = ?`
    )
    .bind(projectId, revisionId)
    .first<VersionRow>();
  if (!row || (row.envelope_key === null && row.envelope_inline === null)) {
    refuse(404, 'REVISION_NOT_FOUND', 'Revision not found.');
  }
  return frameResponse(
    { revisionId, version: storedVersion(row) } satisfies E2eeRevisionMetadata,
    await versionBody(ctx, row)
  );
}

// --- Dispatch --------------------------------------------------------------

/**
 * Handles the encrypted document routes. `projectsEnabled` is the
 * account's E2EE_PROJECTS_ENABLED decision; `authorization` is the
 * session/erasure write predicate (an always-false one for reads).
 */
export async function handleE2eeProjectDocumentRequest(
  request: Request,
  db: D1Database,
  bucket: E2eeObjectBucket | null,
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
    const ctx: Context = { db, bucket, userId, authorization };
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === CREATE_ROUTE) {
      if (method !== 'POST') refuse(404, 'NOT_FOUND', 'Not found.');
      return await createProject(ctx, request);
    }
    const match = PROJECT_ROUTE.exec(url.pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    let route = match[2]!;
    let revisionId: string | null = null;
    try {
      projectId = decodeURIComponent(match[1]!);
      if (route.startsWith('revisions/')) {
        revisionId = decodeURIComponent(route.slice('revisions/'.length));
        route = 'revisions/:id';
      }
    } catch {
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    const known =
      (method === 'GET' &&
        ['document', 'versions', 'revisions', 'revisions/:id', 'info'].includes(
          route
        )) ||
      (method === 'PUT' && ['document', 'info'].includes(route)) ||
      (method === 'POST' && route === 'revisions');
    if (!known) refuse(404, 'NOT_FOUND', 'Not found.');
    await requireOwnedEncryptedProject(db, userId, projectId);
    switch (`${method} ${route}`) {
      case 'PUT document':
        return await saveDocument(ctx, projectId, request);
      case 'POST revisions':
        return await saveRevision(ctx, projectId, request);
      case 'PUT info':
        return await saveInfo(ctx, projectId, request);
      case 'GET document':
        return await loadDocument(ctx, projectId, url);
      case 'GET versions':
        return await loadVersions(ctx, projectId, url);
      case 'GET revisions':
        return await listRevisions(ctx, projectId);
      case 'GET revisions/:id':
        return await loadRevision(
          ctx,
          projectId,
          idField(revisionId, 'revisionId')
        );
      default: {
        const info = await infoRow(db, projectId);
        return json({
          info: info ? envelopeRecord(projectId, info) : null
        } satisfies E2eeProjectInfoResponse);
      }
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
 * `GET /api/projects` for an account with encrypted projects: their
 * project-info envelopes ride along, so the shelf can decrypt their names
 * without loading documents. Never fails the listing, and names no new
 * table before migration 0033.
 */
export async function withEncryptedProjectInfo(
  db: D1Database | undefined,
  userId: string,
  listing: ListProjectsResponse
): Promise<ListProjectsResponse & E2eeListProjectsExtension> {
  if (
    !db ||
    !listing.projects.some((project) => project.storageFormat === 2) ||
    !(await isE2eeProjectVersionStorageReady(db))
  ) {
    return listing;
  }
  try {
    const { results } = await db
      .prepare(
        `SELECT e.project_id, e.sequence, e.key_epoch, e.envelope,
                e.wrapped_version_key, e.signature, e.signer_device_id, e.updated_at
         FROM e2ee_project_envelopes e
         JOIN projects p ON p.id = e.project_id
         WHERE p.user_id = ? AND p.storage_format = 2
           AND e.kind = 'project-info' AND e.scope = ''`
      )
      .bind(userId)
      .all<EnvelopeRow & { project_id: string }>();
    return {
      ...listing,
      encryptedProjectInfo: (results ?? []).map((row) =>
        envelopeRecord(row.project_id, row)
      )
    };
  } catch {
    return listing;
  }
}

/**
 * Account erasure (migration 0033): with `all`, the owned projects and
 * their versions are already gone, and versions or revisions the account
 * signed in other owners' projects keep their bytes but lose the user.
 * Empty until the tables exist.
 */
export async function projectVersionErasureStatements(
  db: D1Database,
  userId: string,
  scope: 'profile' | 'all'
): Promise<D1PreparedStatement[]> {
  if (scope !== 'all' || !(await isE2eeProjectVersionStorageReady(db))) {
    return [];
  }
  return [
    db
      .prepare(
        'UPDATE e2ee_project_versions SET signer_user_id = NULL WHERE signer_user_id = ?'
      )
      .bind(userId),
    db
      .prepare(
        'UPDATE e2ee_project_revisions SET author_user_id = NULL WHERE author_user_id = ?'
      )
      .bind(userId)
  ];
}
