import { useCallback, useState } from 'react';
import {
  effectivePanels,
  type PanelState,
  type SuspendablePanel
} from '../lib/panelState';

type Released = Readonly<Record<SuspendablePanel, boolean>>;

const NOTHING_RELEASED: Released = { panels: false, fold: false };

/**
 * Suspends every open model panel and the "More tools" fold while a sketch
 * or feature form is open, and brings them back when it ends. Derived rather
 * than written at every way in and out of it, so no entry or exit path can
 * forget to restore them, and the stored layout is never touched. A
 * direct-manipulation drag leaves them where they are. See `effectivePanels`.
 */
export function usePanelSuspension(
  state: Pick<PanelState, 'commandFoldOpen'>,
  mode: { sketching: boolean; editing?: boolean }
) {
  const suspended = mode.sketching || Boolean(mode.editing);
  const [released, setReleased] = useState<Released>(NOTHING_RELEASED);
  // A release lasts for the mode it was made in; the next one suspends again.
  if (!suspended && released !== NOTHING_RELEASED) {
    setReleased(NOTHING_RELEASED);
  }
  const panelsReleased = suspended && released.panels;
  const foldReleased = suspended && released.fold;
  const release = useCallback((panel: SuspendablePanel) => {
    setReleased((current) =>
      current[panel] ? current : { ...current, [panel]: true }
    );
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
