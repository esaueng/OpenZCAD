import { useEffect, useRef, useState } from 'react';

/** An overlay's exit fade; matches `--dur-fast`, which `.closing` runs at. */
export const OVERLAY_EXIT_MS = 100;

/**
 * Keeps the last non-null value rendered for `ms` after it goes null, so an
 * overlay can play a closing animation before React removes it. `closing` is
 * true during that window; the caller styles the exit off it.
 *
 * State changes only when the value appears or disappears, never when a
 * present value is replaced: the selection chip's props are a fresh object on
 * every App render, and mirroring them into state re-rendered the whole
 * viewer shell a second time for each one.
 */
export function useDelayedUnmount<T>(
  value: T | null,
  ms: number
): { rendered: T | null; closing: boolean } {
  const present = value !== null;
  const last = useRef<T | null>(value);
  const [wasPresent, setWasPresent] = useState(present);
  const [closing, setClosing] = useState(false);

  // Derived during render, so the closing frame is the same frame the value
  // left in; an effect would paint one frame with nothing mounted first.
  if (present !== wasPresent) {
    setWasPresent(present);
    setClosing(!present && last.current !== null);
  }

  useEffect(() => {
    if (present) {
      last.current = value;
    }
  });

  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = window.setTimeout(() => {
      last.current = null;
      setClosing(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [closing, ms]);

  return {
    rendered: present ? value : closing ? last.current : null,
    closing: !present && closing
  };
}
