import { useLayoutEffect } from 'react';

/**
 * How many compact surfaces are mounted (the compact workspace frame, the
 * compact library, compact Settings): the document is marked while any is,
 * so dialogs, menus and popovers portalled to the body get the compact
 * tokens too (U12).
 */
let compactSurfacesMounted = 0;

/** Marks the document compact; the returned release unmarks it after the last. */
export function markDocumentCompact(): () => void {
  const root = document.documentElement;
  compactSurfacesMounted += 1;
  root.dataset.shell = 'compact';
  return () => {
    compactSurfacesMounted = Math.max(0, compactSurfacesMounted - 1);
    if (compactSurfacesMounted === 0) delete root.dataset.shell;
  };
}

/** Keeps the document marked compact while `active` holds. */
export function useCompactDocument(active: boolean): void {
  useLayoutEffect(() => (active ? markDocumentCompact() : undefined), [active]);
}
