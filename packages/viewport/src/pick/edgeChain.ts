import type { EdgeCurve, EdgeTopology } from '@openzcad/shared';

/**
 * Selecting a whole run of edges from one of them.
 *
 * Filleting or chamfering a rim means selecting every edge around it, and a
 * rounded rim is rarely one edge — a filleted box corner turns each rim into
 * an alternating run of lines and arcs. Picking eight edges by hand to round
 * one lip is the most tedious thing in the fillet workflow, so a double click
 * walks the run instead.
 *
 * Two separate questions decide a run, and they are answered from different
 * places:
 *
 * - **Do these two edges meet?** Topology answers it. `EdgeTopology.vertexIds`
 *   names the kernel's own vertices, so two edges meet when they name the same
 *   vertex — not when two sampled polyline ends land near each other. That is
 *   what makes the walk scale-free and what keeps it inside one solid.
 * - **Does the run continue there?** Geometry answers it, inside a 50 degree
 *   cone, for the product reason recorded on `TANGENT_TOLERANCE_DEG` below.
 *
 * Edges that predate `vertexIds` — a `derived` payload restored from IndexedDB,
 * or an edge the kernel refused — fall back to welding polyline ends, the way
 * the whole walk used to. The fallback is scale-relative rather than absolute,
 * so it is not silently wrong on a part a hundred thousand times smaller than
 * the one it was tuned on; see `RELATIVE_WELD_TOLERANCE`.
 *
 * **`adjacentFaceHashes` is deliberately not consulted**, and that is a
 * measured decision rather than an oversight. Requiring two edges to share a
 * face before they can continue each other sounds obviously right and is
 * obviously wrong: on the app's own default body — a 30x18x24 box with all
 * twelve edges filleted — every one of the 336 consecutive pairs across its
 * forty-eight runs shares no face at all. Those runs are the tangent-continuous
 * loops that thread *across* the fillet patches, meeting four-valent vertices
 * where the continuing edge is the diagonally opposite one. A face-continuity
 * requirement would reject every join those runs are made of, and
 * `test/e2e/viewport.spec.ts` is asserting the eight they add up to. The
 * measurement is pinned in `test/edge-chain-characterization.test.ts` so the
 * rule cannot be added back as a cleanup.
 */

/**
 * How far apart two polyline ends may be, as a fraction of the body's extent,
 * and still be welded into one vertex — for edges that publish no `vertexIds`.
 *
 * Relative, because the tolerance it replaces was absolute. At 1e-4 world
 * units, a 2e-4 metre part — `UnitSystem` includes metres, so it is
 * representable — had every corner of the body inside one weld radius, and a
 * filleted rim of eight came back as sixteen edges wandering off the rim.
 *
 * 1e-6 of the extent is two orders looser than the ADR-011 quantum and eight
 * orders tighter than any feature: the kernel evaluates both edges at the same
 * vertex, so genuine ends agree to roughly 1e-15 relative, and nothing that
 * should stay apart is anywhere near this close.
 */
const RELATIVE_WELD_TOLERANCE = 1e-6;

/**
 * Degrees two directions may differ and still count as continuing.
 *
 * This used to be justified by chord error: the claim was that the kernel
 * hands the viewport a fillet arc as a two-point polyline, so an arc's end
 * direction is its chord, a full 45 degrees off the true tangent. That is
 * false and was measured to be false. At the app's display deflection a
 * quarter arc arrives with 28 points, and it stays 28 across three decades of
 * radius because the deflection is size-relative. End directions here are
 * within a couple of degrees of the real tangent — and for circular edges the
 * walk now takes the tangent from `EdgeCurve.circle` instead, so there is no
 * chord error left at all.
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
 * `test/edge-chain-characterization.test.ts`, along with the two cases that
 * cannot be changed without changing this one: a regular polygon boss rim and
 * the top rim of a sheared box present the walk with a join that is congruent
 * to the chamfer's, down to the same 45.000000 degrees.
 */
