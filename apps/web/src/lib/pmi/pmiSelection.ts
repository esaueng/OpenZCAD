import { useSyncExternalStore } from 'react';

/**
 * D07: what the model's PMI shares between the viewport and Objects — the
 * face selected now (and where it was clicked), and the entry open in
 * Objects. Held here rather than in the workspace so that none of it
 * weighs on the entry chunk: only the lazily loaded viewer shell and panel
 * import it, and they share this one module.
 */
export interface PmiFacePick {
  bodyId: string;
  hash: number;
  /** Where the face was clicked, when it was; a new entry's leader lands there. */
  point?: { x: number; y: number; z: number };
}

export interface PmiSelectionState {
  face: PmiFacePick | null;
  selectedPmiId: string | null;
}

let state: PmiSelectionState = { face: null, selectedPmiId: null };
const listeners = new Set<() => void>();

function publish(next: PmiSelectionState) {
  if (
    next.selectedPmiId === state.selectedPmiId &&
    next.face?.bodyId === state.face?.bodyId &&
    next.face?.hash === state.face?.hash &&
    next.face?.point === state.face?.point
  )
    return;
  state = next;
  for (const listener of listeners) listener();
}

export function pmiSelection(): PmiSelectionState {
  return state;
}

/** The selected face: a click on it (with its point), or the selection now. */
export function setPmiFace(face: PmiFacePick | null): void {
  // A selection echoing the face last clicked keeps the click's point.
  const same =
    face &&
    state.face &&
    face.bodyId === state.face.bodyId &&
    face.hash === state.face.hash;
  publish({
    ...state,
    face: same && !face.point ? state.face : face
  });
}

export function setSelectedPmiId(pmiId: string | null): void {
  publish({ ...state, selectedPmiId: pmiId });
}

export function subscribePmiSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePmiSelection(): PmiSelectionState {
  return useSyncExternalStore(
    subscribePmiSelection,
    pmiSelection,
    pmiSelection
  );
}
