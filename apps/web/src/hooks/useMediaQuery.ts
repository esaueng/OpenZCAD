import { useCallback, useSyncExternalStore } from 'react';

/**
 * A device that only takes touch: no hover and a coarse pointer. Hints that
 * name keys or hover give way to touch wording there. A tablet with a
 * keyboard and trackpad reports hover, so it keeps its key hints.
 */
export const TOUCH_ONLY_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Whether a CSS media query matches, kept current as the window changes.
 * False where `matchMedia` is unavailable (a test environment without it).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) {
        return () => {};
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.(query).matches),
    () => false
  );
}
