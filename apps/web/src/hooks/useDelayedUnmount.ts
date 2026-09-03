import { useEffect, useRef, useState } from 'react';

/**
 * Keeps the last non-null value rendered for `ms` after it goes null, so an
 * overlay can play a closing animation before React removes it. `closing` is
 * true during that window; the caller styles the exit off it.
 */
export function useDelayedUnmount<T>(
  value: T | null,
  ms: number
): { rendered: T | null; closing: boolean } {
  const [rendered, setRendered] = useState<T | null>(value);
  const [closing, setClosing] = useState(false);
  const renderedRef = useRef<T | null>(value);

  useEffect(() => {
    if (value !== null) {
      renderedRef.current = value;
      setRendered(value);
      setClosing(false);
      return;
    }
    if (renderedRef.current === null) {
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      renderedRef.current = null;
      setRendered(null);
      setClosing(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);

  return { rendered, closing };
}
