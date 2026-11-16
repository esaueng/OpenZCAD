/**
 * Keeps the Projects shelf current with the account while it is on screen.
 *
 * The shelf is listed when the app starts, on sign-in and on returning from a
 * project. A library tab left open never asked again, so two browsers on one
 * account each kept the listing they first loaded: a rename, pin or save made
 * on one never reached the other until it reloaded. This re-lists when the
 * tab comes back into view or regains focus, and on a slow timer while it is
 * visible.
 *
 * Each listing verifies every encrypted project's title, about two account
 * reads per project, and every browser on the account shares one read
 * budget. So a background tab never refreshes, back-to-back
 * focus/visibility events collapse into one, a shelf covered by Settings
 * waits (`setPaused`) and refreshes once when uncovered, and a listing the
 * account refused with a rate limit (429) waits before asking again:
 * `Retry-After` when the server names one, otherwise twice as long after
 * each refusal from one interval up to `LIBRARY_REFRESH_MAX_BACKOFF_MS`.
 */
import { rateLimitOf, type RateLimit } from './rateLimit';

export const LIBRARY_REFRESH_INTERVAL_MS = 60_000;
export const LIBRARY_REFRESH_MIN_GAP_MS = 10_000;
export const LIBRARY_REFRESH_MAX_BACKOFF_MS = 10 * 60_000;

/**
 * How long to wait after the `failures`-th rate limit in a row: the
 * server's `Retry-After` when it sent one (never under the minimum gap),
 * otherwise doubling from one interval, capped.
 */
export function libraryRefreshBackoffMs(
  failures: number,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined)
    return Math.max(retryAfterMs, LIBRARY_REFRESH_MIN_GAP_MS);
  return Math.min(
    LIBRARY_REFRESH_INTERVAL_MS * 2 ** Math.max(0, failures - 1),
    LIBRARY_REFRESH_MAX_BACKOFF_MS
  );
}

/** A refresh that the account refused with a rate limit, without throwing. */
export interface LibraryRefreshOutcome {
  readonly rateLimited?: RateLimit | null;
}

/** Stops watching when called. */
export type LibraryFreshnessWatch = (() => void) & {
  /**
   * Holds refreshes while the shelf is covered (Settings is open over it).
   * Uncovering it refreshes once, within the usual gap and backoff.
   */
  setPaused(paused: boolean): void;
};

export interface LibraryRefreshHost {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<
    Document,
    'addEventListener' | 'removeEventListener' | 'visibilityState'
  >;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

function browserHost(): LibraryRefreshHost {
  return {
    window,
    document: globalThis.document,
    now: () => Date.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) =>
      window.clearInterval(handle as ReturnType<typeof setInterval>)
  };
}

/**
 * Calls `refresh` while the shelf is shown; returns the stop function. The
 * caller has just listed the shelf, so the first refresh waits for the
 * minimum gap. A refresh never overlaps the previous one. A refresh that
 * reports `rateLimited`, or rejects with a rate limit (`rateLimitOf`),
 * backs off; any other outcome clears the backoff.
 */
export function watchLibraryFreshness(
  refresh: () => Promise<void | LibraryRefreshOutcome>,
  host: LibraryRefreshHost = browserHost()
): LibraryFreshnessWatch {
  let stopped = false;
  let paused = false;
  let running = false;
  let lastStarted = host.now();
  let rateLimits = 0;
  let waitUntil = 0;

  const trigger = () => {
    if (
      stopped ||
      paused ||
      running ||
      host.document.visibilityState === 'hidden'
    ) {
      return;
    }
    const now = host.now();
    if (now - lastStarted < LIBRARY_REFRESH_MIN_GAP_MS) return;
    if (now < waitUntil) return;
    running = true;
    lastStarted = now;
    const settle = (limit: RateLimit | null | undefined) => {
      if (!limit) {
        rateLimits = 0;
        waitUntil = 0;
        return;
      }
      rateLimits += 1;
      waitUntil =
        host.now() + libraryRefreshBackoffMs(rateLimits, limit.retryAfterMs);
    };
    void refresh()
      .then(
        (outcome) => settle(outcome ? outcome.rateLimited : null),
        (error: unknown) => settle(rateLimitOf(error))
      )
      .finally(() => {
        running = false;
      });
  };
  const onVisibilityChange = () => {
    if (host.document.visibilityState === 'visible') trigger();
  };

  const interval = host.setInterval(trigger, LIBRARY_REFRESH_INTERVAL_MS);
  host.window.addEventListener('focus', trigger);
  host.window.addEventListener('online', trigger);
  host.document.addEventListener('visibilitychange', onVisibilityChange);
  const stop = () => {
    stopped = true;
    host.clearInterval(interval);
    host.window.removeEventListener('focus', trigger);
    host.window.removeEventListener('online', trigger);
    host.document.removeEventListener('visibilitychange', onVisibilityChange);
  };
  return Object.assign(stop, {
    setPaused(next: boolean) {
      if (next === paused) return;
      paused = next;
      if (!paused) trigger();
    }
  });
}
