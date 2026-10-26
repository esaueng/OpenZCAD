/**
 * Encrypted content blobs (ADR-024 Phase 4, content blobs; roadmap L11):
 * the imported sources, mesh payloads, reference-image pictures,
 * thumbnails and archived exports of end-to-end encrypted projects, under
 * `/api/e2ee/projects/:id/blobs…`.
 *
 * A browser encrypts a blob under its own random key, proposes the blob id
 * its envelope header carries, and uploads the ciphertext through the
 * ordinary upload sessions (`/api/uploads/:id/…`, single-part or
 * multipart), so reservations and quotas are the artifacts' own. The key
 * and the ciphertext hash live only in the encrypted document that
 * references the blob, which is what authenticates it.
 *
 * - `POST …/blobs/uploads` `{ blobId, kind }`: an upload session for the
 *   blob (the same one again on a retry), or the committed blob.
 * - `POST …/blobs/:blobId/finalize` `{ uploadSessionId, dedupeTag? }`:
 *   commits the uploaded object after checking what a server can
 *   (`parseEnvelopeShape` over the object's head and size): a content blob
 *   of the session's kind, named by the session's id, within its kind's
 *   ceiling, and exactly as long as `envelopeBodyLength` says; an
 *   uncompressed blob must carry its whole declared plaintext.
 * - `GET …/blobs?tag=…`: the committed blob with that dedupe tag, if any.
 * - `GET …/blobs/:blobId`: the ciphertext.
 *
 * Document versions name their blobs in the header (`blobIds`); the Worker
 * accepts a version only when every one is a committed blob of the project
 * and records the references (`e2ee_version_blobs`). The project-info
 * envelope names the thumbnail and archived exports the same way (slice
 * 4-7); it is replaced as a whole, so its header is read back instead of
 * recorded. Garbage collection keeps the blobs of retained versions and of
 * the current project info (`collectContentBlobs`).
 *
 * Served by `handleE2eeRequest` after the key rollout gate, key-table
 * readiness and, for writes, the session/erasure write authorization. Here:
 * E2EE_PROJECTS_ENABLED, migrations 0031–0034 (503 without them) and
 * format-2 projects only: any member downloads, the owner and editors
 * upload (slice 5-2), against the owner's artifact storage.
 */
import {
  envelopeBodyLength,
  fromBase64Url,
  parseEnvelope,
  parseEnvelopeShape,
  PLAINTEXT_CEILINGS
} from '@openzcad/crypto';
import {
  E2EE_BLOB_ID_PATTERN,
  E2EE_DEDUPE_TAG_PATTERN,
  E2EE_UNREFERENCED_BLOB_GRACE_MS,
  E2EE_UPLOADABLE_BLOB_KINDS,
  type E2eeBlobFinalizeResponse,
  type E2eeBlobLookupResponse,
  type E2eeBlobUploadResponse,
  type E2eeUploadableBlobKind
} from '@openzcad/shared';
import {
  D1R2PersistenceService,
  EncryptedBlobError,
  isE2eeContentBlobStorageReady,
  isE2eeProjectGroupStorageReady,
  isE2eeProjectVersionStorageReady,
  isProjectStorageFormatReady,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  ArtifactQuotaError,
  ArtifactStorageError,
  ProjectFormatUnsupportedError,
  ProjectNotFoundError
} from '@openzcad/persistence';
import {
  RouteError,
  invalid,
  json,
  record,
  refuse,
  requireEncryptedProjectAccess,
  type Authorization
} from './e2eeProjects';

const BLOB_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/blobs(?:\/(uploads|[^/]+\/finalize|[^/]+))?$/;
const MAX_JSON_BODY_BYTES = 16 * 1024;
/** Blobs one housekeeping pass claims and removes (bounded work per save). */
const COLLECT_BATCH = 32;

/** The encrypted content blob routes this module serves. */
export function isE2eeContentBlobPath(pathname: string): boolean {
  return BLOB_ROUTE.test(pathname);
}

/** The object store blobs live in: the artifact bucket uploads write to. */
export interface E2eeBlobBucket {
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number } }
  ): Promise<{
    body?: ReadableStream<Uint8Array>;
    size?: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  delete(key: string): Promise<void>;
}

