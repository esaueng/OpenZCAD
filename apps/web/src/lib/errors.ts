import { isChunkLoadError, STALE_CHUNK_MESSAGE } from './staleChunk';

/**
 * Unwraps a thrown value into something worth showing a user.
 *
 * Anything can be thrown, and a rejected promise from a worker or the
 * network routinely is not an `Error`. The fallback is what the caller would
 * rather say than "[object Object]".
 *
 * A chunk that vanished in a deploy reads as what it is — a newer version is
 * out, reload — rather than "Failed to fetch dynamically imported module:"
 * and a hashed URL in the status line.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (isChunkLoadError(error)) {
    return STALE_CHUNK_MESSAGE;
  }
  return error instanceof Error ? error.message : fallback;
}
