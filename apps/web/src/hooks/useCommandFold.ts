import { useCallback, useState } from 'react';
import {
  effectiveCommandFold,
  type PanelState,
  type WorkspaceMode
} from '../lib/panelState';

/**
 * Folds More tools during a sketch or creation command. Opening the fold
 * keeps it open for that session; the next command starts folded again.
 * Model panels are independent of this temporary tool-drawer state.
 */
export function useCommandFold(
  state: Pick<PanelState, 'commandFoldOpen'>,
  mode: {
    sketching: boolean;
    editing?: boolean;
    sessionId?: string | null;
    workspaceMode?: WorkspaceMode;
  }
) {
  const session =
    (mode.workspaceMode ?? 'build') !== 'build'
      ? null
      : mode.sketching
        ? `sketch:${mode.sessionId ?? ''}`
        : mode.editing
          ? `feature:${mode.sessionId ?? ''}`
          : null;
  const suspended = session !== null;
  const [lastSession, setLastSession] = useState(session);
  const [request, setRequest] = useState(0);
  const [observedRequest, setObservedRequest] = useState(0);
  const changed = lastSession !== session;
  const freshRequest = request > observedRequest;
  if (changed) {
    setLastSession(session);
    // Keep an explicit request batched with opening a new command, but do
    // not carry the previous command's open fold into the next session.
    if (!freshRequest) setRequest(0);
  }
  if (observedRequest !== request) setObservedRequest(request);
  const released = suspended && request > 0 && (!changed || freshRequest);
  const release = useCallback(() => setRequest((current) => current + 1), []);
  return {
    commandFoldOpen: effectiveCommandFold(state, { suspended, released }),
    foldHidden: suspended && !released,
    release
  };
}
