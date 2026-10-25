import { useEffect } from 'react';
import { prefersSavingData } from './saveData';

/**
 * The lazily loaded command cards, fetched ahead of their first use.
 *
 * Each card is its own chunk so the entry chunk stays under its budget, and
 * a chunk is fetched the first time its card renders. On the first Box after
 * a fresh load that left the lane saying "Enter creates · Esc cancels" for
 * an estimated 2–4 s with no card to create from (11 Oct 2026 review, G16;
 * no wall-clock timing was recorded). Fetching them
 * once the workspace is up and the main thread is idle means the first open
 * finds the module already there.
 *
 * Every loader is a dynamic `import()` of the same module the `lazy()` in
 * App.tsx loads, so the chunk is the one the card would have fetched — never
 * a static import, which would pull the card back into the entry chunk.
 */
export const COMMAND_CARD_CHUNKS: readonly (() => Promise<unknown>)[] = [
  // Box and every other create or edit card.
  () => import('../components/Inspector'),
  // The region Extrude editor and the selection's direct edits.
  () => import('../components/ToolCard'),
  () => import('../components/MoveOverlay'),
  // The Sketch tool's plane chooser and the Plane card.
  () => import('../components/SketchPlanePrompt'),
  () => import('../components/forms/DatumPlaneForm')
];

/** Long enough for the workspace's own first frames to go first. */
const IDLE_TIMEOUT_MS = 4000;
/** Where requestIdleCallback is missing (Safari): after first paint settles. */
const FALLBACK_DELAY_MS = 1500;

interface IdleWindow {
  requestIdleCallback?(
    callback: () => void,
    options?: { timeout: number }
  ): number;
  cancelIdleCallback?(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** Runs `task` when the main thread is idle; returns a cancel. */
export function whenIdle(task: () => void, host: IdleWindow): () => void {
  if (host.requestIdleCallback && host.cancelIdleCallback) {
    const handle = host.requestIdleCallback(task, {
      timeout: IDLE_TIMEOUT_MS
    });
    return () => host.cancelIdleCallback?.(handle);
  }
  const handle = host.setTimeout(task, FALLBACK_DELAY_MS);
  return () => host.clearTimeout(handle);
}

/**
 * Fetches each chunk in its own idle slot, one after another, so a slow
 * network never has every card in flight at once beside the kernel. A failed
 * fetch is dropped: the card's own `lazy()` load reports a stale chunk if it
 * fails again when the card is actually opened.
 */
export function prefetchWhenIdle(
  loaders: readonly (() => Promise<unknown>)[],
  host: IdleWindow
): () => void {
  let cancelled = false;
  let cancelPending = () => {};
  const next = (index: number) => {
    const loader = loaders[index];
    if (cancelled || !loader) return;
    cancelPending = whenIdle(() => {
      if (cancelled) return;
      void loader()
        .catch(() => undefined)
        .then(() => next(index + 1));
    }, host);
  };
  next(0);
  return () => {
    cancelled = true;
    cancelPending();
  };
}

/**
 * Prefetches the command cards while `ready` holds (a workspace is open).
 * Leaving the workspace first cancels the rest; the next workspace picks
 * them up, and a chunk already fetched resolves at once from the module map.
 */
export function useCommandCardPrefetch(ready: boolean): void {
  useEffect(() => {
    // Unit tests render the workspace in a DOM shim with no chunks to warm;
    // an idle import there would outlive the test that started it.
    if (!ready || import.meta.env.MODE === 'test') return;
    // Save-Data asks for nothing speculative, as the chunk prefetch and the
    // first-use warm-up honour: a card's chunk loads when the card opens.
    if (prefersSavingData()) return;
    return prefetchWhenIdle(COMMAND_CARD_CHUNKS, window);
  }, [ready]);
}
