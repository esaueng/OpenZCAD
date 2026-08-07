import type { TopologySelection } from '@openzcad/shared';

/**
 * The picks a measurement is being built from, owned by the measure tool.
 *
 * Measuring used to borrow the workspace's selection for this. That looked
 * harmless — a Shift+Click needs somewhere to accumulate edges, and
 * `selectedEdges` was already there — but it made a read-only inspection
 * quietly rewrite the state a modelling session was holding: measure one edge
 * in View, switch back to Build, and whatever had been selected was gone.
 *
 * The two are separate concerns and now separate state. Everything here is
 * pure so the accumulation rules can be tested without a viewport, a document,
 * or a rebuild.
 */

/** A running edge total, accumulated by Shift+Click in smart mode. */
export interface MeasureSessionState {
  edgeRun: readonly TopologySelection[];
}

export const EMPTY_MEASURE_SESSION: MeasureSessionState = { edgeRun: [] };

function sameEdge(
  first: TopologySelection,
  second: TopologySelection
): boolean {
  // `topologyId` alone would collide across bodies, which is exactly the case
  // the body check below is here to reset rather than to merge.
  return (
    first.bodyId === second.bodyId && first.topologyId === second.topologyId
  );
}

/**
 * The next running edge set after a pick.
 *
 * Three rules, and the last one is the one worth stating: a pick on a
 * DIFFERENT body starts over rather than extending. An edge total spanning two
 * bodies is a number with no referent — there is no single part it describes —
 * and silently producing one is worse than restarting the run where the user
 * is now looking.
 */
export function nextEdgeRun(
  current: readonly TopologySelection[],
  selection: TopologySelection,
  additive: boolean
): readonly TopologySelection[] {
  if (selection.kind !== 'edge') {
    return current;
  }
  if (!additive) {
    return [selection];
  }
  const sameBody = current.every((edge) => edge.bodyId === selection.bodyId);
  if (!sameBody) {
    return [selection];
  }
  // Re-picking an edge already in the run removes it, so a Shift+Click is a
  // toggle rather than a one-way accumulation someone has to clear to undo.
  return current.some((edge) => sameEdge(edge, selection))
    ? current.filter((edge) => !sameEdge(edge, selection))
    : [...current, selection];
}

/** Whether a run is long enough to total. One edge is just an edge. */
export function edgeRunIsTotalable(run: readonly TopologySelection[]): boolean {
  return run.length >= 2;
}
