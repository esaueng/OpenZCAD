import type { ArtifactId, ImportedSourceReference } from '@openzcad/shared';

import {
  loadSourceBlob,
  putSourceBlob,
  sha256Hex
} from './localProjectStore';

/**
 * Bytes a cloud artifact download may stream before the rebuild gives up on
 * it. Aligned with the exact kernel's own STEP import budget
 * (`importStep` in @openzcad/kernel-adapter): anything larger could never be
 * rebuilt, so reading it would only spend memory on bytes that must fail.
 */
const MAX_ARTIFACT_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/**
 * Buffers a response body with a hard byte ceiling, returning null when the
 * body exceeds it. The content-length check is advisory only — a missing or
 * understated header must not let the body grow past the cap while reading.
 */
async function readResponseBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let overflow = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        overflow = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (overflow) {
    return null;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Resolves reference-form exact imports in any browser geometry worker.
 *
 * Local bytes win. The archive is other people's data as often as our own —
 * a shared project can reference a collaborator's upload — so the download
 * is size-capped and its checksum verified BEFORE anything is persisted,
 * keeping a wrong or oversized body out of the blob store and out of the
 * kernel.
 */
export async function resolveExactSourceBytes(
  ref: ImportedSourceReference,
  context: { artifactId: ArtifactId; sourceName: string }
): Promise<Uint8Array> {
  const local = await loadSourceBlob(ref.checksumSha256);
  if (local) {
    return local;
  }
  if (!context.artifactId.startsWith('artifact_local_')) {
    const response = await fetch(
      `/api/artifacts/${context.artifactId}/download`
    );
    if (response.ok) {
      const bytes = await readResponseBytes(
        response,
        MAX_ARTIFACT_DOWNLOAD_BYTES
      );
      if (bytes && (await sha256Hex(bytes)) === ref.checksumSha256) {
        await putSourceBlob(bytes);
        return bytes;
      }
    }
  }
  throw new Error(
    `Import source for "${context.sourceName}" is not in local storage and could not be fetched.`
  );
}
