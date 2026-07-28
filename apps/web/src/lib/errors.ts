/**
 * Unwraps a thrown value into something worth showing a user.
 *
 * Anything can be thrown, and a rejected promise from a worker or the
 * network routinely is not an `Error`. The fallback is what the caller would
 * rather say than "[object Object]".
 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
