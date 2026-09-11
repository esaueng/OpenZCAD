import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Every merge to main deploys, and a deploy renames every hashed chunk. A tab
 * that was open across one asks for a chunk that no longer exists the next
 * time it opens a lazy panel, and the panel's error boundary greets the user
 * with a crash. The chunk is not coming back, so the only repair is to load
 * the new build: reload once, and only fall through to the boundary if the
 * reload did not help.
 */

const RELOAD_MARK = 'openzcad:chunk-reload-at';
/** A second failure inside this window is not a stale deploy; show it. */
const RELOAD_WINDOW_MS = 60_000;

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Unable to preload CSS/i.test(message)
  );
}

interface ReloadHost {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload(): void;
  now(): number;
}

function sessionStorageOrNull(): ReloadHost['storage'] {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function defaultHost(): ReloadHost {
  return {
    storage: sessionStorageOrNull(),
    reload: () => window.location.reload(),
    now: () => Date.now()
  };
}

/**
 * Reloads the page once for a stale-chunk failure. Returns true when a reload
 * was started, false when one already happened recently and the caller should
 * surface the error instead.
 */
export function reloadForStaleChunk(host: ReloadHost = defaultHost()): boolean {
  const mark = host.storage?.getItem(RELOAD_MARK);
  const last = mark === null || mark === undefined ? null : Number(mark);
  if (
    last !== null &&
    Number.isFinite(last) &&
    host.now() - last < RELOAD_WINDOW_MS
  ) {
    return false;
  }
  try {
    host.storage?.setItem(RELOAD_MARK, String(host.now()));
  } catch {
    // Private mode without storage: still reload; a loop is capped by the
    // browser's own cache of the new index.
  }
  host.reload();
  return true;
}

/**
 * `React.lazy` whose import failure for a missing chunk reloads the page once
 * instead of rendering into the error boundary. While the reload is in
 * flight the promise stays pending so React shows the Suspense fallback, not
 * a flash of the crash.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  host?: ReloadHost
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      if (isChunkLoadError(error) && reloadForStaleChunk(host)) {
        return new Promise<{ default: T }>(() => undefined);
      }
      throw error;
    })
  );
}
