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
 * Each listing decrypts every encrypted project's title, so a background tab
 * never refreshes and back-to-back focus/visibility events collapse into one.
 */
export const LIBRARY_REFRESH_INTERVAL_MS = 60_000;
export const LIBRARY_REFRESH_MIN_GAP_MS = 10_000;

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
 * minimum gap. A refresh never overlaps the previous one.
 */
export function watchLibraryFreshness(
  refresh: () => Promise<void>,
  host: LibraryRefreshHost = browserHost()
): () => void {
  let stopped = false;
  let running = false;
  let lastStarted = host.now();

  const trigger = () => {
    if (stopped || running || host.document.visibilityState === 'hidden') {
      return;
    }
    if (host.now() - lastStarted < LIBRARY_REFRESH_MIN_GAP_MS) return;
    running = true;
    lastStarted = host.now();
    void refresh()
      .catch(() => undefined)
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
  return () => {
    stopped = true;
    host.clearInterval(interval);
    host.window.removeEventListener('focus', trigger);
    host.window.removeEventListener('online', trigger);
    host.document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
