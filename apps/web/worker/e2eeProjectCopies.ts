/**
 * Copies, branches and adoption of encrypted projects on the Worker
 * (ADR-024 Phase 4, slice 4-8; roadmap L11). `POST /api/e2ee/projects`
 * (`e2eeProjectDocuments.ts`) takes two optional parts beside the new
 * project's group, first version and project info:
 *
 * - `copyFrom: { projectId, blobIds, revisionId? }`, a copy or branch. The
 *   browser decrypted the source and wrote the copy's first version and
 *   project info itself, carrying the source's blob ids and keys; the
 *   Worker copies each listed blob's object byte for byte, under the same
 *   blob id, into the new project's namespace (`e2ee/<copy>/<blobId>`), so
 *   no file is encrypted again. It first checks that the caller owns the
 *   source (an encrypted project, in the recycle bin or not, as a plaintext
 *   owner may copy one), that a branch's revision is a named save of it,
 *   and that every listed id is a committed blob of the source and named by
 *   the new version's or project info's header (a thumbnail or export only
 *   by the project info). The objects go first; the project's rows,
 *   including the copied blobs' rows, then land in one D1 batch fenced on
 *   the source still holding every listed blob. A refused or failed batch
 *   removes the copied objects no committed row names (the rollback).
 * - `adoption: { localProjectId }`, a device project saved to an account
 *   that encrypts new projects (decision D2): bound like a plaintext
 *   adoption (`project_adoptions`), so a retry learns ALREADY_ADOPTED.
 *
 * A create the account already stored (its acknowledgement was lost) is
 * recognised by its first version's envelope hash, not by a document
 * digest, and answered as created rather than refused (the finalize).
 *
 * No migration: the copied blobs are ordinary rows of migration 0034, with
 * its triggers' accounting (copied ciphertext counts against the owner's
 * artifact storage) and erasure fences.
 */
import {
  ARTIFACT_UPLOAD_PART_BYTES,
  E2EE_BLOB_ID_PATTERN,
  E2EE_MAX_COPY_BLOBS,
  type E2eeAdoption,
  type E2eeCopyFrom
} from '@openzcad/shared';
import { encryptedBlobObjectKey } from '@openzcad/cloudflare-adapters';
import { idField, invalid, record, refuse } from './e2eeProjects';

/** What a copy reads of the source's blob rows. */
export interface CopiedBlobRow {
  blob_id: string;
  kind: string;
  object_key: string;
  ciphertext_bytes: number;
}

export interface PreparedCopy {
  sourceProjectId: string;
  revisionId: string | null;
  blobIds: readonly string[];
  rows: readonly CopiedBlobRow[];
}

/** The object store a copy reads and writes: the artifact bucket. */
export interface E2eeBlobCopyBucket {
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number } }
  ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, body: ArrayBuffer | Uint8Array): Promise<unknown>;
  delete(key: string): Promise<void>;
  createMultipartUpload?(key: string): Promise<{
    uploadPart(
      partNumber: number,
      body: ArrayBuffer | Uint8Array
    ): Promise<{ partNumber: number; etag: string }>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
    abort(): Promise<void>;
  }>;
}

/** The bucket, when it can be written to as well as read. */
export function copyBucket(bucket: unknown): E2eeBlobCopyBucket | null {
  const candidate = bucket as Partial<E2eeBlobCopyBucket> | null | undefined;
  return candidate &&
    typeof candidate.get === 'function' &&
    typeof candidate.put === 'function' &&
    typeof candidate.delete === 'function'
    ? (candidate as E2eeBlobCopyBucket)
    : null;
}

// --- Input -----------------------------------------------------------------

export function copyFromField(value: unknown): E2eeCopyFrom {
  const input = record(value, 'copyFrom');
  const projectId = idField(input.projectId, 'copyFrom.projectId');
  if (!Array.isArray(input.blobIds)) {
    invalid('copyFrom.blobIds must be a list');
  }
  if (input.blobIds.length > E2EE_MAX_COPY_BLOBS) {
    invalid(`A copy lists at most ${E2EE_MAX_COPY_BLOBS} files`);
  }
  const blobIds: string[] = [];
  for (const id of input.blobIds) {
    if (typeof id !== 'string' || !E2EE_BLOB_ID_PATTERN.test(id)) {
      invalid('Every blob id must be 32 lowercase hex characters');
    }
    blobIds.push(id);
  }
  if (new Set(blobIds).size !== blobIds.length) {
    invalid('copyFrom.blobIds lists a blob twice');
  }
  return {
    projectId,
    blobIds,
    ...(input.revisionId === undefined
      ? {}
      : { revisionId: idField(input.revisionId, 'copyFrom.revisionId') })
  };
}

export function adoptionField(value: unknown): E2eeAdoption {
  const input = record(value, 'adoption');
  return {
    localProjectId: idField(input.localProjectId, 'adoption.localProjectId')
  };
}

// --- Checks ----------------------------------------------------------------

/**
 * The source is an encrypted project the caller owns or, live, is a member
 * of (slice 5-2: a member copies what it reads, as a plaintext member
 * duplicates; the copy is the caller's own), a branch's revision
 * is one of its named saves, and every listed id is a committed blob of
 * it, named by the new version (`versionBlobIds`) or the new project info
 * (`infoBlobIds`, thumbnails and exports only).
 */
