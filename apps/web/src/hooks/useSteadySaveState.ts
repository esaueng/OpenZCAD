import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';

/** The least time a "Saving" or "Syncing" label stays up once shown. */
export const SAVE_STATE_MIN_BUSY_MS = 600;

function inFlight(state: WorkspaceSaveState): boolean {
  return state === 'saving' || state === 'syncing';
}

/** Settled states a busy label may linger over; anything else shows at once. */
function quiet(state: WorkspaceSaveState): boolean {
  return state === 'synced' || state === 'local' || state === 'local-source';
}

/**
 * The save state the indicators show. Every edit writes this device's copy
 * and then the account's, so read raw the chip flipped Saved → Saving →
 * Syncing → Saving on each drag, and a quick save blinked its label for a
 * frame or two.
 *
 * - A save is announced as soon as it starts: the chip never says "Saved"
 *   for work that is not.
 * - Once "Syncing" is up, a newer device write does not turn it back to
 *   "Saving": the account copy is still behind either way.
 * - A busy label stays up for at least `minBusyMs` before a quiet settled
 *   state replaces it. Failures, conflicts and the like replace it at once.
 *
 * All of it belongs to one project: another project's save is not this
 * one's.
 */
export function useSteadySaveState(
  state: WorkspaceSaveState,
  projectId: string | null,
  minBusyMs = SAVE_STATE_MIN_BUSY_MS
): WorkspaceSaveState {
  const busy = inFlight(state);
  const streak = useRef<{
    projectId: string | null;
    since: number;
    label: WorkspaceSaveState;
  } | null>(null);
  const [, setExpired] = useState(0);
  const current =
    streak.current?.projectId === projectId ? streak.current : null;
  const shown: WorkspaceSaveState = busy
    ? state === 'saving' && current?.label === 'syncing'
      ? 'syncing'
      : state
    : current && quiet(state) && Date.now() - current.since < minBusyMs
      ? current.label
      : state;

  useEffect(() => {
    const started = streak.current;
    if (busy) {
      streak.current =
        started?.projectId === projectId
          ? { ...started, label: shown }
          : { projectId, since: Date.now(), label: shown };
      return;
    }
    if (!started || started.projectId !== projectId || shown === state) {
      streak.current = null;
      return;
    }
    const timer = window.setTimeout(
      () => {
        streak.current = null;
        setExpired((count) => count + 1);
      },
      Math.max(0, started.since + minBusyMs - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [busy, projectId, shown, state, minBusyMs]);

  return shown;
}
