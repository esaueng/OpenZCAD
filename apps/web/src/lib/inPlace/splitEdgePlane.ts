import { edgePairPlane } from '@openzcad/geometry';
import type { BodyId, BodyTopology, Vector3 } from '@openzcad/shared';

/**
 * M11 (owner decision D2): Split's plane picked as two straight edges. The
 * pair gives a plane once, at pick time; Split stores it by its numbers like
 * a picked face, so nothing links the result back to the edges and editing
 * them later does not move the split.
 */

/** One straight edge held for the plane, with its exact ends. */
export interface PlaneEdgePick {
  bodyId: BodyId;
  hash: number;
  ends: [Vector3, Vector3];
}

/** Why the picked edges give Split no plane: each has its own sentence. */
export type SplitEdgePlaneRefusal = 'collinear' | 'skew' | 'curved-edge';

/**
 * A model edge as a plane edge: its exact ends (the kernel's own vertices,
 * else its drawn polyline's first and last points), or `curved-edge` for a
 * circle, arc, spline or any closed edge, which gives no line. Null when the
 * body publishes no such edge.
 */
export function planeEdgeFromTopology(
  topology: BodyTopology | undefined,
  bodyId: BodyId,
  hash: number
): PlaneEdgePick | { refused: 'curved-edge' } | null {
  const edge = topology?.edges.find((candidate) => candidate.hash === hash);
  if (!edge) return null;
  const type = edge.curve?.type ?? edge.reference?.witness.curveType;
  const [startId, endId] = edge.vertexIds ?? [];
  const closed =
    edge.reference?.witness.closed === true ||
    (startId !== undefined && startId === endId);
  if (closed || !type || !/^line$/i.test(type)) {
    return { refused: 'curved-edge' };
  }
  const vertex = (id: number | undefined) =>
    id === undefined
      ? undefined
      : topology?.vertices?.find((candidate) => candidate.id === id)?.point;
  const points = edge.points;
  const count = Math.floor(points.length / 3);
  const drawn = (index: number): Vector3 | undefined =>
    count >= 2
      ? {
          x: points[index * 3]!,
          y: points[index * 3 + 1]!,
          z: points[index * 3 + 2]!
        }
      : undefined;
  const start = vertex(startId) ?? drawn(0);
  const end = vertex(endId) ?? drawn(count - 1);
  if (!start || !end) return null;
  return { bodyId, hash, ends: [{ ...start }, { ...end }] };
}

/** The plane through two held edges, or why there is none. */
export function splitPlaneFromEdges(
  first: PlaneEdgePick,
  second: PlaneEdgePick
): { origin: Vector3; normal: Vector3 } | { refused: SplitEdgePlaneRefusal } {
  const plane = edgePairPlane(first.ends, second.ends);
  return plane.ok
    ? { origin: plane.origin, normal: plane.normal }
    : { refused: plane.code };
}

/** The same edge of the same body. */
export function samePlaneEdge(a: PlaneEdgePick, b: PlaneEdgePick): boolean {
  return a.bodyId === b.bodyId && a.hash === b.hash;
}

/**
 * The edges held for a plane, and why the last pick gave none. While any
 * edge is held, the plane slot holds only the plane this pair resolved to.
 */
export interface PlaneEdgeState {
  picks: PlaneEdgePick[];
  refused: SplitEdgePlaneRefusal | null;
}

/** Whether the held pair gives a plane. */
function pairResolves(picks: readonly PlaneEdgePick[]): boolean {
  return (
    picks.length === 2 &&
    !('refused' in splitPlaneFromEdges(picks[0]!, picks[1]!))
  );
}

/**
 * One edge click on Split's plane slot:
 *
 * - The first edge is held, and the slot waits for a second (the plane
 *   slot empties: the user is picking a new plane).
 * - The second gives the plane, or a refusal (`collinear`, `skew`) with both
 *   edges still held; the next edge then replaces the second.
 * - Once a pair has resolved, the next edge starts a new pair.
 * - A held edge clicked again comes back out.
 * - A curved edge is refused (`curved-edge`) and changes nothing else.
 *
 * `plane` is the slot's new plane, null to empty it, or `keep`.
 */
export function nextPlaneEdges(
  state: PlaneEdgeState | undefined,
  edge: PlaneEdgePick | { refused: 'curved-edge' }
): {
  state: PlaneEdgeState;
  plane: { origin: Vector3; normal: Vector3 } | null | 'keep';
} {
  const picks = state?.picks ?? [];
  if ('refused' in edge) {
    return { state: { picks, refused: edge.refused }, plane: 'keep' };
  }
  if (picks.some((held) => samePlaneEdge(held, edge))) {
    return {
      state: {
        picks: picks.filter((held) => !samePlaneEdge(held, edge)),
        refused: null
      },
      plane: null
    };
  }
  if (picks.length === 0 || pairResolves(picks)) {
    return { state: { picks: [edge], refused: null }, plane: null };
  }
  const pair: PlaneEdgePick[] = [picks[0]!, edge];
  const plane = splitPlaneFromEdges(pair[0]!, edge);
  return 'refused' in plane
    ? { state: { picks: pair, refused: plane.refused }, plane: null }
    : { state: { picks: pair, refused: null }, plane };
}
