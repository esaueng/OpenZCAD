import type { EdgeTopology } from '@openzcad/shared';

/**
 * Selecting a whole run of edges from one of them.
 *
 * Filleting or chamfering a rim means selecting every edge around it, and a
 * rounded rim is rarely one edge — a filleted box corner turns each rim into
 * an alternating run of lines and arcs. Picking eight edges by hand to round
 * one lip is the most tedious thing in the fillet workflow, so a double click
 * walks the run instead.
 *
 * The walk is geometric, not topological: the kernel gives the viewport an
 * edge's display polyline but not which faces bound it, so "the same run" is
 * decided by edges meeting at a point and continuing in roughly the same
 * direction rather than by shared tangency. Two consequences worth knowing:
 * the run stops at a sharp corner, which is the point; and the four square
 * edges around a plain box's top face are a face loop rather than a run, so
 * they stay separate. A face loop needs edge-to-face adjacency the kernel
 * does not publish.
 */

/** World distance within which two edge ends count as the same vertex. */
const WELD_TOLERANCE = 1e-4;

/**
 * Degrees two directions may differ and still count as continuing.
 *
 * Deliberately far looser than "tangent" reads, because the direction this
 * can measure is not the true tangent. The kernel hands the viewport a
 * fillet or chamfer arc as a two-point polyline — its endpoints and nothing
 * between — so the only direction available at an arc's end is its chord,
 * which for a quarter arc is a full 45 degrees off the tangent. Measured on
 * a filleted box, a rim edge meets its corner arc at 45 degrees and meets
 * the perpendicular rim edge and the wall below at 90.
 *
 * 50 degrees therefore separates "continues around the rim" from "turns a
 * corner" on the data that exists. Tighten it toward 12 if the kernel starts
 * sampling curved edges the way it already samples a cylinder's rim, which
 * would also stop those arcs drawing as visibly straight chords.
 */
const TANGENT_TOLERANCE_DEG = 50;

type Vec3 = readonly [number, number, number];

export interface EdgeChainOptions {
  weldTolerance?: number;
  tangentToleranceDeg?: number;
}

function pointAt(points: number[], index: number): Vec3 {
  return [
    points[index * 3] ?? 0,
    points[index * 3 + 1] ?? 0,
    points[index * 3 + 2] ?? 0
  ];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalize(from: Vec3, to: Vec3): Vec3 | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  return length > 0 ? [dx / length, dy / length, dz / length] : null;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

/**
 * One edge reduced to what the walk needs: where it starts and ends, and
 * which way it is heading at each end.
 *
 * Tangents come from the first and last segment that has any length. A
 * polyline can repeat a point — a closed edge repeats its first point to draw
 * the seam — and a zero-length segment has no direction to offer.
 */
interface EdgeEnds {
  topologyId: string;
  start: Vec3;
  end: Vec3;
  /** Direction of travel leaving `start`. */
  startTangent: Vec3;
  /** Direction of travel arriving at `end`. */
  endTangent: Vec3;
}

function edgeEnds(edge: EdgeTopology): EdgeEnds | null {
  const count = Math.floor(edge.points.length / 3);
  if (count < 2) {
    return null;
  }
  const start = pointAt(edge.points, 0);
  const end = pointAt(edge.points, count - 1);
  let startTangent: Vec3 | null = null;
  for (let index = 1; index < count && !startTangent; index += 1) {
    startTangent = normalize(start, pointAt(edge.points, index));
  }
  let endTangent: Vec3 | null = null;
  for (let index = count - 2; index >= 0 && !endTangent; index -= 1) {
    endTangent = normalize(pointAt(edge.points, index), end);
  }
  return startTangent && endTangent
    ? { topologyId: edge.topologyId, start, end, startTangent, endTangent }
    : null;
}

/** How the walk is traversing an edge, and where that leaves it. */
interface Step {
  edge: EdgeEnds;
  /** The vertex the walk arrives at after this edge. */
  vertex: Vec3;
  /** Direction of travel on arrival, for the tangent test at that vertex. */
  heading: Vec3;
}

function stepForward(edge: EdgeEnds): Step {
  return { edge, vertex: edge.end, heading: edge.endTangent };
}

function stepBackward(edge: EdgeEnds): Step {
  return { edge, vertex: edge.start, heading: negate(edge.startTangent) };
}

/**
 * The edge that continues smoothly from `step`, or null at a sharp corner or
 * a dead end.
 *
 * Where several edges meet the vertex — the usual case, since a rim edge and
 * the wall edge below it share a corner — the straightest continuation wins.
 * That is a real fork rather than an error: the user asked for the smooth
 * run, and only one branch of it is smooth.
 */
function continuation(
  step: Step,
  candidates: EdgeEnds[],
  visited: Set<string>,
  weld: number,
  minDot: number
): Step | null {
  let best: Step | null = null;
  let bestDot = minDot;
  for (const candidate of candidates) {
    if (visited.has(candidate.topologyId)) {
      continue;
    }
    // Meeting at the vertex by either end; traversing an edge backward is
    // ordinary, since edge direction is the kernel's choice, not the rim's.
    // `leaving` is the direction of travel out of the vertex either way.
    const joins: { step: Step; leaving: Vec3 }[] = [];
    if (distance(candidate.start, step.vertex) <= weld) {
      joins.push({ step: stepForward(candidate), leaving: candidate.startTangent });
    }
    if (distance(candidate.end, step.vertex) <= weld) {
      joins.push({
        step: stepBackward(candidate),
        leaving: negate(candidate.endTangent)
      });
    }
    for (const join of joins) {
      const alignment = dot(step.heading, join.leaving);
      if (alignment > bestDot) {
        bestDot = alignment;
        best = join.step;
      }
    }
  }
  return best;
}

/**
 * Every edge on the same smooth run as `seedTopologyId`, in order along the
 * run, with the seed included.
 *
 * Returns just the seed when nothing continues from it — a lone edge is a run
 * of one, so callers need no separate empty case.
 */
export function edgeRunFrom(
  edges: EdgeTopology[],
  seedTopologyId: string,
  options: EdgeChainOptions = {}
): string[] {
  const weld = options.weldTolerance ?? WELD_TOLERANCE;
  const minDot = Math.cos(
    ((options.tangentToleranceDeg ?? TANGENT_TOLERANCE_DEG) * Math.PI) / 180
  );
  const visibleEdges = edges.filter((edge) => edge.displayRole !== 'seam');
  const ends = visibleEdges
    .map(edgeEnds)
    .filter((entry): entry is EdgeEnds => entry !== null);
  const seed = ends.find((entry) => entry.topologyId === seedTopologyId);
  if (!seed) {
    return visibleEdges.some((edge) => edge.topologyId === seedTopologyId)
      ? [seedTopologyId]
      : [];
  }

  const visited = new Set([seed.topologyId]);
  const forward: string[] = [];
  let step: Step | null = stepForward(seed);
  while (step) {
    step = continuation(step, ends, visited, weld, minDot);
    if (step) {
      visited.add(step.edge.topologyId);
      forward.push(step.edge.topologyId);
    }
  }
  const backward: string[] = [];
  step = stepBackward(seed);
  while (step) {
    step = continuation(step, ends, visited, weld, minDot);
    if (step) {
      visited.add(step.edge.topologyId);
      backward.push(step.edge.topologyId);
    }
  }
  // Ordered along the run so a caller can draw or measure it in sequence.
  return [...backward.reverse(), seed.topologyId, ...forward];
}
