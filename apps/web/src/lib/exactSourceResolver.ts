import {
  documentNodesWithHistory,
  importedSourceReferenceOf
} from '@openzcad/shared';
import type {
  ArtifactId,
  ImportedSourceReference,
  ProjectDocument
} from '@openzcad/shared';

import { loadSourceBlob, putSourceBlob, sha256Hex } from './localProjectStore';
import { sharedImportSourceUrl } from './projectShareClient';

/**
 * Bytes a cloud artifact download may stream before the rebuild gives up on
 * it. Aligned with the exact kernel's own STEP import budget
 * (`importStep` in @openzcad/kernel-adapter): anything larger could never be
 * rebuilt, so reading it would only spend memory on bytes that must fail.
 */
const MAX_ARTIFACT_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/**
 * How long a source download may make no progress — no response, no body
 * chunk — before the rebuild treats the source as unavailable. A stalled
 * socket used to hold the serialized geometry queue, every later edit and
 * export behind it, until the host's fifteen-minute watchdog. Idle time, not
 * total time: a large file on a slow but live connection still completes.
 */
export const SOURCE_DOWNLOAD_IDLE_MS = 30_000;

/**
 * Buffers a response body with a hard byte ceiling, returning null when the
 * body exceeds it. The content-length check is advisory only — a missing or
 * understated header must not let the body grow past the cap while reading.
 */
async function readResponseBytes(
  response: Response,
  maxBytes: number,
  onChunk?: () => void
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
      onChunk?.();
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
 * Fetch every reference-form STEP source and mesh payload before opening an
 * anonymous share. Workers resolve from the local content-addressed cache, so
 * a missing or damaged source must stop the open rather than produce an empty
 * viewport.
 */
export async function preloadSharedImportSources(
  document: ProjectDocument,
  token: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const seen = new Set<string>();
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') {
      continue;
    }
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) {
      continue;
    }
    if (seen.has(ref.checksumSha256)) continue;
    seen.add(ref.checksumSha256);
    if (await loadSourceBlob(ref.checksumSha256)) continue;
    const { sourceName, artifactId } = node.data as {
      sourceName: string;
      artifactId: string;
    };
    if (artifactId.startsWith('artifact_local_')) {
      throw new Error(
        `The owner needs to save the source file for "${sourceName}" to their account before this link can open.`
      );
    }
    const response = await fetcher(sharedImportSourceUrl(token, artifactId), {
      credentials: 'omit'
    });
    if (!response.ok) {
      throw new Error(
        `The shared source file for "${sourceName}" is unavailable. Ask the owner to save its source file to their account.`
      );
    }
    const bytes = await readResponseBytes(
      response,
      MAX_ARTIFACT_DOWNLOAD_BYTES
    );
    if (
      !bytes ||
      bytes.byteLength !== ref.logicalBytes ||
      (await sha256Hex(bytes)) !== ref.checksumSha256
    ) {
      throw new Error(
        `The shared source file for "${sourceName}" failed its integrity check.`
      );
    }
    await putSourceBlob(bytes);
  }
}

/**
 * One download per source, shared by every rebuild that asks for it. An edit
 * that superseded a rebuild mid-download used to leave that transfer running
 * while the next rebuild started another, each able to buffer up to the
 * import budget. A superseding rebuild now joins the running transfer, and
 * one that no rebuild has wanted for the idle budget is aborted.
 */
interface SourceDownload {
  bytes: Promise<Uint8Array | null>;
  abort(): void;
  /** Callers waiting on it whose rebuilds have not been superseded. */
  wanted: number;
  unwanted?: ReturnType<typeof setTimeout>;
}
let downloads: Map<string, SourceDownload> | undefined;

function startDownload(key: string, artifactId: ArtifactId): SourceDownload {
  const controller = new AbortController();
  const forget = () => {
    if (downloads?.get(key) === download) downloads.delete(key);
  };
  let idle: ReturnType<typeof setTimeout> | undefined;
  const progressed = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), SOURCE_DOWNLOAD_IDLE_MS);
  };
  progressed();
  // An abandoned transfer is never joined while it winds down.
  controller.signal.addEventListener('abort', forget);
  const download: SourceDownload = {
    wanted: 0,
    abort: () => controller.abort(),
    bytes: (async () => {
      const response = await fetch(
        `/api/artifacts/${encodeURIComponent(artifactId)}/download`,
        { signal: controller.signal }
      );
      progressed();
      return response.ok
        ? readResponseBytes(response, MAX_ARTIFACT_DOWNLOAD_BYTES, progressed)
        : null;
    })()
      // Stalled, abandoned (aborted) or failed: reported as unavailable.
      .catch(() => null)
      .then(async (bytes) => {
        clearTimeout(idle);
        clearTimeout(download.unwanted);
        if (!bytes || (await sha256Hex(bytes)) !== key) return null;
        await putSourceBlob(bytes);
        return bytes;
      })
      .finally(forget)
  };
  return download;
}

function joinDownload(
  key: string,
  artifactId: ArtifactId,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  downloads ??= new Map();
  let download = downloads.get(key);
  if (!download) {
    download = startDownload(key, artifactId);
    downloads.set(key, download);
  }
  const joined = download;
  clearTimeout(joined.unwanted);
  joined.wanted += 1;
  // A caller with no signal wants the bytes for good. A superseded one lets
  // go; the rebuild that superseded it normally joins within moments.
  const release = () => {
    joined.wanted -= 1;
    if (joined.wanted === 0) {
      joined.unwanted = setTimeout(joined.abort, SOURCE_DOWNLOAD_IDLE_MS);
    }
  };
  if (signal?.aborted) release();
  else signal?.addEventListener('abort', release, { once: true });
  return joined.bytes;
}

/**
 * Resolves reference-form imports — STEP sources and mesh payloads — in any
 * browser geometry worker.
 *
 * Local bytes win. The archive is other people's data as often as our own —
 * a shared project can reference a collaborator's upload — so the download
 * is size-capped and its checksum verified BEFORE anything is persisted,
 * keeping a wrong or oversized body out of the blob store and out of the
 * kernel.
 */
export async function resolveExactSourceBytes(
  ref: ImportedSourceReference,
  context: { artifactId: ArtifactId; sourceName: string; signal?: AbortSignal }
): Promise<Uint8Array> {
  const local = await loadSourceBlob(ref.checksumSha256);
  if (local) {
    return local;
  }
  // A device-only source missing here can never arrive; a cloud copy can.
  const permanent = context.artifactId.startsWith('artifact_local_');
  const bytes = permanent
    ? null
    : await joinDownload(
        ref.checksumSha256,
        context.artifactId,
        context.signal
      );
  if (bytes) {
    return bytes;
  }
  throw Object.assign(
    new Error(
      `Import source for "${context.sourceName}" is not in local storage and could not be fetched.`
    ),
    { permanent }
  );
}
