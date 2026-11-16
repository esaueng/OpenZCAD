import { useSyncExternalStore } from 'react';
import type {
  SurfaceAnalysisKind,
  SurfaceAnalysisRequest,
  Vector3
} from '@openzcad/shared';

/**
 * M09: which analysis overlay is on, and its settings. View state only: it
 * is never saved with the document and never changes it. The Display menu
 * switches an analysis on and off; the analysis panel edits its settings;
 * the viewer shell runs the query and draws the result. A store, not props,
 * because the menu stands in two different bars (Build's rail and View's).
 */
export interface AnalysisRuntimeState {
  request: SurfaceAnalysisRequest | null;
}

/** Pull directions offered for draft: the six axes. */
export const DRAFT_PULL_DIRECTIONS = {
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
  '+y': { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 }
} as const satisfies Record<string, Vector3>;

export type DraftPullId = keyof typeof DRAFT_PULL_DIRECTIONS;

export const DEFAULT_DRAFT_MINIMUM_DEGREES = 1;

export function defaultAnalysisRequest(
  kind: SurfaceAnalysisKind
): SurfaceAnalysisRequest {
  switch (kind) {
    case 'draft':
      return {
        kind: 'draft',
        pull: DRAFT_PULL_DIRECTIONS['+z'],
        minimumDegrees: DEFAULT_DRAFT_MINIMUM_DEGREES
      };
  }
}

const INITIAL: AnalysisRuntimeState = { request: null };
let state: AnalysisRuntimeState = INITIAL;
const listeners = new Set<() => void>();

function emit(next: AnalysisRuntimeState) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeAnalysisRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnalysisRuntime<T>(
  select: (s: AnalysisRuntimeState) => T
): T {
  return useSyncExternalStore(
    subscribeAnalysisRuntime,
    () => select(state),
    () => select(INITIAL)
  );
}

export const analysisRuntime = {
  get(): AnalysisRuntimeState {
    return state;
  },
  /** Switches `kind` on with its defaults, or off when it is already on. */
  toggle(kind: SurfaceAnalysisKind): void {
    emit({
      request:
        state.request?.kind === kind ? null : defaultAnalysisRequest(kind)
    });
  },
  /** Replaces the settings of the analysis that is on. */
  update(request: SurfaceAnalysisRequest): void {
    if (state.request?.kind !== request.kind) return;
    emit({ request });
  },
  off(): void {
    if (state.request) emit({ request: null });
  },
  /** Tests: back to nothing on. */
  reset(): void {
    emit(INITIAL);
  }
};