export interface E2eeBlobRouteEnv {
  DB?: D1Database;
  ARTIFACTS?: unknown;
}

/** The artifact bucket, when this deployment has one. */
export function blobBucket(env: E2eeBlobRouteEnv): E2eeBlobBucket | null {
  const bucket = env.ARTIFACTS as Partial<E2eeBlobBucket> | undefined;
  return bucket &&
    typeof bucket.get === 'function' &&
    typeof bucket.delete === 'function'
    ? (bucket as E2eeBlobBucket)
    : null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (
    Number(request.headers.get('content-length') ?? '0') > MAX_JSON_BODY_BYTES
  ) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  try {
    return record(JSON.parse(text), 'Body');
  } catch (error) {
    if (error instanceof RouteError) throw error;
    invalid('Body must be JSON');
  }
}

function blobIdOf(value: unknown, what = 'blobId'): string {
  if (typeof value !== 'string' || !E2EE_BLOB_ID_PATTERN.test(value)) {
    invalid(`${what} must be 32 lowercase hex characters`);
  }
  return value;
}

function kindOf(value: unknown): E2eeUploadableBlobKind {
  if (
    typeof value !== 'string' ||
    !(E2EE_UPLOADABLE_BLOB_KINDS as readonly string[]).includes(value)
  ) {
    refuse(
      409,
      'E2EE_BLOB_KIND_UNAVAILABLE',
      'Only imported sources, mesh payloads, thumbnails and archived exports are stored encrypted.'
    );
  }
  return value as E2eeUploadableBlobKind;
}

function tagOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !E2EE_DEDUPE_TAG_PATTERN.test(value)) {
    invalid('dedupeTag must be 64 lowercase hex characters');
  }
  return value;
}

/**
 * What a server can check of an uploaded blob without its key: its prefix
 * and its length. Anything else is the reader's job, against the reference
 * in the document that names the blob.
 */
