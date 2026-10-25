import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';

/** How long a save must run before the indicators say it is running. */
export const SAVE_STATE_SETTLE_MS = 700;

function inFlight(state: WorkspaceSaveState): boolean {
  return state === 'saving' || state === 'syncing';
}

/** Marks which opening a piece of state belongs to. */
interface Opening {
  projectId: string | null;
}

/**
 * The save state the indicators show. Every edit writes this device's copy
 * and then the account's, so read raw the chip flipped Saved → Saving →
 * Syncing → Saving on each drag and settled only when the hand stopped.
 *
 * - A save that finishes quickly is never announced: the last settled state
 *   stays up until one has run for `delayMs`.
 * - Once "Syncing" is up, a newer device write does not turn it back to
 *   "Saving": the account copy is still behind either way.
 * - Anything else (offline, a conflict, a failed write) shows at once, and so
 *   does the first state of a newly opened project, which has no settled
 *   state of its own to hold.
 *
 * Everything held belongs to one opening of one project: a reveal or a
 * "Syncing" from the project before must not describe the one after.
 */
export function useSteadySaveState(
  state: WorkspaceSaveState,
  projectId: string | null,
  delayMs = SAVE_STATE_SETTLE_MS
): WorkspaceSaveState {
  const busy = inFlight(state);
  const settled = useRef<(Opening & { state: WorkspaceSaveState }) | null>(
    null
  );
  const syncingShown = useRef<Opening | null>(null);
  const [revealedFor, setRevealedFor] = useState<Opening | null>(null);
  const revealed = revealedFor !== null && revealedFor.projectId === projectId;

  // Closing a project and opening it again is a new opening too: its last
  // "Saved" is not this opening's to show.
  useEffect(() => {
    settled.current = null;
    syncingShown.current = null;
    setRevealedFor(null);
  }, [projectId]);

  useEffect(() => {
    if (busy) return;
    settled.current = { projectId, state };
    syncingShown.current = null;
    setRevealedFor(null);
  }, [busy, projectId, state]);

  useEffect(() => {
    if (!busy || revealed) return;
    const timer = window.setTimeout(
      () => setRevealedFor({ projectId }),
      delayMs
    );
    return () => window.clearTimeout(timer);
  }, [busy, revealed, delayMs, projectId]);

  const held =
    settled.current?.projectId === projectId ? settled.current.state : null;
  const shown: WorkspaceSaveState = !busy
    ? state
    : !revealed && held !== null
      ? held
      : state === 'saving' && syncingShown.current?.projectId === projectId
        ? 'syncing'
        : state;

  useEffect(() => {
    if (shown === 'syncing') syncingShown.current = { projectId };
  }, [shown, projectId]);

  return shown;
}