export async function prepareCopy(
  db: D1Database,
  userId: string,
  projectId: string,
  copyFrom: E2eeCopyFrom,
  versionBlobIds: readonly string[],
  infoBlobIds: readonly string[],
  blobsReady: boolean
): Promise<PreparedCopy> {
  if (copyFrom.projectId === projectId) {
    invalid('A copy is a new project');
  }
  const source = await db
    .prepare(
      `SELECT p.user_id, p.storage_format, p.status,
         EXISTS (SELECT 1 FROM project_members m
                 WHERE m.project_id = p.id AND m.user_id = ?) AS member
       FROM projects p WHERE p.id = ?`
    )
    .bind(userId, copyFrom.projectId)
    .first<{
      user_id: string;
      storage_format: number | null;
      status: string | null;
      member: number;
    }>();
  if (
    !source ||
    (source.user_id !== userId &&
      (!source.member || source.status === 'deleted'))
  ) {
    refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  }
  if (source.storage_format !== 2) {
    refuse(
      409,
      'E2EE_PROJECT_NOT_ENCRYPTED',
      'This project is not end-to-end encrypted.'
    );
  }
  if (copyFrom.revisionId !== undefined) {
    const stored = await db
      .prepare(
        `SELECT 1 AS found FROM e2ee_project_revisions
         WHERE project_id = ? AND revision_id = ?`
      )
      .bind(copyFrom.projectId, copyFrom.revisionId)
      .first<{ found: number }>();
    if (!stored) {
      refuse(404, 'REVISION_NOT_FOUND', 'That save state is no longer stored.');
    }
  }
  const listed = new Set(copyFrom.blobIds);
  const named = new Set([...versionBlobIds, ...infoBlobIds]);
  if (copyFrom.blobIds.some((id) => !named.has(id))) {
    invalid('A copy lists only the files its first version or info names');
  }
  const missing = [...named].filter((id) => !listed.has(id));
  if (missing.length) {
    refuse(
      409,
      'E2EE_BLOB_UNKNOWN',
      'This copy names files it does not copy from its source.',
      { blobIds: missing.slice(0, 64) }
    );
  }
  if (copyFrom.blobIds.length === 0) {
    return {
      sourceProjectId: copyFrom.projectId,
      revisionId: copyFrom.revisionId ?? null,
      blobIds: [],
      rows: []
    };
  }
  if (!blobsReady) {
    refuse(
      409,
      'E2EE_CONTENT_BLOBS_UNAVAILABLE',
      'Encrypted projects cannot store imported files, meshes or reference images yet.'
    );
  }
  const { results } = await db
    .prepare(
      `SELECT blob_id, kind, object_key, ciphertext_bytes
       FROM e2ee_content_blobs
       WHERE project_id = ? AND state = 'committed'
         AND blob_id IN (SELECT value FROM json_each(?))`
    )
    .bind(copyFrom.projectId, JSON.stringify(copyFrom.blobIds))
    .all<CopiedBlobRow>();
  const rows = results ?? [];
  const found = new Set(rows.map((row) => row.blob_id));
  const foreign = copyFrom.blobIds.filter((id) => !found.has(id));
  if (foreign.length) {
    refuse(
      409,
      'E2EE_COPY_BLOB_UNKNOWN',
      'This copy lists files its source project does not hold.',
      { blobIds: foreign.slice(0, 64) }
    );
  }
  const infoOnly = new Set(infoBlobIds);
  for (const id of versionBlobIds) infoOnly.delete(id);
  for (const row of rows) {
    const shelfFile = row.kind === 'thumbnail' || row.kind === 'export';
    if (infoOnly.has(row.blob_id) !== shelfFile) {
      invalid(
        'A project info names only thumbnails and exports, and a version none'
      );
    }
  }
  return {
    sourceProjectId: copyFrom.projectId,
    revisionId: copyFrom.revisionId ?? null,
    blobIds: copyFrom.blobIds,
    rows
  };
}

