/**
 * Telling an API rate limit (HTTP 429) apart from every other failure.
 *
 * A signed-in account shares one read budget across all of its browsers
 * (`ACCOUNT_READ_LIMITER` in the Worker). A background listing that keeps
 * asking after a 429 only spends the budget the user's next click needs, so
 * the background paths stop at the first one and wait before asking again.
 * A 429 says nothing about the session either: it is never "signed out"
 * (see `accountSession.ts`).
 */

/** The longest a server-named wait is honoured for, so a bad header cannot stop refreshes for good. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * The response's `Retry-After`, in milliseconds from `now`: either delay
 * seconds or an HTTP date. Undefined when absent or unreadable.
 */
export function retryAfterMs(
  headers: Pick<Headers, 'get'> | undefined,
  now: number = Date.now()
): number | undefined {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

export interface RateLimit {
  /** The server's `Retry-After`, when it sent one. */
  readonly retryAfterMs?: number;
}

/**
 * The rate limit behind `error`, looking through `cause` chains, or null
 * when it is not one. Matches any refusal that carries `status: 429`
 * (`ApiError`, `E2eeApiError` and its subclasses).
 */
export function rateLimitOf(error: unknown): RateLimit | null {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const candidate = current as {
      status?: unknown;
      retryAfterMs?: unknown;
      cause?: unknown;
    };
    if (current instanceof Error && candidate.status === 429) {
      return typeof candidate.retryAfterMs === 'number'
        ? { retryAfterMs: candidate.retryAfterMs }
        : {};
    }
    current = candidate.cause;
  }
  return null;
}

export function isRateLimitError(error: unknown): boolean {
  return rateLimitOf(error) !== null;
}
