import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';

/** The least time a "Saving" or "Syncing" label stays up once shown. */
export const SAVE_STATE_MIN_BUSY_MS = 600;

/**
 * How much work a state says is outstanding: a device write (nothing safe
 * anywhere yet), an account upload, or nothing. Other states — failures,
 * conflicts, offline — are not on this scale and always show at once.
 */
function outstanding(state: WorkspaceSaveState): number | null {
  if (state === 'saving') return 2;
  if (state === 'syncing') return 1;
  if (state === 'synced' || state === 'local' || state === 'local-source')
    return 0;
  return null;
}

/**
 * The save state the indicators show. Every edit writes this device's copy
 * and then the account's, so read raw the chip blinked Saving and Syncing in
 * and out for a frame or two on each drag.
 *
 * - A state that says more work is outstanding shows at once: the chip never
 *   says "Saved", or "Syncing" (safe on this device), early.
 * - A state that says less waits until the label on screen has been up for
 *   `minBusyMs`, so a quick save reads as one steady label, not a blink.
 * - Failures, conflicts and the like show at once.
 *
 * Labels belong to one project: another project's save is not this one's.
 */
export function useSteadySaveState(
  state: WorkspaceSaveState,
  projectId: string | null,
  minBusyMs = SAVE_STATE_MIN_BUSY_MS
): WorkspaceSaveState {
  const label = useRef<{
    projectId: string | null;
    state: WorkspaceSaveState;
    since: number;
  } | null>(null);
  const [, setExpired] = useState(0);
  const onScreen =
    label.current?.projectId === projectId ? label.current : null;
  const heldRank = onScreen ? outstanding(onScreen.state) : null;
  const nextRank = outstanding(state);
  const shown: WorkspaceSaveState =
    onScreen &&
    heldRank !== null &&
    nextRank !== null &&
    nextRank < heldRank &&
    Date.now() - onScreen.since < minBusyMs
      ? onScreen.state
      : state;

  useEffect(() => {
    let held = label.current;
    if (!held || held.projectId !== projectId || held.state !== shown) {
      held = { projectId, state: shown, since: Date.now() };
      label.current = held;
    }
    if (shown === state) return;
    const timer = window.setTimeout(
      () => setExpired((count) => count + 1),
      Math.max(0, held.since + minBusyMs - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [projectId, shown, state, minBusyMs]);

  return shown;
}
