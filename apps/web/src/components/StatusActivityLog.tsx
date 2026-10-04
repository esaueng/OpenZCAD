import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type LazyExoticComponent,
  type RefObject
} from 'react';
import { lazyWithStaleChunkNotice } from '../lib/staleChunk';
import { ErrorBoundary } from './ErrorBoundary';
import type { StatusActivityLogPanel as Panel } from './StatusActivityLogPanel';

export type StatusTone = 'ready' | 'warning' | 'running';

export interface StatusLogEntry {
  id: number;
  message: string;
  detail?: string;
  timestamp: number;
  tone: StatusTone;
}

interface StatusActivityLogProps {
  id: string;
  open: boolean;
  status: string;
  detail?: string;
  /**
   * False for a lane-only message — a workspace switch says where the user
   * is, which the log, a record of what happened to the model, leaves out.
   */
  logged?: boolean;
  /**
   * The exact-geometry line while the model is not ready. Logged as entries
   * of its own: when it stood in for the status, a message set meanwhile
   * never reached the log at all.
   */
  geometryStatus?: string | null;
  tone: StatusTone;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose(restoreFocus: boolean): void;
}

// Off the entry chunk: the log records from the start, but its panel is only
// drawn when someone opens it. Once loaded it is drawn directly; until then
// each open gets a fresh lazy wrapper, because React.lazy keeps a rejected
// import for good and a failed load could otherwise never be retried.
let loadedPanel: typeof Panel | null = null;
const lazyPanel = () =>
  lazyWithStaleChunkNotice(() =>
    import('./StatusActivityLogPanel').then((module) => {
      loadedPanel = module.StatusActivityLogPanel;
      return { default: module.StatusActivityLogPanel };
    })
  );

// Status ticks arrive from every hover prompt, save, and rebuild for the life
// of the session; without a bound a day-long session accumulates thousands of
// entries and every append reallocates the array.
const MAX_STATUS_LOG_ENTRIES = 200;

export function StatusActivityLog({
  id,
  open,
  status,
  detail,
  logged = true,
  geometryStatus = null,
  tone,
  triggerRef,
  onClose
}: StatusActivityLogProps) {
  const nextEntryIdRef = useRef(geometryStatus ? 2 : 1);
  const previousStatusRef = useRef({ status, detail, tone, geometryStatus });
  const [attempt, setAttempt] = useState<{
    open: boolean;
    Lazy: LazyExoticComponent<typeof Panel> | null;
  }>({ open: false, Lazy: null });
  if (attempt.open !== open) {
    setAttempt({
      open,
      Lazy: open && !loadedPanel ? lazyPanel() : attempt.Lazy
    });
  }
  const [entries, setEntries] = useState<StatusLogEntry[]>(() => [
    ...(logged
      ? [
          {
            id: 0,
            message: status,
            ...(detail ? { detail } : {}),
            timestamp: Date.now(),
            tone
          }
        ]
      : []),
    ...(geometryStatus
      ? [{ id: 1, message: geometryStatus, timestamp: Date.now(), tone }]
      : [])
  ]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = { status, detail, tone, geometryStatus };
    const added: StatusLogEntry[] = [];
    // A tone change alone is news only for the message it colours; while the
    // geometry line comes or goes, the tone is following that instead.
    if (
      logged &&
      (previous.status !== status ||
        previous.detail !== detail ||
        (previous.tone !== tone &&
          geometryStatus === null &&
          previous.geometryStatus === null))
    ) {
      added.push({
        id: nextEntryIdRef.current++,
        message: status,
        ...(detail ? { detail } : {}),
        timestamp: Date.now(),
        tone
      });
    }
    if (geometryStatus && geometryStatus !== previous.geometryStatus) {
      added.push({
        id: nextEntryIdRef.current++,
        message: geometryStatus,
        timestamp: Date.now(),
        tone
      });
    }
    if (added.length > 0) {
      setEntries((current) =>
        [...current, ...added].slice(-MAX_STATUS_LOG_ENTRIES)
      );
    }
  }, [detail, geometryStatus, logged, status, tone]);

  // Escape is answered here, not in the panel: while its chunk loads (or
  // after it failed) the key must still close the log rather than reach the
  // workspace's Escape ladder and cancel the command behind it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose(true);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [onClose, open]);

  const LogPanel = loadedPanel ?? attempt.Lazy;
  if (!open || !LogPanel) {
    return null;
  }

  // Its own boundary: a tab left open across a deploy asks for a chunk that
  // no longer exists, and that rejection must cost the log, not the
  // workspace behind it. The boundary says so with a Reload; closing and
  // reopening the log mounts a fresh boundary and a fresh import.
  return (
    <ErrorBoundary label="Activity log">
      <Suspense fallback={null}>
        <LogPanel
          id={id}
          entries={entries}
          truncated={nextEntryIdRef.current > MAX_STATUS_LOG_ENTRIES}
          triggerRef={triggerRef}
          onClose={onClose}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
