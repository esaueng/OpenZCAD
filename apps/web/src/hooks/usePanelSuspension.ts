import { useCallback, useState } from 'react';
import {
  effectivePanels,
  nextDragSuspension,
  type PanelState,
  type SuspendablePanel
} from '../lib/panelState';

type Released = Readonly<Record<SuspendablePanel, boolean>>;

const NOTHING_RELEASED: Released = { drawer: false, fold: false };

/**
 * Suspends the model drawer and the "More tools" fold while a sketch is open
 * or a direct-manipulation drag holds the stage, and brings them back when
 * the mode ends. Derived from the mode rather than written at every way in
 * and out of it, so no entry or exit path can forget to restore them, and
 * the stored preference is never touched. See `effectivePanels`.
 */
export function usePanelSuspension(
  state: Pick<PanelState, 'drawerOpen' | 'commandFoldOpen'>,
  mode: {
    sketching: boolean;
    phase: string | null;
    /** A direct-manipulation gesture's pointer is still down. */
    pointerDown?: boolean;
  }
) {
  const [dragHeld, setDragHeld] = useState(false);
  const nextDragHeld = nextDragSuspension(
    dragHeld,
    mode.phase,
    mode.pointerDown ?? false
  );
  if (nextDragHeld !== dragHeld) {
    setDragHeld(nextDragHeld);
  }
  const suspended = mode.sketching || nextDragHeld;
  const [released, setReleased] = useState<Released>(NOTHING_RELEASED);
  // A release lasts for the mode it was made in; the next one suspends again.
  if (!suspended && released !== NOTHING_RELEASED) {
    setReleased(NOTHING_RELEASED);
  }
  const drawerReleased = suspended && released.drawer;
  const foldReleased = suspended && released.fold;
  const release = useCallback((panel: SuspendablePanel) => {
    setReleased((current) =>
      current[panel] ? current : { ...current, [panel]: true }
    );
  }, []);
  return {
    ...effectivePanels(state, { suspended, drawerReleased, foldReleased }),
    /** Suspended and not released: the panel shows closed, whatever it is. */
    drawerHidden: suspended && !drawerReleased,
    foldHidden: suspended && !foldReleased,
    release
  };
}
