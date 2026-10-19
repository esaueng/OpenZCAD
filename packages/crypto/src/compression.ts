import { concatBytes, type Bytes } from './bytes';
import { E2eeError } from './errors';

/**
 * Default ceiling for one payload when no kind ceiling applies: the largest
 * per-kind ceiling (128 MiB), as a guard against gzip bombs.
 */
export const DEFAULT_MAX_PLAINTEXT_BYTES = 128 * 1024 * 1024;

function requireCompressionStreams(): void {
  if (
    typeof CompressionStream !== 'function' ||
    typeof DecompressionStream !== 'function'
  ) {
    throw new E2eeError(
      'unavailable',
      'CompressionStream is not available in this runtime'
    );
  }
}

function streamOf(bytes: Uint8Array): ReadableStream<Bytes> {
  return new ReadableStream<Bytes>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    }
  });
}

/** Collects a stream, cancelling it once it passes `maxBytes`. */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Bytes> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new E2eeError(
        'limit-exceeded',
        `Payload is larger than ${maxBytes} bytes`
      );
    }
    parts.push(value);
  }
  return concatBytes(...parts);
}

/** Gzip-compresses bytes before they are encrypted. */
export async function gzipBytes(bytes: Uint8Array): Promise<Bytes> {
  requireCompressionStreams();
  return readAll(
    streamOf(bytes).pipeThrough(new CompressionStream('gzip')),
    Number.MAX_SAFE_INTEGER
  );
}

/** Inflates a gzip payload, refusing output above `maxBytes`. */
export async function gunzipBytes(
  bytes: Uint8Array,
  maxBytes = DEFAULT_MAX_PLAINTEXT_BYTES
): Promise<Bytes> {
  requireCompressionStreams();
  return gunzipStream(streamOf(bytes), maxBytes);
}

export async function gunzipStream(
  stream: ReadableStream<Bytes>,
  maxBytes: number
): Promise<Bytes> {
  requireCompressionStreams();
  try {
    return await readAll(
      stream.pipeThrough(new DecompressionStream('gzip')),
      maxBytes
    );
  } catch (cause) {
    if (cause instanceof E2eeError) throw cause;
    throw new E2eeError('malformed', 'Payload is not valid gzip', { cause });
  }
}

export function compressStream(
  stream: ReadableStream<Bytes>
): ReadableStream<Bytes> {
  requireCompressionStreams();
  return stream.pipeThrough(new CompressionStream('gzip'));
}

export function decompressStream(
  stream: ReadableStream<Bytes>
): ReadableStream<Bytes> {
  requireCompressionStreams();
  return stream.pipeThrough(new DecompressionStream('gzip'));
}
