import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const NONE: ReadonlySet<string> = new Set();

/**
 * The ids that joined `ids` since the previous render, held for `holdMs` so a
 * one-shot arrival animation can finish even when an unrelated re-render (the
 * new feature being selected, say) lands mid-way.
 *
 * Nothing arrives on the first render, or when the list was empty before:
 * opening a panel or loading a project fills the list all at once, and
 * flagging every row would announce nothing. The diff runs in a layout effect
 * so the class is on the row before its first paint; set a frame later, the
 * row would show at rest and then jump back to the animation's start.
 */
export function useArrivals(
  ids: readonly string[],
  holdMs: number
): ReadonlySet<string> {
  const known = useRef<ReadonlySet<string> | null>(null);
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(NONE);
  const signature = ids.join('\n');

  useLayoutEffect(() => {
    const current = new Set(signature ? signature.split('\n') : []);
    const previous = known.current;
    known.current = current;
    if (previous === null || previous.size === 0) {
      return;
    }
    const fresh = [...current].filter((id) => !previous.has(id));
    if (fresh.length > 0) {
      setArrivals(new Set(fresh));
    }
  }, [signature]);

  useEffect(() => {
    if (arrivals.size === 0) {
      return;
    }
    const timer = window.setTimeout(() => setArrivals(NONE), holdMs);
    return () => window.clearTimeout(timer);
  }, [arrivals, holdMs]);

  return arrivals;
}
