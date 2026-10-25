import { useCallback, useState } from 'react';
import {
  effectivePanels,
  type PanelState,
  type SuspendablePanel
} from '../lib/panelState';

type ReleaseRequests = Record<SuspendablePanel, number> & { version: number };

/**
 * Suspends every open model panel and the "More tools" fold while a sketch
 * or feature form is open, and brings them back when it ends. Derived rather
 * than written at every way in and out of it, so no entry or exit path can
 * forget to restore them, and the stored layout is never touched. A
 * direct-manipulation drag leaves them where they are. See `effectivePanels`.
 */
export function usePanelSuspension(
  state: Pick<PanelState, 'commandFoldOpen'>,
  mode: { sketching: boolean; editing?: boolean; sessionId?: string | null }
) {
  const session = mode.sketching
    ? `sketch:${mode.sessionId ?? ''}`
    : mode.editing
      ? `feature:${mode.sessionId ?? ''}`
      : null;
  const suspended = session !== null;
  const [lastSession, setLastSession] = useState(session);
  const [requests, setRequests] = useState<ReleaseRequests>({
    panels: 0,
    fold: 0,
    version: 0
  });
  const [observedRequest, setObservedRequest] = useState(0);
  const changed = lastSession !== session;
  const freshPanelRequest = requests.panels > observedRequest;
  const freshFoldRequest = requests.fold > observedRequest;
  // A release belongs to one editing session, even when two suspended modes
  // follow each other without an idle render in between.
  if (changed) {
    setLastSession(session);
    // A search result may open a new form and explicitly reveal History in
    // the same event. Keep that fresh request, not the old session's release.
    setRequests((current) => ({
      ...current,
      panels: freshPanelRequest ? current.panels : 0,
      fold: freshFoldRequest ? current.fold : 0
    }));
  }
  if (observedRequest !== requests.version)
    setObservedRequest(requests.version);
  const panelsReleased =
    suspended && requests.panels > 0 && (!changed || freshPanelRequest);
  const foldReleased =
    suspended && requests.fold > 0 && (!changed || freshFoldRequest);
  const release = useCallback((panel: SuspendablePanel) => {
    setRequests((current) => ({
      ...current,
      version: current.version + 1,
      [panel]: current.version + 1
    }));
  }, []);
  const shown = effectivePanels(state, {
    suspended,
    panelsReleased,
    foldReleased
  });
  return {
    /** Suspended and not released: every model panel shows closed. */
    panelsHidden: shown.panelsSuspended,
    commandFoldOpen: shown.commandFoldOpen,
    foldHidden: suspended && !foldReleased,
    release
  };
}
