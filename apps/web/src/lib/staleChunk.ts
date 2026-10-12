import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

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
  const listener = (event: Event) => {
    if (isChunkLoadError((event as Event & { payload?: unknown }).payload)) {
      reportStaleChunk();
    }
  };
  target.addEventListener('vite:preloadError', listener);
  return () => target.removeEventListener('vite:preloadError', listener);
}
