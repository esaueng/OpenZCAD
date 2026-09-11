import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Every merge to main deploys, and a deploy renames every hashed chunk. A tab
 * that was open across one asks for a chunk that no longer exists the next
 * time it opens a lazy panel. The chunk is not coming back, but the workspace
 * around the panel still works and may hold unsaved edits, so the page is not
 * reloaded for the user: the failure is named for what it is, and a Reload
 * action is offered where the user can take it.
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
  'OpenZCAD was updated while this tab was open. Reload to load the new version.';

type StaleChunkListener = () => void;
const listeners = new Set<StaleChunkListener>();

/** Called once per stale-chunk failure; returns the unsubscribe. */
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
 * `React.lazy` that tells the workspace when a chunk is missing before the
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
