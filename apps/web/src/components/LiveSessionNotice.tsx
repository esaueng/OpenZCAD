import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/** What every greyed tool and refused press says while the seat connects. */
export const LIVE_SESSION_CONNECTING = 'Connecting to the live session…';

/** How long connecting may take before the notice offers a way out. */
export const LIVE_SESSION_STALL_MS = 8_000;

export interface LiveSessionNoticeProps {
  /** Starts the connection again; omitted while a retry cannot help. */
  onRetry?: () => void;
  /** Test seam: the delay before "Retry" appears. */
  stallMs?: number;
}

/**
 * The one place the workspace says it is waiting for the live session
 * (design review I10). It replaces "Waiting for the project edit lease" on
 * all 35 tool descriptions; the tools stay greyed but keep their own words.
 * After a few seconds it says editing is still waiting and offers Retry.
 */
export function LiveSessionNotice({
  onRetry,
  stallMs = LIVE_SESSION_STALL_MS
}: LiveSessionNoticeProps) {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setStalled(true), stallMs);
    return () => window.clearTimeout(timer);
  }, [stallMs]);
  return (
    <div className="live-session-notice" role="status">
      <span className="live-session-notice-line">
        <LoaderCircle
          size={14}
          aria-hidden="true"
          className="live-session-notice-spinner"
        />
        <strong>{LIVE_SESSION_CONNECTING}</strong>
        <span className="live-session-notice-detail">
          {stalled
            ? 'Still connecting. Editing starts once it connects; your model is unchanged.'
            : 'Editing starts once it connects.'}
        </span>
      </span>
      {stalled && onRetry ? (
        <button
          type="button"
          className="edit-refusal-action is-primary"
          onClick={() => {
            setStalled(false);
            onRetry();
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