export function inspectUploadedBlob(
  blobId: string,
  head: Uint8Array,
  size: number,
  kind: string
): void {
  const refuseBlob = (why: string): never =>
    refuse(400, 'E2EE_BLOB_INVALID', `The uploaded file is ${why}.`);
  let shape: ReturnType<typeof parseEnvelopeShape>;
  try {
    shape = parseEnvelopeShape(head, size);
  } catch (error) {
    return refuseBlob(
      `not an encrypted content blob (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const header = shape.header;
  if (header.class !== 'content') return refuseBlob('not a content blob');
  if (header.blobId !== blobId) return refuseBlob('another blob than named');
  if (header.kind !== kind) return refuseBlob(`not of kind ${kind}`);
  if (header.plaintextLength > PLAINTEXT_CEILINGS[kind]) {
    return refuseBlob('larger than its kind allows');
  }
  if (
    size !==
    shape.prefix.byteLength +
      envelopeBodyLength(shape.payloadLength, header.chunkSize)
  ) {
    return refuseBlob('not made of whole chunks');
  }
  // Uncompressed, the payload is the plaintext: anything shorter was cut.
  if (
    header.compression === 'none' &&
    shape.payloadLength !== header.plaintextLength
  ) {
    return refuseBlob('shorter than its declared size');
  }
}

/** A committed blob some version whose body is still retained names. */
const RETAINED_REFERENCE = `EXISTS (
  SELECT 1 FROM e2ee_version_blobs refs
  JOIN e2ee_project_versions versions
    ON versions.project_id = refs.project_id
   AND versions.version_hash = refs.version_hash
  WHERE refs.project_id = blobs.project_id AND refs.blob_id = blobs.blob_id
    AND (versions.envelope_key IS NOT NULL
         OR versions.envelope_inline IS NOT NULL)
)`;

/**
 * A dedupe hit is a blob the next save can still name: one a retained
 * version names, or one young enough that garbage collection leaves it
 * alone for at least half its grace period more. An older unreferenced
 * blob is not offered, and the browser uploads the file again.
 */
async function lookupTag(
  db: D1Database,
  projectId: string,
  tag: string,
  now = Date.now()
): Promise<Response> {
  const fresh = new Date(
    now - E2EE_UNREFERENCED_BLOB_GRACE_MS / 2
  ).toISOString();
  const row = await db
    .prepare(
      `SELECT blob_id FROM e2ee_content_blobs blobs
       WHERE project_id = ? AND dedupe_tag = ? AND state = 'committed'
         AND (created_at >= ? OR ${RETAINED_REFERENCE})`
    )
    .bind(projectId, tag, fresh)
    .first<{ blob_id: string }>();
  return json({
    blobId: row?.blob_id ?? null
  } satisfies E2eeBlobLookupResponse);
}

async function download(
  db: D1Database,
  bucket: E2eeBlobBucket,
  projectId: string,
  blobId: string
): Promise<Response> {
  const row = await db
    .prepare(
      `SELECT object_key, ciphertext_bytes FROM e2ee_content_blobs
       WHERE project_id = ? AND blob_id = ? AND state = 'committed'`
    )
    .bind(projectId, blobId)
    .first<{ object_key: string; ciphertext_bytes: number }>();
  if (!row) refuse(404, 'E2EE_BLOB_NOT_FOUND', 'Encrypted file not found.');
  const stored = await bucket.get(row.object_key);
  if (!stored) {
    refuse(
      503,
      'E2EE_BLOB_UNAVAILABLE',
      'This encrypted file cannot be read right now.'
    );
  }
  // Streamed: a blob can be far larger than a Worker may buffer.
  return new Response(stored.body ?? (await stored.arrayBuffer()), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(row.ciphertext_bytes),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

function refusalOf(error: unknown): Response | null {
  if (error instanceof RouteError) {
    return json(
      { error: error.message, code: error.code, ...error.extra },
      error.status
    );
  }
  if (error instanceof EncryptedBlobError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ArtifactQuotaError) {
    return json(
      {
        error: error.message,
        code: 'ARTIFACT_QUOTA_EXCEEDED',
        limitBytes: error.limitBytes
      },
      413
    );
  }
  if (error instanceof ProjectNotFoundError) {
    return json({ error: error.message, code: 'PROJECT_NOT_FOUND' }, 404);
  }
  if (error instanceof ProjectFormatUnsupportedError) {
    return json({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof ArtifactStorageError) {
    return json(
      { error: error.message, code: 'ARTIFACT_STORAGE_UNAVAILABLE' },
      503
    );
  }
  return null;
}

/**
 * Handles the encrypted content blob routes. `projectsEnabled` is the
 * account's E2EE_PROJECTS_ENABLED decision; `authorization` is the
 * session/erasure write predicate (an always-false one for reads).
 */
export async function handleE2eeContentBlobRequest(
  request: Request,
  env: E2eeBlobRouteEnv,
  userId: string,
  projectsEnabled: boolean,
  authorization: Authorization,
  /** Slice 7-1: the request's migration lease, while migration is open. */
  migrationLease: string | null = null
): Promise<Response> {
  try {
    if (!projectsEnabled) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Encrypted projects are not available for this account yet.'
      );
    }
    const db = env.DB;
    if (
      !db ||
      !(await isProjectStorageFormatReady(db)) ||
      !(await isE2eeProjectGroupStorageReady(db)) ||
      !(await isE2eeProjectVersionStorageReady(db)) ||
      !(await isE2eeContentBlobStorageReady(db))
    ) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Encrypted files are unavailable until the database is updated.'
      );
    }
    const url = new URL(request.url);
    const match = BLOB_ROUTE.exec(url.pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    let route = match[2] ?? '';
    let blobId: string | null = null;
    try {
      projectId = decodeURIComponent(match[1]!);
      if (route !== '' && route !== 'uploads') {
        const finalize = route.endsWith('/finalize');
        blobId = decodeURIComponent(
          finalize ? route.slice(0, -'/finalize'.length) : route
        );
        route = finalize ? ':id/finalize' : ':id';
      }
    } catch {
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    const method = request.method;
    const known =
      (method === 'GET' && (route === '' || route === ':id')) ||
      (method === 'POST' && (route === 'uploads' || route === ':id/finalize'));
    if (!known) refuse(404, 'NOT_FOUND', 'Not found.');
    // Any member reads; the owner and editors upload (slice 5-2). The
    // owner reads a project in the recycle bin, as in plaintext (4-8).
    const access = await requireEncryptedProjectAccess(
      db,
      userId,
      projectId,
      method === 'GET' ? 'read' : 'write',
      { allowDeleted: method === 'GET', migrationLease }
    );
    const bucket = blobBucket(env);
    if (!bucket) {
      refuse(
        501,
        'FEATURE_DISABLED',
        'Artifact storage is disabled for this deployment.'
      );
    }
    if (method === 'GET') {
      if (route === '') {
        const tag = tagOf(url.searchParams.get('tag'));
        if (tag === null) invalid('tag is required');
        return await lookupTag(db, projectId, tag);
      }
      return await download(db, bucket, projectId, blobIdOf(blobId));
    }
    const persistence = new D1R2PersistenceService(
      env as unknown as CloudflareEnv
    );
    const body = await readJson(request);
    if (route === 'uploads') {
      const result = await persistence.createEncryptedBlobUpload(
        userId as never,
        {
          projectId,
          blobId: blobIdOf(body.blobId),
          kind: kindOf(body.kind)
        },
        authorization,
        access.staging
      );
      return json(
        (result.committed
          ? {
              committed: true,
              blobId: result.blob.blobId,
              ciphertextBytes: result.blob.ciphertextBytes
            }
          : {
              committed: false,
              session: result.session
            }) satisfies E2eeBlobUploadResponse,
        result.committed ? 200 : 201
      );
    }
    const id = blobIdOf(blobId);
    const uploadSessionId = body.uploadSessionId;
    if (
      typeof uploadSessionId !== 'string' ||
      uploadSessionId.length === 0 ||
      uploadSessionId.length > 128
    ) {
      invalid('uploadSessionId must be an upload session id');
    }
    const committed = await persistence.finalizeEncryptedBlob(
      userId as never,
      {
        projectId,
        blobId: id,
        uploadSessionId,
        dedupeTag: tagOf(body.dedupeTag)
      },
      authorization,
      (head, size, kind) => inspectUploadedBlob(id, head, size, kind),
      access.staging
    );
    return json({
      blobId: committed.blobId,
      kind: committed.kind as E2eeUploadableBlobKind,
      ciphertextBytes: committed.ciphertextBytes
    } satisfies E2eeBlobFinalizeResponse);
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    throw error;
  }
}

// --- Version references and garbage collection ------------------------------

/**
 * Blob ids a document header names that are not committed blobs of the
 * project. A version is accepted only when this is empty; the insert of its
 * references refuses the same in its own batch (migration 0034's trigger).
 */
export async function unknownBlobIds(
  db: D1Database,
  projectId: string,
  blobIds: readonly string[]
): Promise<string[]> {
  if (blobIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT blob_id FROM e2ee_content_blobs
       WHERE project_id = ? AND state = 'committed'
         AND blob_id IN (SELECT value FROM json_each(?))`
    )
    .bind(projectId, JSON.stringify(blobIds))
    .all<{ blob_id: string }>();
  const known = new Set((results ?? []).map((row) => row.blob_id));
  return blobIds.filter((id) => !known.has(id));
}

/** Records the blobs an accepted version names, in the version's batch. */
export function insertVersionBlobs(
  db: D1Database,
  projectId: string,
  versionHash: string,
  blobIds: readonly string[],
  fence: { sql: string; binds: readonly unknown[] }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO e2ee_version_blobs (project_id, version_hash, blob_id)
       SELECT ?, ?, value FROM json_each(?) WHERE ${fence.sql}`
    )
    .bind(projectId, versionHash, JSON.stringify(blobIds), ...fence.binds);
}

/**
 * The blob ids the project's current project-info envelope names in its
 * header, and its sequence (0 without one). An info the Worker cannot read
 * back reports sequence -1, which no claim fences on, so nothing is
 * collected while it stands.
 */
export async function infoBlobIds(
  db: D1Database,
  projectId: string
): Promise<{ sequence: number; blobIds: readonly string[] }> {
  const row = await db
    .prepare(
      `SELECT sequence, envelope FROM e2ee_project_envelopes
       WHERE project_id = ? AND kind = 'project-info' AND scope = ''`
    )
    .bind(projectId)
    .first<{ sequence: number; envelope: string }>();
  if (!row) return { sequence: 0, blobIds: [] };
  try {
    const { header } = parseEnvelope(fromBase64Url(row.envelope));
    if (header.class !== 'project') throw new Error('not a project envelope');
    return { sequence: row.sequence, blobIds: header.blobIds };
  } catch {
    return { sequence: -1, blobIds: [] };
  }
}

/**
 * Garbage collection, after a save prunes bodies: references of versions
 * whose body is gone are dropped, and blobs that no retained version (the
 * head or a named save) names and that are older than the grace period are
 * claimed, then removed object first. Only header `blobIds` of retained
 * versions keep a blob, so the log's bodiless records never do. Migration
 * 0034 refuses a claim on a referenced blob as well. Housekeeping: it never
 * fails a save, and a failed object delete is retried by the next pass.
 */
export async function collectContentBlobs(
  db: D1Database,
  bucket: E2eeBlobBucket | null,
  projectId: string,
  now = Date.now()
): Promise<void> {
  try {
    if (!(await isE2eeContentBlobStorageReady(db))) return;
    const before = new Date(
      now - E2EE_UNREFERENCED_BLOB_GRACE_MS
    ).toISOString();
    // The project info names the thumbnail and archived exports (slice
    // 4-7). The claim below fences on the info it read, so an info saved
    // meanwhile makes this pass claim nothing rather than the wrong blob.
    const info = await infoBlobIds(db, projectId);
    await db.batch([
      db
        .prepare(
          `DELETE FROM e2ee_version_blobs
           WHERE project_id = ? AND NOT EXISTS (
             SELECT 1 FROM e2ee_project_versions versions
             WHERE versions.project_id = e2ee_version_blobs.project_id
               AND versions.version_hash = e2ee_version_blobs.version_hash
               AND (versions.envelope_key IS NOT NULL
                    OR versions.envelope_inline IS NOT NULL)
           )`
        )
        .bind(projectId),
      db
        .prepare(
          `UPDATE e2ee_content_blobs SET state = 'deleting'
           WHERE project_id = ? AND blob_id IN (
             SELECT blob_id FROM e2ee_content_blobs blobs
             WHERE blobs.project_id = ? AND blobs.state = 'committed'
               AND blobs.created_at < ? AND NOT ${RETAINED_REFERENCE}
               AND blobs.blob_id NOT IN (SELECT value FROM json_each(?))
             LIMIT ?
           ) AND COALESCE((
             SELECT sequence FROM e2ee_project_envelopes
             WHERE project_id = ? AND kind = 'project-info' AND scope = ''
           ), 0) = ?`
        )
        .bind(
          projectId,
          projectId,
          before,
          JSON.stringify(info.blobIds),
          COLLECT_BATCH,
          projectId,
          info.sequence
        )
    ]);
    if (!bucket) return;
    const { results } = await db
      .prepare(
        `SELECT blob_id, object_key FROM e2ee_content_blobs
         WHERE project_id = ? AND state = 'deleting' LIMIT ?`
      )
      .bind(projectId, COLLECT_BATCH)
      .all<{ blob_id: string; object_key: string }>();
    const removed: string[] = [];
    for (const row of results ?? []) {
      try {
        await bucket.delete(row.object_key);
        removed.push(row.blob_id);
      } catch {
        // Kept as `deleting`: the next pass deletes the object again.
      }
    }
    if (removed.length) {
      await db
        .prepare(
          `DELETE FROM e2ee_content_blobs
           WHERE project_id = ? AND state = 'deleting'
             AND blob_id IN (SELECT value FROM json_each(?))`
        )
        .bind(projectId, JSON.stringify(removed))
        .run();
    }
  } catch {
    // Housekeeping. It does not get to fail a save.
  }
}
