/** Browser-only legacy CAD decoding; the Worker relays storage bytes unchanged. */
import {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  reconcileCopiedImportSources,
  sha256Hex,
  type CopiedImportArchive,
  type ProjectStorageSnapshot
} from '@openzcad/persistence';
import {
  JsonComplexityGuard,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_CLOUD_PROJECT_WRITE_BYTES,
  MAX_E2EE_FRAME_METADATA_BYTES,
  decodeE2eeFrame,
  toArtifactId,
  toProjectId,
  type LegacyProjectStorageMetadata,
  type LegacySourceAlias,
  type ProjectDocument
} from '@openzcad/shared';
import { normalizeDocument } from '@openzcad/document-core';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
function fail(): never {
  throw new Error(
    'The stored project payload is invalid or exceeds its limit.'
  );
}
const size = (
  value: unknown,
  max = MAX_CLOUD_PROJECT_WRITE_BYTES
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;

async function boundedBody(
  response: Response,
  limit: number
): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    fail();
  }
  if (!response.body) return fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > limit) {
        await reader.cancel();
        fail();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function parse(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  new JsonComplexityGuard().consume(text);
  return JSON.parse(text) as unknown;
}

export async function readLegacyProjectFrame(
  response: Response,
  projectId: string,
  fetcher: Fetch,
  onDownload?: (bytes: number) => void
): Promise<ProjectDocument> {
  const bytes = await boundedBody(
    response,
    MAX_CLOUD_PROJECT_WRITE_BYTES + MAX_E2EE_FRAME_METADATA_BYTES + 4
  );
  const frame = decodeE2eeFrame(bytes);
  const meta = frame.metadata as Partial<LegacyProjectStorageMetadata> | null;
  if (
    !meta ||
    meta.version !== 1 ||
    meta.projectId !== projectId ||
    (meta.kind !== 'inline' && meta.kind !== 'snapshot') ||
    !size(meta.storedBytes) ||
    !size(meta.logicalBytes) ||
    meta.storedBytes !== frame.payload.length ||
    !Array.isArray(meta.aliases) ||
    meta.aliases.length > 10_000
  )
    fail();
  const aliases = (meta.aliases as readonly unknown[]).map(
    (value): CopiedImportArchive => {
      const alias = value as Partial<LegacySourceAlias> | null;
      if (
        !alias ||
        alias.projectId !== projectId ||
        (alias.kind !== 'step-import' && alias.kind !== 'mesh-payload') ||
        typeof alias.checksumSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(alias.checksumSha256) ||
        !size(alias.logicalBytes) ||
        typeof alias.artifactId !== 'string' ||
        !/^[!-~]{1,128}$/.test(alias.artifactId)
      )
        return fail();
      return {
        kind: alias.kind,
        checksumSha256: alias.checksumSha256,
        logicalBytes: alias.logicalBytes,
        projectId: toProjectId(projectId),
        artifactId: toArtifactId(alias.artifactId)
      };
    }
  );
  let document: ProjectDocument;
  if (meta.kind === 'inline') {
    if (
      meta.checksumSha256 !== null ||
      meta.logicalBytes !== frame.payload.length
    )
      fail();
    document = parse(frame.payload) as ProjectDocument;
  } else {
    if (
      typeof meta.checksumSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(meta.checksumSha256)
    )
      fail();
    const logical = await decodeProjectStorageBody(
      frame.payload.slice().buffer,
      'gzip',
      meta.logicalBytes
    );
    if (
      logical.length !== meta.logicalBytes ||
      (await sha256Hex(logical)) !== meta.checksumSha256
    )
      fail();
    let assetBytes = 0;
    const loaded = new Map<string, Promise<Uint8Array>>();
    document = await hydrateProjectStorageSnapshot(
      parse(logical) as ProjectStorageSnapshot,
      projectId,
      async (ref) => {
        const known = loaded.get(ref.objectKey);
        if (known) return known;
        if (!size(ref.logicalBytes, MAX_CLOUD_PROJECT_DOCUMENT_BYTES))
          return fail();
        assetBytes += ref.logicalBytes;
        if (assetBytes > MAX_CLOUD_PROJECT_DOCUMENT_BYTES) return fail();
        const pending = (async () => {
          const asset = await fetcher(
            `/api/projects/${encodeURIComponent(projectId)}/storage-assets?key=${encodeURIComponent(ref.objectKey)}`,
            { credentials: 'same-origin' }
          );
          if (!asset.ok)
            throw new Error('A stored project asset is unavailable.');
          const stored = await boundedBody(
            asset,
            MAX_CLOUD_PROJECT_WRITE_BYTES
          );
          const body = await decodeProjectStorageBody(
            stored.buffer,
            ref.contentEncoding,
            ref.logicalBytes
          );
          onDownload?.(stored.length);
          return body;
        })();
        loaded.set(ref.objectKey, pending);
        return pending;
      }
    );
  }
  onDownload?.(bytes.length);
  return reconcileCopiedImportSources(normalizeDocument(document), aliases);
}
