import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The least time one message holds the status toast before the next may
 * replace it. A single action can set the status several times in a few
 * frames (rebuild phases, save, selection), and swapping the text at that
 * rate flickers without ever being readable.
 */
export const STATUS_MIN_DWELL_MS = 1200;

export interface PacedStatus<T extends string> {
  status: string;
  tone: T;
  /** Messages replaced while waiting their turn; the activity log has them. */
  skipped: number;
}

/**
 * The status as the toast should draw it: a new message shows at once when
 * the last one has had its dwell, and otherwise waits for it. Messages that
 * arrive while one is waiting replace it, so a burst ends on its latest
 * message rather than queueing, and `skipped` counts what was passed over.
 *
 * While not `live` (hidden, muted or expired) nothing is on screen to be
 * read, so the latest message is taken over at once and the next one to
 * arrive shows without waiting.
 */
export function usePacedStatus<T extends string>(
  status: string,
  tone: T,
  live: boolean
): PacedStatus<T> {
  const [shown, setShown] = useState<PacedStatus<T>>({
    status,
    tone,
    skipped: 0
  });
  const shownAtRef = useRef(live ? Date.now() : Number.NEGATIVE_INFINITY);
  const waitingRef = useRef<{ status: string; tone: T } | null>(null);
  const skippedRef = useRef(0);

  // A layout effect so a toast turning visible never paints the previous
  // message for a frame before the current one replaces it.
  useLayoutEffect(() => {
    if (!live) {
      shownAtRef.current = Number.NEGATIVE_INFINITY;
    }
    if (shown.status === status && shown.tone === tone) {
      waitingRef.current = null;
      skippedRef.current = 0;
      return;
    }
    const waiting = waitingRef.current;
    if (waiting && (waiting.status !== status || waiting.tone !== tone)) {
      skippedRef.current += 1;
    }
    waitingRef.current = { status, tone };
    const show = () => {
      shownAtRef.current = live ? Date.now() : Number.NEGATIVE_INFINITY;
      const skipped = live ? skippedRef.current : 0;
      waitingRef.current = null;
      skippedRef.current = 0;
      setShown({ status, tone, skipped });
    };
    const wait = shownAtRef.current + STATUS_MIN_DWELL_MS - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [status, tone, live, shown.status, shown.tone]);

  if (!live) {
    // Nothing is on screen to pace; never let a stale message stand in.
    return { status, tone, skipped: 0 };
  }
  return shown;
}
