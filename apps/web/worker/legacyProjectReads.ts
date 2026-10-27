/** Storage relay only: no CAD JSON parse, migration, hydration or normalization. */
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import {
  assertPlaintextProject,
  ProjectObjectStorageError,
  type PersistenceService
} from '@openzcad/persistence';
import {
  LEGACY_PROJECT_FRAME_CONTENT_TYPE,
  MAX_CLOUD_PROJECT_WRITE_BYTES,
  encodeE2eeFrame,
  type LegacyProjectStorageMetadata,
  type UserId
} from '@openzcad/shared';

interface StorageObject {
  object_key: string;
  checksum_sha256: string;
  logical_bytes: number;
  stored_bytes: number;
  content_encoding: string;
}

const unavailable = () =>
  new ProjectObjectStorageError('The stored project payload is unavailable.');
const missing = () =>
  new Response(JSON.stringify({ error: 'Project or save state not found.' }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

/** Accept negotiation is additive; older Workers keep returning JSON. */
export async function readLegacyProjectStorage(
  env: CloudflareEnv,
  persistence: PersistenceService,
  userId: UserId,
  projectId: string,
  revisionId?: string
): Promise<Response | null> {
  if (!env.DB) return null;
  assertPlaintextProject(
    await persistence.requireProjectRead(userId, projectId)
  );
  const row =
    revisionId === undefined
      ? await env.DB.prepare(
          'SELECT document_json, document_object_id FROM projects WHERE id = ?'
        )
          .bind(projectId)
          .first<{ document_json: string; document_object_id: string | null }>()
      : await env.DB.prepare(
          'SELECT document_json, document_object_id FROM revisions WHERE project_id = ? AND id = ?'
        )
          .bind(projectId, revisionId)
          .first<{
            document_json: string;
            document_object_id: string | null;
          }>();
  if (!row) return missing();
  const { results } = await env.DB.prepare(
    `SELECT source.kind, source.checksum_sha256, source.logical_bytes, source.artifact_id
     FROM project_copy_source_archives source JOIN artifacts ON artifacts.id = source.artifact_id
     WHERE source.project_id = ? AND artifacts.project_id = source.project_id
       AND artifacts.kind = source.kind AND artifacts.bytes = source.logical_bytes
       AND NOT EXISTS (SELECT 1 FROM artifact_mesh_discards WHERE artifact_id = source.artifact_id)`
  )
    .bind(projectId)
    .all<{
      kind: 'step-import' | 'mesh-payload';
      checksum_sha256: string;
      logical_bytes: number;
      artifact_id: string;
    }>();
  const aliases = (results ?? []).map((alias) => ({
    projectId,
    kind: alias.kind,
    checksumSha256: alias.checksum_sha256,
    logicalBytes: alias.logical_bytes,
    artifactId: alias.artifact_id
  }));
  let metadata: LegacyProjectStorageMetadata;
  let payload: ReadableStream<Uint8Array>;
  if (row.document_object_id) {
    const object = await env.DB.prepare(
      `SELECT object_key, checksum_sha256, logical_bytes, stored_bytes, content_encoding
       FROM project_document_objects WHERE id = ? AND project_id = ? AND state = 'committed'`
    )
      .bind(row.document_object_id, projectId)
      .first<StorageObject>();
    if (
      !object ||
      object.content_encoding !== 'gzip' ||
      !validSize(object.logical_bytes) ||
      !validSize(object.stored_bytes) ||
      !/^[a-f0-9]{64}$/.test(object.checksum_sha256)
    )
      throw unavailable();
    const stored = await (env.PROJECT_STORAGE ?? env.ARTIFACTS)?.get(
      object.object_key
    );
    if (!stored || stored.size !== object.stored_bytes) throw unavailable();
    payload = stored.body;
    metadata = {
      version: 1,
      projectId,
      kind: 'snapshot',
      storedBytes: object.stored_bytes,
      logicalBytes: object.logical_bytes,
      checksumSha256: object.checksum_sha256,
      aliases
    };
  } else {
    const bytes = new TextEncoder().encode(row.document_json);
    if (!validSize(bytes.length)) throw unavailable();
    payload = new Response(bytes).body!;
    metadata = {
      version: 1,
      projectId,
      kind: 'inline',
      storedBytes: bytes.length,
      logicalBytes: bytes.length,
      checksumSha256: null,
      aliases
    };
  }
  const reader = payload.getReader();
  let prefix = true;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (prefix) {
          prefix = false;
          controller.enqueue(encodeE2eeFrame(metadata));
          return;
        }
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason)
    }),
    {
      headers: {
        'content-type': LEGACY_PROJECT_FRAME_CONTENT_TYPE,
        'cache-control': 'no-store'
      }
    }
  );
}

function validSize(size: number): boolean {
  return (
    Number.isSafeInteger(size) &&
    size >= 0 &&
    size <= MAX_CLOUD_PROJECT_WRITE_BYTES
  );
}

/** Exact project asset lookup prevents arbitrary bucket paths and cross-project reads. */
export async function readLegacyProjectAsset(
  env: CloudflareEnv,
  persistence: PersistenceService,
  userId: UserId,
  projectId: string,
  objectKey: string
): Promise<Response> {
  assertPlaintextProject(
    await persistence.requireProjectRead(userId, projectId)
  );
  if (!env.DB) return missing();
  const prefix = `project-storage/${projectId}/assets/`;
  if (
    !objectKey.startsWith(prefix) ||
    !/^[a-f0-9]{64}\.(?:step\.txt|mesh\.json)\.gz$/.test(
      objectKey.slice(prefix.length)
    )
  )
    return missing();
  const object = await env.DB.prepare(
    `SELECT object_key, checksum_sha256, logical_bytes, stored_bytes, content_encoding
     FROM project_storage_assets WHERE project_id = ? AND object_key = ?`
  )
    .bind(projectId, objectKey)
    .first<StorageObject>();
  if (
    !object ||
    object.content_encoding !== 'gzip' ||
    !validSize(object.logical_bytes) ||
    !validSize(object.stored_bytes)
  )
    return missing();
  const stored = await (env.PROJECT_STORAGE ?? env.ARTIFACTS)?.get(
    object.object_key
  );
  if (!stored || stored.size !== object.stored_bytes) throw unavailable();
  return new Response(stored.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(object.stored_bytes)
    }
  });
}