const TANGENT_TOLERANCE_DEG = 50;

/**
 * How closely an exact circular tangent must agree with the sampled chord
 * before it is trusted.
 *
 * `EdgeCurve.circle.axis` is unoriented by contract, so crossing it with the
 * radius gives the tangent *line*, not a direction; the polyline picks which
 * of the two ways the edge actually runs. 20 degrees is far wider than the
 * couple of degrees of chord error a display polyline carries and far tighter
 * than a wrong answer, so disagreement means the record does not describe this
 * end and the chord is used instead.
 */
const EXACT_TANGENT_AGREEMENT = Math.cos((20 * Math.PI) / 180);

type Vec3 = readonly [number, number, number];

export interface EdgeChainOptions {
  /**
   * Absolute world distance for welding polyline ends. Only reaches edges that
   * publish no `vertexIds`; edges that do are matched by vertex identity and
   * ignore this entirely. Defaults to `RELATIVE_WELD_TOLERANCE` of the extent
   * of the edges supplied, and is not computed at all when every edge names
   * its vertices.
   */
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

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/**
 * The exact tangent to a circular edge where it passes through `point`,
 * oriented to agree with `chord`.
 *
 * Null whenever the record does not clearly describe this end: no analytic
 * circle, a point on the axis, or a tangent that disagrees with the sampled
 * direction by more than `EXACT_TANGENT_AGREEMENT`. The caller then uses the
 * chord, which is what the walk did everywhere before.
 */
function exactCircularTangent(
  curve: EdgeCurve | undefined,
  point: Vec3,
  chord: Vec3
): Vec3 | null {
  const circle = curve?.type === 'CIRCLE' ? curve.circle : undefined;
  if (!circle) {
    return null;
  }
  const radial: Vec3 = [
    point[0] - circle.center.x,
    point[1] - circle.center.y,
    point[2] - circle.center.z
  ];
  const axis: Vec3 = [circle.axis.x, circle.axis.y, circle.axis.z];
  const raw = cross(axis, radial);
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  if (length <= 0) {
    return null;
  }
  const tangent: Vec3 = [raw[0] / length, raw[1] / length, raw[2] / length];
  // The axis is unoriented, so this is the tangent line; the polyline says
  // which way along it the edge is drawn.
  const oriented = dot(tangent, chord) >= 0 ? tangent : negate(tangent);
  return dot(oriented, chord) >= EXACT_TANGENT_AGREEMENT ? oriented : null;
}

/**
 * One edge reduced to what the walk needs: which vertex it meets at each end,
 * where that end is in space for the fallback, and which way it is heading
 * there.
 *
 * Tangents come from the exact circle where one is published, and otherwise
 * from the first and last segment that has any length. A polyline can repeat a
 * point — a closed edge repeats its first point to draw the seam — and a
 * zero-length segment has no direction to offer.
 */
interface EdgeEnds {
  topologyId: string;
  start: Vec3;
  end: Vec3;
  /** Direction of travel leaving `start`. */
  startTangent: Vec3;
  /** Direction of travel arriving at `end`. */
  endTangent: Vec3;
  /** The kernel's vertex at each end, when the payload publishes them. */
  startVertex?: number;
  endVertex?: number;
  /**
   * Runs from one vertex back to itself: a cylinder rim, a bore rim, a torus's
   * degenerate poles. Such an edge is always a run of one — see `indexEdges`.
   */
  closed: boolean;
}

function edgeEnds(edge: EdgeTopology, weld: number): EdgeEnds | null {
  const count = Math.floor(edge.points.length / 3);
  if (count < 2) {
    return null;
  }
  const start = pointAt(edge.points, 0);
  const end = pointAt(edge.points, count - 1);
  let startChord: Vec3 | null = null;
  for (let index = 1; index < count && !startChord; index += 1) {
    startChord = normalize(start, pointAt(edge.points, index));
  }
  let endChord: Vec3 | null = null;
  for (let index = count - 2; index >= 0 && !endChord; index -= 1) {
    endChord = normalize(pointAt(edge.points, index), end);
  }
  if (!startChord || !endChord) {
    return null;
  }
  const [startVertex, endVertex] = edge.vertexIds ?? [undefined, undefined];
  return {
    topologyId: edge.topologyId,
    start,
    end,
    startTangent:
      exactCircularTangent(edge.curve, start, startChord) ?? startChord,
    endTangent: exactCircularTangent(edge.curve, end, endChord) ?? endChord,
    startVertex,
    endVertex,
    closed:
      startVertex !== undefined && endVertex !== undefined
        ? startVertex === endVertex
        : distance(start, end) <= weld
  };
}

/** An end of the run so far: the vertex it stands at, however that is known. */
interface Joint {
  vertex?: number;
  position: Vec3;
}

/** How the walk is traversing an edge, and where that leaves it. */
interface Step {
  edge: EdgeEnds;
  /** The vertex the walk arrives at after this edge. */
  joint: Joint;
  /** Direction of travel on arrival, for the tangent test at that vertex. */
  heading: Vec3;
}

function stepForward(edge: EdgeEnds): Step {
  return {
    edge,
    joint: { vertex: edge.endVertex, position: edge.end },
    heading: edge.endTangent
  };
}

function stepBackward(edge: EdgeEnds): Step {
  return {
    edge,
    joint: { vertex: edge.startVertex, position: edge.start },
    heading: negate(edge.startTangent)
  };
}

/**
 * Whether the walk standing at `joint` is standing at `end` of some candidate.
 *
 * Vertex identity wins wherever both sides publish it, and it is the whole
 * point: two solids that touch face to face — a linear pattern whose spacing
 * equals its extent — never share a vertex id even where their edges are
 * exactly coincident, so a run cannot walk from one body into the other.
 * Positions only decide it when one side has nothing to compare.
 */
function endsMeet(joint: Joint, end: Joint, weld: number): boolean {
  if (joint.vertex !== undefined && end.vertex !== undefined) {
    return joint.vertex === end.vertex;
  }
  return distance(joint.position, end.position) <= weld;
}

/**
 * Everything the walk indexed, arranged so a vertex lookup does not scan the
 * body.
 *
 * Closed edges are absent from all three: an edge that leaves a vertex and
 * returns to it is already the whole loop, and the payload cannot say which
 * way it leaves — a closed edge's polyline starts wherever the sampler chose,
 * a quarter turn from its own vertex on a cylinder rim, so its end chords are
 * not directions at the vertex at all. It is a run of one, entered only as a
 * seed.
 */
interface Incidence {
  byVertex: Map<number, EdgeEnds[]>;
  /** Edges with no `vertexIds`, reachable only by welding positions. */
  unkeyed: EdgeEnds[];
  open: EdgeEnds[];
}

function indexEdges(ends: EdgeEnds[]): Incidence {
  const byVertex = new Map<number, EdgeEnds[]>();
  const unkeyed: EdgeEnds[] = [];
  const open: EdgeEnds[] = [];
  for (const entry of ends) {
    if (entry.closed) {
      continue;
    }
    open.push(entry);
    if (entry.startVertex === undefined || entry.endVertex === undefined) {
      unkeyed.push(entry);
      continue;
    }
    for (const vertex of new Set([entry.startVertex, entry.endVertex])) {
      const bucket = byVertex.get(vertex);
      if (bucket) {
        bucket.push(entry);
      } else {
        byVertex.set(vertex, [entry]);
      }
    }
  }
  return { byVertex, unkeyed, open };
}

/**
 * The edges that could continue a run at `joint`.
 *
 * A joint that knows its vertex takes the edges naming that vertex, plus every
 * edge that publishes no vertex at all — those can still only be reached by
 * position, and a payload that mixes the two is exactly the half-migrated
 * `derived` record the fallback exists for.
 */
function candidateEdges(joint: Joint, index: Incidence): EdgeEnds[] {
  if (joint.vertex === undefined) {
    return index.open;
  }
  const keyed = index.byVertex.get(joint.vertex) ?? [];
  return index.unkeyed.length === 0 ? keyed : [...keyed, ...index.unkeyed];
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
  index: Incidence,
  visited: Set<string>,
  weld: number,
  minDot: number
): Step | null {
  let best: Step | null = null;
  let bestDot = minDot;
  for (const candidate of candidateEdges(step.joint, index)) {
    if (visited.has(candidate.topologyId)) {
      continue;
    }
    // Meeting at the vertex by either end; traversing an edge backward is
    // ordinary, since edge direction is the kernel's choice, not the rim's.
    // `leaving` is the direction of travel out of the vertex either way.
    const joins: { step: Step; leaving: Vec3 }[] = [];
    if (
      endsMeet(
        step.joint,
        { vertex: candidate.startVertex, position: candidate.start },
        weld
      )
    ) {
      joins.push({ step: stepForward(candidate), leaving: candidate.startTangent });
    }
    if (
      endsMeet(
        step.joint,
        { vertex: candidate.endVertex, position: candidate.end },
        weld
      )
    ) {
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
 * The distance scale of the edges supplied, for the fallback weld tolerance.
 *
 * The extent of every sampled point rather than of the edge ends alone, so an
 * arc contributes its whole sweep. Zero for a single point, which leaves the
 * weld tolerance at zero and welds only exactly coincident ends — the honest
 * answer when there is no scale to be relative to.
 */
function pointExtent(edges: EdgeTopology[]): number {
  const min: number[] = [Infinity, Infinity, Infinity];
  const max: number[] = [-Infinity, -Infinity, -Infinity];
  for (const edge of edges) {
    for (let index = 0; index < edge.points.length; index += 1) {
      const axis = index % 3;
      const value = edge.points[index]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  const spans = [0, 1, 2].map((axis) =>
    Number.isFinite(min[axis]!) && Number.isFinite(max[axis]!)
      ? max[axis]! - min[axis]!
      : 0
  );
  return Math.max(...spans);
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
  const minDot = Math.cos(
    ((options.tangentToleranceDeg ?? TANGENT_TOLERANCE_DEG) * Math.PI) / 180
  );
  const visibleEdges = edges.filter((edge) => edge.displayRole !== 'seam');
  // Zero unless something here has to be reached by position: a body whose
  // edges all name their vertices is walked without a length anywhere in it.
  const weld =
    options.weldTolerance ??
    (visibleEdges.some((edge) => edge.vertexIds === undefined)
      ? pointExtent(visibleEdges) * RELATIVE_WELD_TOLERANCE
      : 0);
  const ends = visibleEdges
    .map((edge) => edgeEnds(edge, weld))
    .filter((entry): entry is EdgeEnds => entry !== null);
  const seed = ends.find((entry) => entry.topologyId === seedTopologyId);
  if (!seed) {
    return visibleEdges.some((edge) => edge.topologyId === seedTopologyId)
      ? [seedTopologyId]
      : [];
  }
  if (seed.closed) {
    return [seed.topologyId];
  }

  const index = indexEdges(ends);
  const visited = new Set([seed.topologyId]);
  const forward: string[] = [];
  let step: Step | null = stepForward(seed);
  while (step) {
    step = continuation(step, index, visited, weld, minDot);
    if (step) {
      visited.add(step.edge.topologyId);
      forward.push(step.edge.topologyId);
    }
  }
  const backward: string[] = [];
  step = stepBackward(seed);
  while (step) {
    step = continuation(step, index, visited, weld, minDot);
    if (step) {
      visited.add(step.edge.topologyId);
      backward.push(step.edge.topologyId);
    }
  }
  // Ordered along the run so a caller can draw or measure it in sequence.
  return [...backward.reverse(), seed.topologyId, ...forward];
}