/** The project insert's fence: the source still holds every listed blob. */
export function sourceFence(
  copy: PreparedCopy,
  userId: string
): { sql: string; binds: readonly unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM projects
                  WHERE id = ? AND storage_format = 2
                    AND (user_id = ? OR (status <> 'deleted' AND EXISTS (
                      SELECT 1 FROM project_members m
                      WHERE m.project_id = projects.id AND m.user_id = ?))))
          ${
            copy.revisionId === null
              ? ''
              : `AND EXISTS (SELECT 1 FROM e2ee_project_revisions
                             WHERE project_id = ? AND revision_id = ?)`
          }
          ${
            copy.blobIds.length === 0
              ? ''
              : `AND (SELECT COUNT(*) FROM e2ee_content_blobs
                      WHERE project_id = ? AND state = 'committed'
                        AND blob_id IN (SELECT value FROM json_each(?))) = ?`
          }`,
    binds: [
      copy.sourceProjectId,
      userId,
      userId,
      ...(copy.revisionId === null
        ? []
        : [copy.sourceProjectId, copy.revisionId]),
      ...(copy.blobIds.length === 0
        ? []
        : [
            copy.sourceProjectId,
            JSON.stringify(copy.blobIds),
            copy.blobIds.length
          ])
    ]
  };
}

/**
 * The copied blobs' rows, as the source's (kind and ciphertext size), with
 * the copy's own object keys and no dedupe tag: the copy's dedupe secret is
 * its own, and the browser held no plaintext to tag them with (ADR-024).
 */
export function insertCopiedBlobs(
  db: D1Database,
  projectId: string,
  copy: PreparedCopy,
  now: string,
  fence: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO e2ee_content_blobs
         (project_id, blob_id, kind, object_key, ciphertext_bytes,
          dedupe_tag, state, created_at)
       SELECT ?, blob_id, kind, ? || blob_id, ciphertext_bytes, NULL,
              'committed', ?
       FROM e2ee_content_blobs
       WHERE project_id = ? AND state = 'committed'
         AND blob_id IN (SELECT value FROM json_each(?)) AND ${fence}`
    )
    .bind(
      projectId,
      encryptedBlobObjectKey(projectId, ''),
      now,
      copy.sourceProjectId,
      JSON.stringify(copy.blobIds)
    );
}

// --- Objects -----------------------------------------------------------------

/**
 * Copies each blob's object byte for byte to the new project's key, one
 * part at a time (a multipart upload above one part), so no more than a
 * part is held. Every key it starts writing is added to `written`, which
 * the caller hands to `discardCopiedObjects` when the copy fails: a
 * concurrent retry of the same create may already name those objects.
 */
export async function copyBlobObjects(
  bucket: E2eeBlobCopyBucket,
  projectId: string,
  rows: readonly CopiedBlobRow[],
  written: string[],
  partBytes = ARTIFACT_UPLOAD_PART_BYTES
): Promise<void> {
  function unavailable(): never {
    refuse(
      503,
      'E2EE_COPY_SOURCE_UNAVAILABLE',
      'A file of the project being copied cannot be read right now. Try again.'
    );
  }
  const read = async (key: string, offset: number, length: number) => {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) unavailable();
    // A bucket that ignores the range still yields the whole object.
    const bytes = new Uint8Array(await object.arrayBuffer());
    const part =
      bytes.byteLength > length ? bytes.slice(offset, offset + length) : bytes;
    if (part.byteLength !== length) unavailable();
    return part;
  };
  for (const row of rows) {
    const target = encryptedBlobObjectKey(projectId, row.blob_id);
    const size = row.ciphertext_bytes;
    written.push(target);
    if (size <= partBytes || !bucket.createMultipartUpload) {
      await bucket.put(target, await read(row.object_key, 0, size));
      continue;
    }
    const upload = await bucket.createMultipartUpload(target);
    try {
      const parts: { partNumber: number; etag: string }[] = [];
      for (let offset = 0; offset < size; offset += partBytes) {
        const length = Math.min(partBytes, size - offset);
        parts.push(
          await upload.uploadPart(
            parts.length + 1,
            await read(row.object_key, offset, length)
          )
        );
      }
      await upload.complete(parts);
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
  }
}

/**
 * The rollback: removes copied objects no committed row names (a winning
 * request with the same id may name them; those stay).
 */
export async function discardCopiedObjects(
  db: D1Database,
  bucket: E2eeBlobCopyBucket | null,
  keys: readonly string[]
): Promise<void> {
  if (!bucket || keys.length === 0) return;
  try {
    const { results } = await db
      .prepare(
        `SELECT object_key FROM e2ee_content_blobs
         WHERE object_key IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify(keys))
      .all<{ object_key: string }>();
    const named = new Set((results ?? []).map((row) => row.object_key));
    await Promise.all(
      keys
        .filter((key) => !named.has(key))
        .map((key) => bucket.delete(key).catch(() => undefined))
    );
  } catch {
    // Housekeeping; an orphan costs storage, never correctness.
  }
}

// --- Adoption ------------------------------------------------------------------

/** A device project already saved to this account answers ALREADY_ADOPTED. */
export async function requireNotAdopted(
  db: D1Database,
  userId: string,
  localProjectId: string
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT id AS project_id FROM projects WHERE id = ? AND user_id = ?
       UNION ALL
       SELECT cloud_project_id FROM project_adoptions
       WHERE user_id = ? AND local_project_id = ?
       LIMIT 1`
    )
    .bind(localProjectId, userId, userId, localProjectId)
    .first<{ project_id: string }>();
  if (row) {
    refuse(
      409,
      'ALREADY_ADOPTED',
      'This project is already saved to your account.',
      { projectId: row.project_id }
    );
  }
}

export function insertAdoption(
  db: D1Database,
  userId: string,
  adoption: E2eeAdoption,
  projectId: string,
  fence: { sql: string; binds: readonly unknown[] }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_adoptions (user_id, local_project_id, cloud_project_id)
       SELECT ?, ?, ? WHERE ${fence.sql}`
    )
    .bind(userId, adoption.localProjectId, projectId, ...fence.binds);
}
