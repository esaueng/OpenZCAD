import {
  createElement,
  lazy,
  type ComponentType,
  type ComponentProps,
  type LazyExoticComponent,
  type ReactElement
} from 'react';

/**
 * A lazy chunk can fail after a deploy or a connection loss. The browser's
 * error does not distinguish those causes; only the build-version watch can
 * confirm an update. Preserve the workspace and offer user-controlled retry
 * or reload rather than claiming a deploy or reloading unsaved work.
 */

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

export const STALE_CHUNK_MESSAGE =
  'Part of OpenZCAD could not load. Check your connection, then reload the workspace to try again.';

/** Avoid poisoning the browser module cache with a known-offline download. */
export async function loadWhenOnline<T>(load: () => Promise<T>): Promise<T> {
  if (navigator.onLine === false) {
    await new Promise<void>((resolve) => {
      const connected = () => {
        if (navigator.onLine === false) return;
        window.removeEventListener('online', connected);
        resolve();
      };
      window.addEventListener('online', connected);
      connected();
    });
  }
  return load();
}

type StaleChunkListener = () => void;
const listeners = new Set<StaleChunkListener>();

/** Reports a chunk-load symptom, not proof of a newer deployment. */
export function onStaleChunk(listener: StaleChunkListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportStaleChunk(): void {
  for (const listener of listeners) listener();
}

/**
 * `React.lazy` that tells the workspace when a chunk cannot load before the
 * error reaches the panel's boundary, so the boundary's fallback and a
 * Reload notice land together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint
export function lazyWithStaleChunkNotice<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      if (isChunkLoadError(error)) reportStaleChunk();
      throw error;
    })
  );
}

/**
 * Reports chunks that fail to load through Vite's preload helper, which wraps
 * every `import()` in the build and announces a failure as
 * `vite:preloadError`. The lazy panels above already report theirs; this
 * covers the plain `await import()` calls — the demo builders, the import
 * workers — whose failures otherwise reached only a status line. The event
 * is not cancelled: each caller still sees its own rejection.
 */
export function watchPreloadErrors(target: Window = window): () => void {
  const timers = new Set<number>();
  const listener = (event: Event) => {
    const error = (event as Event & { payload?: unknown }).payload;
    if (!isChunkLoadError(error)) return;
    // Vite announces the failure before the import rejects with this same
    // error; decide once the rejection has reached its importer, so a
    // warm-up's failure can be told apart from one the user is waiting on.
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!isSpeculativeFailure(error)) reportStaleChunk();
    }, 0);
    timers.add(timer);
  };
  target.addEventListener('vite:preloadError', listener);
  return () => {
    target.removeEventListener('vite:preloadError', listener);
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
}

/**
 * Errors from warm-ups nobody asked for. They fail silently; the surface's
 * own load reports when the user actually opens it.
 */
const speculativeFailures = new WeakSet<object>();

function isSpeculativeFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    speculativeFailures.has(error)
  );
}

/** A lazy component that can be loaded ahead of its first use. */
export interface PreloadableLazy<P extends object> {
  (props: P): ReactElement;
  /** Loads and evaluates the chunk; later renders need no Suspense. */
  preload(): Promise<void>;
}

/**
 * {@link lazyWithStaleChunkNotice} for a surface that opens on a click and
 * must not open empty. `React.lazy` suspends on its first render even when the
 * chunk is already in the HTTP cache — the module still evaluates
 * asynchronously — so Settings opened blank and the Move panel left a gap for
 * a few frames the first time. Preloaded (or once loaded), this renders the
 * component directly instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint
export function preloadableLazy<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): PreloadableLazy<ComponentProps<T>> {
  type P = ComponentProps<T>;
  let loaded: T | null = null;
  let pending: Promise<{ default: T }> | null = null;
  const load = () =>
    (pending ??= factory().then(
      (module) => {
        loaded = module.default;
        return module;
      },
      (error: unknown) => {
        // A later render or preload may try again (the link may be back).
        pending = null;
        throw error;
      }
    ));
  // Only a render that fails reports a stale chunk: a warm-up that fails
  // offline is not something the user asked for or can see.
  const Lazy = lazy(() =>
    load().catch((error: unknown) => {
      if (isChunkLoadError(error)) reportStaleChunk();
      throw error;
    })
  );
  const Preloadable = ((props: P) =>
    loaded
      ? createElement(loaded, props)
      : createElement(Lazy, props)) as PreloadableLazy<P>;
  Preloadable.preload = () =>
    load().then(
      () => undefined,
      (error: unknown) => {
        if (typeof error === 'object' && error !== null) {
          speculativeFailures.add(error);
        }
        throw error;
      }
    );
  return Preloadable;
}
