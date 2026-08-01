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
 * The walk is geometric, not topological: "the same run" is decided by edges
 * meeting at a point and continuing in roughly the same direction. Two
 * consequences worth knowing: the run stops at a sharp corner, which is the
 * point; and the four square edges around a plain box's top face are a face
 * loop rather than a run, so they stay separate.
 *
 * It is geometric for historical reasons, not for want of the facts. The
 * topology payload publishes `adjacentFaceHashes` — the faces an edge bounds —
 * and `vertexIds` — the vertices it runs between — which is what a topological
 * walk needs; M3/W4 is that rewrite. What the geometric walk gets wrong today
 * is measured against the real kernel in
 * `test/edge-chain-characterization.test.ts`: an octagonal boss rim comes back
 * whole while a hexagonal one comes back as a single edge, a run steps between
 * two solids that merely touch, and the same body a hundred thousand times
 * smaller answers differently because the weld tolerance below is absolute.
 */

/** World distance within which two edge ends count as the same vertex. */
const WELD_TOLERANCE = 1e-4;

/**
 * Degrees two directions may differ and still count as continuing.
 *
 * This used to be justified by chord error: the claim was that the kernel
 * hands the viewport a fillet arc as a two-point polyline, so an arc's end
 * direction is its chord, a full 45 degrees off the true tangent. That is
 * false and was measured to be false. At the app's display deflection a
 * quarter arc arrives with 28 points, and it stays 28 across three decades of
 * radius because the deflection is size-relative. End directions here are
 * within a couple of degrees of the real tangent.
 *
 * 50 is still load-bearing, for a different reason. A chamfer is not tangent
 * to anything: a 20x20x10 box chamfered 3 mm on its four vertical edges has a
 * top rim whose worst kink is exactly 45.000000 degrees, a real corner. At a
 * 45 degree tolerance that rim collapses from eight edges to one, while the UI
 * promises "Fillet or chamfer applies to all of them". So tightening this
 * toward true tangency would silently remove chamfer-band selection.
 *
 * Whether a chamfer band should count as one run is a product question, not a
 * refactor. Do not tighten this as a cleanup. Both numbers are pinned in
 * `test/edge-chain-characterization.test.ts`.
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
