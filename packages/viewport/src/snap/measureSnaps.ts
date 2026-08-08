import type { EdgeTopology } from '@openzcad/shared';

/**
 * Which edges are worth offering snap points for, given what the pointer is
 * already over.
 *
 * `resolveSnap` PROJECTS every candidate it is handed, through the live camera,
 * on every frame it runs. `snapsFromEdges` emits up to three candidates per
 * edge, so handing it a whole body means a projection count that scales with
 * the model: an imported assembly of forty thousand edges would ask for on the
 * order of a hundred thousand projections per hover frame. Move drags get away
 * with collecting body-wide because they do it once, at drag start; a hover
 * probe cannot.
 *
 * The pointer is already over something, and that is the whole answer. Snap
 * points a person is reaching for are on the thing under the cursor or on what
 * touches it — nothing thirty centimetres away across the part is a candidate
 * for a twelve-pixel radius. So the set is:
 *
 *   over an edge   that edge, plus every edge sharing one of its vertices
 *   over a face    the edges that bound it
 *   over nothing   nothing
 *
 * The filter is a single pass comparing integers, which is not free but is a
 * different order of cost from projecting each one through a matrix. Keeping
 * it a pass rather than an index is deliberate: an index would have to be
 * invalidated against a body that rebuilds on every parametric edit, and a
 * stale snap index is a wrong answer where a redundant scan is only a slow one.
 */

export interface MeasureSnapScope {
  /** The edge under the pointer, when it is over one. */
  edge?: EdgeTopology | null;
  /** The hash of the face under the pointer, when it is over one. */
  faceHash?: number | null;
}

/**
 * Edges whose snap points are worth projecting this frame.
 *
 * Returns an empty array rather than everything when the scope is empty. A
 * hover over background offering the whole model's snap points is exactly the
 * cost this exists to avoid, and there is nothing there to snap to anyway.
 */
export function measureSnapEdges(
  edges: readonly EdgeTopology[],
  scope: MeasureSnapScope
): EdgeTopology[] {
  if (scope.edge) {
    const vertices = scope.edge.vertexIds;
    if (!vertices) {
      // Without incidence there is no neighbourhood to widen to, and guessing
      // one from positions is the thing `vertexIds` exists to replace.
      return [scope.edge];
    }
    const [first, second] = vertices;
    return edges.filter((candidate) => {
      if (candidate === scope.edge) {
        return true;
      }
      const ends = candidate.vertexIds;
      return (
        ends !== undefined &&
        (ends[0] === first ||
          ends[1] === first ||
          ends[0] === second ||
          ends[1] === second)
      );
    });
  }
  if (scope.faceHash !== null && scope.faceHash !== undefined) {
    const hash = scope.faceHash;
    return edges.filter((candidate) =>
      candidate.adjacentFaceHashes?.includes(hash)
    );
  }
  return [];
}
