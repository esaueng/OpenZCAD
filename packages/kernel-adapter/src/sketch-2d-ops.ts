/**
 * Sketch-plane editing on the kernel's 2D operations: corner chamfer, corner
 * fillet, and closed-loop offset.
 *
 * Everything here works in sketch-local (u, v) millimetres and is free of any
 * document type, so it can be exercised against a stub surface exactly like
 * `gcs-sketch.ts`.
 *
 * ## What the pinned kernel actually does (probed against 2.131.0)
 *
 * - `chamfer2d(coords, distance)` is an exact equal-setback corner chamfer on
 *   a closed polygon. Corner `i` of the input becomes output points `2i` (on
 *   the incoming edge) and `2i + 1` (on the outgoing edge). A distance larger
 *   than half of an adjacent edge is **silently clamped** to that half, so the
 *   setback is witnessed here and a clamped answer is refused rather than
 *   returned as though it were the chamfer that was asked for.
 * - `offsetWire2DWithJoin(wire, distance, join)` offsets the wire's **vertex
 *   polygon**: circular edges in the source are polygonised away, an open wire
 *   is silently closed, and an inward distance past the collapse point returns
 *   a zero-length or inside-out wire. Only closed, straight-sided loops are
 *   offered here, the wire is normalised counter-clockwise so a positive
 *   distance always means outward, and the result's signed area is witnessed
 *   against the source before it is accepted.
 * - The `arc` and `chamfer` joins are applied at **every** vertex, including
 *   reflex ones, where a corner treatment has no meaning: the outward offset
 *   of a concave corner is a plain miter. At a reflex vertex the kernel
 *   inserts the join backwards. For the six-line L profile
 *   `(0,0) (10,0) (10,4) (4,4) (4,10) (0,10)` offset outward by 1 it returns a
 *   `CIRCLE` from `(4,5)` to `(5,4)` at the reflex corner `(4,4)`, cutting
 *   across the notch instead of going round it, with both ends sitting **on**
 *   the source loop. Left alone that fails the distance witness below, so
 *   every concave profile was refused at every distance.
 *   {@link miterInvertedJoins} repairs those elements by intersecting the
 *   kernel's own neighbouring offset lines, which is what the join at a reflex
 *   corner should have been in the first place.
 * - `fillet2d(coords, radius)` is **not** a fillet and is deliberately not
 *   used. Its `radius` argument is a corner setback, and the curve it inserts
 *   is a sampled approximation that is tangent to the adjacent edges only at a
 *   90 degree corner: at 120 degrees the inserted run leaves the edges at a
 *   kink and its samples wander ~6e-2 from any circle through them. A sketch
 *   fillet has to be tangent, because tangency is exactly what the constraint
 *   solver is then told, so {@link filletSketchCorner} constructs the exact
 *   inscribed arc instead. `sketch-2d-ops.test.ts` pins that kernel behaviour
 *   so the reason cannot quietly rot.
 */

/** A point in sketch-plane coordinates. */
export interface Sketch2dPoint {
  x: number;
  y: number;
}

/** The kernel surface the 2D sketch operations need, narrowed for stubbing. */
export interface Sketch2dKernelSurface {
  chamfer2d(coords: Float64Array, distance: number): Float64Array;
  makePolygonWire(coords: Float64Array): number;
  offsetWire2DWithJoin(
    wire: number,
    distance: number,
    joinType: string
  ): number;
  getWireEdges(wire: number): Uint32Array;
  getEdgeCurveType(edge: number): string;
  getEdgeVertices(edge: number): Float64Array;
  getEdgeParamSpan(edge: number): Float64Array;
  evaluateEdgeCurve(edge: number, t: number): Float64Array;
}

/**
 * A corner shared by two straight sketch legs: the meeting point and each
 * leg's far endpoint. Distances are measured from `corner` outwards.
 */
export interface SketchCorner {
  corner: Sketch2dPoint;
  farA: Sketch2dPoint;
  farB: Sketch2dPoint;
}

/** Where a chamfer cuts each leg. */
export interface SketchChamferGeometry {
  /** Trim point on the leg towards `farA`. */
  a: Sketch2dPoint;
  /** Trim point on the leg towards `farB`. */
  b: Sketch2dPoint;
}

/** A tangent fillet: where each leg is trimmed, and the arc that joins them. */
export interface SketchFilletGeometry {
  /** Tangent point on the leg towards `farA`. */
  a: Sketch2dPoint;
  /** Tangent point on the leg towards `farB`. */
  b: Sketch2dPoint;
  center: Sketch2dPoint;
  radius: number;
  startAngleDeg: number;
  endAngleDeg: number;
  /**
   * Which tangent point the counter-clockwise arc starts at. Document arcs
   * sweep counter-clockwise from start to end, so this says whether leg A or
   * leg B owns the arc's `start` point.
   */
  startsAt: 'a' | 'b';
}

/** Corner treatment the kernel's wire offset understands. */
export type SketchOffsetJoin = 'intersection' | 'arc' | 'chamfer';

/** One curve of an offset result, in sketch-plane coordinates. */
export type SketchOffsetCurve =
  | { kind: 'line'; a: Sketch2dPoint; b: Sketch2dPoint }
  | {
      kind: 'arc';
      center: Sketch2dPoint;
      radius: number;
      startAngleDeg: number;
      endAngleDeg: number;
    };

const DEGREES_PER_RADIAN = 180 / Math.PI;
/**
 * Corner angles within this much of straight, or of folded back on
 * themselves, are refused: a fillet's setback grows without bound as a corner
 * straightens, and a folded-back corner has no inside to put an arc in.
 */
const MIN_CORNER_ANGLE = (1 * Math.PI) / 180;
/** Relative agreement demanded of a kernel-reported chamfer setback. */
const SETBACK_TOLERANCE = 1e-7;
/** Relative agreement demanded of a kernel-reported offset distance. */
const OFFSET_DISTANCE_TOLERANCE = 1e-6;

function subtract(a: Sketch2dPoint, b: Sketch2dPoint): Sketch2dPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function magnitude(vector: Sketch2dPoint): number {
  return Math.hypot(vector.x, vector.y);
}

function requireFinitePoint(point: Sketch2dPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`The ${label} is not a finite sketch point.`);
  }
}

interface CornerFrame {
  dirA: Sketch2dPoint;
  dirB: Sketch2dPoint;
  lengthA: number;
  lengthB: number;
  /** Interior angle at the corner, in (0, pi). */
  angle: number;
  /** Positive when leg B is counter-clockwise from leg A. */
  cross: number;
}

function cornerFrame(corner: SketchCorner): CornerFrame {
  requireFinitePoint(corner.corner, 'corner point');
  requireFinitePoint(corner.farA, 'first leg endpoint');
  requireFinitePoint(corner.farB, 'second leg endpoint');
  const legA = subtract(corner.farA, corner.corner);
  const legB = subtract(corner.farB, corner.corner);
  const lengthA = magnitude(legA);
  const lengthB = magnitude(legB);
  if (lengthA <= 0 || lengthB <= 0) {
    throw new Error('A corner needs two entities with length.');
  }
  const dirA = { x: legA.x / lengthA, y: legA.y / lengthA };
  const dirB = { x: legB.x / lengthB, y: legB.y / lengthB };
  const cosine = Math.max(-1, Math.min(1, dirA.x * dirB.x + dirA.y * dirB.y));
  const angle = Math.acos(cosine);
  if (angle < MIN_CORNER_ANGLE || angle > Math.PI - MIN_CORNER_ANGLE) {
    throw new Error(
      'The two entities are collinear where they meet, so there is no corner to modify.'
    );
  }
  return {
    dirA,
    dirB,
    lengthA,
    lengthB,
    angle,
    cross: dirA.x * dirB.y - dirA.y * dirB.x
  };
}

function along(
  origin: Sketch2dPoint,
  direction: Sketch2dPoint,
  distance: number
): Sketch2dPoint {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance
  };
}

function requireSetbackFits(frame: CornerFrame, setback: number): void {
  if (setback >= frame.lengthA || setback >= frame.lengthB) {
    const shortest = Math.min(frame.lengthA, frame.lengthB);
    throw new Error(
      `That cuts ${setback.toFixed(3)} off an entity only ${shortest.toFixed(3)} long. Use a smaller value.`
    );
  }
}

function witnessSetback(
  corner: Sketch2dPoint,
  direction: Sketch2dPoint,
  point: Sketch2dPoint,
  distance: number,
  leg: string
): void {
  const offset = subtract(point, corner);
  const projected = offset.x * direction.x + offset.y * direction.y;
  const lateral = Math.abs(offset.x * direction.y - offset.y * direction.x);
  const tolerance = Math.max(distance, 1) * SETBACK_TOLERANCE;
  if (Math.abs(projected - distance) > tolerance || lateral > tolerance) {
    throw new Error(
      `The kernel cut the ${leg} entity back ${projected.toFixed(3)} instead of the requested ${distance.toFixed(3)}. Use a smaller chamfer distance.`
    );
  }
}

/**
 * The kernel's equal-setback chamfer at one corner.
 *
 * The corner is handed to `chamfer2d` as the three-point polygon
 * `[farA, corner, farB]`, whose middle vertex is the corner being cut; the
 * kernel's own answer for that vertex is read back and witnessed against the
 * requested setback. The kernel clamps a too-large distance instead of
 * refusing, so a disagreement is reported as a refusal rather than returned as
 * a chamfer the user did not ask for.
 */
export function chamferSketchCorner(
  kernel: Sketch2dKernelSurface,
  corner: SketchCorner,
  distance: number
): SketchChamferGeometry {
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error('A chamfer distance must be a positive number.');
  }
  const frame = cornerFrame(corner);
  requireSetbackFits(frame, distance);
  const chamfered = kernel.chamfer2d(
    Float64Array.of(
      corner.farA.x,
      corner.farA.y,
      corner.corner.x,
      corner.corner.y,
      corner.farB.x,
      corner.farB.y
    ),
    distance
  );
  if (chamfered.length !== 12) {
    throw new Error(
      `The kernel returned ${chamfered.length / 2} chamfer points for a three-corner polygon; six were expected.`
    );
  }
  // Corner i of the input becomes output points 2i and 2i + 1; the corner
  // being cut is input vertex 1.
  const a = { x: chamfered[4]!, y: chamfered[5]! };
  const b = { x: chamfered[6]!, y: chamfered[7]! };
  witnessSetback(corner.corner, frame.dirA, a, distance, 'first');
  witnessSetback(corner.corner, frame.dirB, b, distance, 'second');
  return { a, b };
}

/**
 * The exact tangent fillet at one corner.
 *
 * Built here rather than by `fillet2d`, which parameterises by setback and is
 * not tangent away from a right angle: see this module's header. The arc is
 * the unique circle of the requested radius inscribed in the corner, so the
 * tangency the solver is afterwards told about is true of the geometry it is
 * told about.
 */
export function filletSketchCorner(
  corner: SketchCorner,
  radius: number
): SketchFilletGeometry {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error('A fillet radius must be a positive number.');
  }
  const frame = cornerFrame(corner);
  const half = frame.angle / 2;
  const setback = radius / Math.tan(half);
  requireSetbackFits(frame, setback);
  const a = along(corner.corner, frame.dirA, setback);
  const b = along(corner.corner, frame.dirB, setback);
  const bisector = {
    x: frame.dirA.x + frame.dirB.x,
    y: frame.dirA.y + frame.dirB.y
  };
  const bisectorLength = magnitude(bisector);
  if (bisectorLength <= 0) {
    throw new Error(
      'The two entities fold back on each other, so no fillet fits between them.'
    );
  }
  const center = along(
    corner.corner,
    { x: bisector.x / bisectorLength, y: bisector.y / bisectorLength },
    radius / Math.sin(half)
  );
  const angleA = Math.atan2(a.y - center.y, a.x - center.x);
  const angleB = Math.atan2(b.y - center.y, b.x - center.x);
  // The fillet arc is the minor one, sweeping pi minus the interior angle.
  // Leg A owns the start when leg B lies clockwise from it.
  const startsAt: 'a' | 'b' = frame.cross < 0 ? 'a' : 'b';
  const startAngle = startsAt === 'a' ? angleA : angleB;
  const endAngle = startsAt === 'a' ? angleB : angleA;
  const startAngleDeg = startAngle * DEGREES_PER_RADIAN;
  let sweepDeg = (endAngle - startAngle) * DEGREES_PER_RADIAN;
  while (sweepDeg <= 0) {
    sweepDeg += 360;
  }
  return {
    a,
    b,
    center,
    radius,
    startAngleDeg,
    endAngleDeg: startAngleDeg + sweepDeg,
    startsAt
  };
}

/** Signed area of a closed polygon; positive when it runs counter-clockwise. */
export function signedLoopArea(loop: readonly Sketch2dPoint[]): number {
  let total = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const current = loop[index]!;
    const next = loop[(index + 1) % loop.length]!;
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

function arcPoint(
  center: Sketch2dPoint,
  radius: number,
  angleDeg: number
): Sketch2dPoint {
  const angle = angleDeg / DEGREES_PER_RADIAN;
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius
  };
}

/** Distance from a point to the closed polyline through `loop`. */
function distanceToLoop(
  point: Sketch2dPoint,
  loop: readonly Sketch2dPoint[]
): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    const span = subtract(b, a);
    const spanLengthSquared = span.x * span.x + span.y * span.y;
    const offset = subtract(point, a);
    const t =
      spanLengthSquared <= 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              (offset.x * span.x + offset.y * span.y) / spanLengthSquared
            )
          );
    closest = Math.min(
      closest,
      Math.hypot(offset.x - span.x * t, offset.y - span.y * t)
    );
  }
  return closest;
}

/** Both ends of a curve, in sketch-plane coordinates. */
function curveEnds(curve: SketchOffsetCurve): Sketch2dPoint[] {
  return curve.kind === 'line'
    ? [curve.a, curve.b]
    : [
        arcPoint(curve.center, curve.radius, curve.startAngleDeg),
        arcPoint(curve.center, curve.radius, curve.endAngleDeg)
      ];
}

/** Points spread evenly along a curve, both ends included. */
function sampleCurve(
  curve: SketchOffsetCurve,
  samples: number
): Sketch2dPoint[] {
  return Array.from({ length: samples }, (_unused, index) => {
    const t = index / (samples - 1);
    if (curve.kind === 'line') {
      return {
        x: curve.a.x + (curve.b.x - curve.a.x) * t,
        y: curve.a.y + (curve.b.y - curve.a.y) * t
      };
    }
    return arcPoint(
      curve.center,
      curve.radius,
      curve.startAngleDeg + (curve.endAngleDeg - curve.startAngleDeg) * t
    );
  });
}

/**
 * Where the infinite lines carrying two segments meet, or `null` when they are
 * parallel. The tolerance is relative to both segment lengths, so a
 * near-parallel pair is reported as parallel rather than as a point at
 * infinity.
 */
function lineIntersection(
  first: Extract<SketchOffsetCurve, { kind: 'line' }>,
  second: Extract<SketchOffsetCurve, { kind: 'line' }>
): Sketch2dPoint | null {
  const firstSpan = subtract(first.b, first.a);
  const secondSpan = subtract(second.b, second.a);
  const determinant = firstSpan.x * secondSpan.y - firstSpan.y * secondSpan.x;
  const scale = magnitude(firstSpan) * magnitude(secondSpan);
  if (scale <= 0 || Math.abs(determinant) <= scale * 1e-12) {
    return null;
  }
  const offset = subtract(second.a, first.a);
  const t = (offset.x * secondSpan.y - offset.y * secondSpan.x) / determinant;
  const point = {
    x: first.a.x + firstSpan.x * t,
    y: first.a.y + firstSpan.y * t
  };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

/** Which end of `line` sits against `neighbourEnds`. */
function adjacentEnd(
  line: Extract<SketchOffsetCurve, { kind: 'line' }>,
  neighbourEnds: readonly Sketch2dPoint[]
): 'a' | 'b' {
  const nearest = (point: Sketch2dPoint): number =>
    Math.min(...neighbourEnds.map((end) => magnitude(subtract(point, end))));
  return nearest(line.a) <= nearest(line.b) ? 'a' : 'b';
}

const OFFSET_JOIN_REFUSAL =
  'That offset is too large for one of the loop’s inside corners. Use a smaller distance.';

/**
 * Replace the join elements the kernel inserted backwards at reflex corners
 * with the miter of the offset lines on either side of them.
 *
 * The kernel emits one join element per source vertex whatever the vertex
 * does, and at a reflex vertex it emits it inverted: the element lies wholly
 * *inside* the offset distance, cutting across the notch. That is the only way
 * a curve of a correct offset can be inside the distance at every one of its
 * points, so "every sample nearer the source than the distance" identifies
 * exactly those elements and never a legitimate one — a valid `chamfer` join
 * at a convex corner has a midpoint inside the distance but both ends on it,
 * and a valid offset line lies at or beyond the distance everywhere.
 *
 * The replacement is not invented geometry: it is the intersection of the two
 * offset lines the kernel itself returned, which is the `intersection` join
 * the kernel produces for the same corner when asked for it. Anything the
 * repair cannot express — two inverted elements in a row, a non-line
 * neighbour, parallel neighbours, or a miter that swallows a whole offset
 * line — refuses rather than guesses.
 */
function miterInvertedJoins(
  curves: readonly SketchOffsetCurve[],
  source: readonly Sketch2dPoint[],
  distance: number
): SketchOffsetCurve[] {
  const wanted = Math.abs(distance);
  const tolerance = Math.max(wanted, 1) * OFFSET_DISTANCE_TOLERANCE;
  const inverted = curves.map((curve) =>
    sampleCurve(curve, 5).every(
      (point) => distanceToLoop(point, source) < wanted - tolerance
    )
  );
  if (!inverted.some(Boolean)) {
    return [...curves];
  }
  const count = curves.length;
  const working = curves.map((curve) =>
    curve.kind === 'line'
      ? { ...curve, a: { ...curve.a }, b: { ...curve.b } }
      : { ...curve }
  );
  for (let index = 0; index < count; index += 1) {
    if (!inverted[index]) {
      continue;
    }
    const previous = (index - 1 + count) % count;
    const next = (index + 1) % count;
    if (previous === next || inverted[previous] || inverted[next]) {
      throw new Error(OFFSET_JOIN_REFUSAL);
    }
    // The miter is taken from the kernel's original lines. Moving an endpoint
    // onto the miter point leaves the carrying line unchanged, so a line
    // mitered at both ends gives the same answer in either order.
    const before = curves[previous]!;
    const after = curves[next]!;
    if (before.kind !== 'line' || after.kind !== 'line') {
      throw new Error(OFFSET_JOIN_REFUSAL);
    }
    const miter = lineIntersection(before, after);
    if (!miter) {
      throw new Error(OFFSET_JOIN_REFUSAL);
    }
    const ends = curveEnds(curves[index]!);
    const beforeWorking = working[previous]!;
    const afterWorking = working[next]!;
    if (beforeWorking.kind !== 'line' || afterWorking.kind !== 'line') {
      throw new Error(OFFSET_JOIN_REFUSAL);
    }
    beforeWorking[adjacentEnd(before, ends)] = miter;
    afterWorking[adjacentEnd(after, ends)] = miter;
  }
  const kept = working.filter((_unused, index) => !inverted[index]);
  for (const curve of kept) {
    if (
      curve.kind === 'line' &&
      magnitude(subtract(curve.b, curve.a)) <= tolerance
    ) {
      // A miter that consumed a whole offset line means the corner closed up:
      // the offset is past what this profile's inside corner can carry.
      throw new Error(OFFSET_JOIN_REFUSAL);
    }
  }
  if (kept.length < 3) {
    throw new Error(OFFSET_JOIN_REFUSAL);
  }
  return kept;
}

/**
 * The arc through three points the kernel evaluated on its own circular edge.
 * Three points fix the circle exactly, so this reads the kernel's answer back
 * rather than approximating it; the middle point also says which way round the
 * edge runs.
 */
function circleThroughPoints(
  start: Sketch2dPoint,
  middle: Sketch2dPoint,
  end: Sketch2dPoint
): Extract<SketchOffsetCurve, { kind: 'arc' }> {
  const determinant =
    2 *
    (start.x * (middle.y - end.y) +
      middle.x * (end.y - start.y) +
      end.x * (start.y - middle.y));
  if (Math.abs(determinant) <= 0) {
    throw new Error('The kernel offset produced a degenerate arc.');
  }
  const startSquared = start.x * start.x + start.y * start.y;
  const middleSquared = middle.x * middle.x + middle.y * middle.y;
  const endSquared = end.x * end.x + end.y * end.y;
  const center = {
    x:
      (startSquared * (middle.y - end.y) +
        middleSquared * (end.y - start.y) +
        endSquared * (start.y - middle.y)) /
      determinant,
    y:
      (startSquared * (end.x - middle.x) +
        middleSquared * (start.x - end.x) +
        endSquared * (middle.x - start.x)) /
      determinant
  };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const middleAngle = Math.atan2(middle.y - center.y, middle.x - center.x);
  const sweepTo = (from: number, to: number): number => {
    const wrap = Math.PI * 2;
    return (((to - from) % wrap) + wrap) % wrap;
  };
  // Document arcs sweep counter-clockwise from start to end. A kernel edge
  // that runs the other way describes the same curve with its ends swapped.
  const counterClockwise =
    sweepTo(startAngle, middleAngle) < sweepTo(startAngle, endAngle);
  const from = counterClockwise ? startAngle : endAngle;
  const to = counterClockwise ? endAngle : startAngle;
  const startAngleDeg = from * DEGREES_PER_RADIAN;
  return {
    kind: 'arc',
    center,
    radius: Math.hypot(start.x - center.x, start.y - center.y),
    startAngleDeg,
    endAngleDeg: startAngleDeg + sweepTo(from, to) * DEGREES_PER_RADIAN
  };
}

function readOffsetWire(
  kernel: Sketch2dKernelSurface,
  wire: number
): SketchOffsetCurve[] {
  const curves: SketchOffsetCurve[] = [];
  for (const edge of kernel.getWireEdges(wire)) {
    const type = kernel.getEdgeCurveType(edge);
    const vertices = kernel.getEdgeVertices(edge);
    const start = { x: vertices[0]!, y: vertices[1]! };
    const end = { x: vertices[3]!, y: vertices[4]! };
    if (type === 'LINE') {
      curves.push({ kind: 'line', a: start, b: end });
      continue;
    }
    if (type !== 'CIRCLE') {
      throw new Error(
        `The kernel offset produced a ${type} edge, which a sketch cannot hold.`
      );
    }
    const span = kernel.getEdgeParamSpan(edge);
    const middleRaw = kernel.evaluateEdgeCurve(
      edge,
      ((span[0] ?? 0) + (span[1] ?? 0)) / 2
    );
    curves.push(
      circleThroughPoints(start, { x: middleRaw[0]!, y: middleRaw[1]! }, end)
    );
  }
  if (curves.length < 3) {
    throw new Error('The kernel offset produced no usable loop.');
  }
  return curves;
}

/**
 * Offset one closed, straight-sided sketch loop with the kernel's planar wire
 * offset.
 *
 * A positive `distance` always means outward, whichever way the caller's loop
 * happens to run: the wire is built counter-clockwise so the kernel's own sign
 * convention lines up with that promise. The kernel returns a degenerate or
 * inside-out wire rather than refusing when an inward offset passes the
 * collapse point, so the result is witnessed against the source's signed area
 * before it is handed back.
 *
 * Concave loops are in scope. The kernel inverts the `arc` and `chamfer` join
 * it inserts at a reflex vertex, so those elements are mitered away first —
 * see {@link miterInvertedJoins} — and the witnesses then run on the repaired
 * loop exactly as before.
 */
export function offsetSketchLoop(
  kernel: Sketch2dKernelSurface,
  loop: readonly Sketch2dPoint[],
  distance: number,
  join: SketchOffsetJoin
): SketchOffsetCurve[] {
  if (!Number.isFinite(distance) || distance === 0) {
    throw new Error('An offset distance must be a non-zero number.');
  }
  if (loop.length < 3) {
    throw new Error('An offset needs a closed loop of at least three lines.');
  }
  for (const point of loop) {
    requireFinitePoint(point, 'loop point');
  }
  const area = signedLoopArea(loop);
  if (area === 0) {
    throw new Error('The selected loop encloses no area.');
  }
  const oriented = area > 0 ? [...loop] : [...loop].reverse();
  const coords = new Float64Array(oriented.length * 3);
  oriented.forEach((point, index) => {
    coords[index * 3] = point.x;
    coords[index * 3 + 1] = point.y;
    coords[index * 3 + 2] = 0;
  });
  const wire = kernel.makePolygonWire(coords);
  // The `arc` and `chamfer` joins only mean anything on the convex side. On an
  // inward offset the kernel inserts them anyway, and the loops they add cross
  // the offset itself; the straight corner is the only one that is right.
  const effectiveJoin: SketchOffsetJoin = distance > 0 ? join : 'intersection';
  const offset = readOffsetWire(
    kernel,
    kernel.offsetWire2DWithJoin(wire, distance, effectiveJoin)
  );
  // The kernel inserts a join element at every vertex, and inverts the ones at
  // reflex vertices. Repair those before the witnesses run, or every concave
  // loop is refused. An `intersection` offset has no join elements to repair.
  const curves =
    effectiveJoin === 'intersection'
      ? offset
      : miterInvertedJoins(offset, oriented, distance);
  const ends = curves.flatMap(curveEnds);
  const resultArea = signedLoopArea(
    curves.map((curve) => curveEnds(curve)[0]!)
  );
  if (resultArea <= 0) {
    throw new Error(
      'That offset collapses the loop through itself. Use a smaller distance.'
    );
  }
  const sourceArea = Math.abs(area);
  if (distance > 0 ? resultArea <= sourceArea : resultArea >= sourceArea) {
    throw new Error(
      'The kernel offset did not move the loop in the requested direction.'
    );
  }
  // An inward offset taken past the collapse point comes back out the far
  // side as a valid-looking loop at the wrong distance, so every offset point
  // is checked against the distance that was actually asked for. No point of
  // a true offset is nearer the source than the offset distance.
  const wanted = Math.abs(distance);
  const tolerance = Math.max(wanted, 1) * OFFSET_DISTANCE_TOLERANCE;
  for (const end of ends) {
    if (distanceToLoop(end, oriented) < wanted - tolerance) {
      throw new Error(
        'That offset collapses the loop through itself. Use a smaller distance.'
      );
    }
  }
  return curves;
}

/** One planar sketch edit, as it crosses the worker boundary. */
export type SketchPlanarOperation =
  | { kind: 'fillet'; corner: SketchCorner; radius: number }
  | { kind: 'chamfer'; corner: SketchCorner; distance: number }
  | {
      kind: 'offset';
      loop: Sketch2dPoint[];
      distance: number;
      join: SketchOffsetJoin;
    };

/** What one planar sketch edit answers with. */
export type SketchPlanarResult =
  | { kind: 'fillet'; fillet: SketchFilletGeometry }
  | { kind: 'chamfer'; chamfer: SketchChamferGeometry }
  | { kind: 'offset'; curves: SketchOffsetCurve[] };

/** Runs one planar sketch edit against the kernel. */
export function runSketchPlanarOperation(
  kernel: Sketch2dKernelSurface,
  operation: SketchPlanarOperation
): SketchPlanarResult {
  if (operation.kind === 'fillet') {
    return {
      kind: 'fillet',
      fillet: filletSketchCorner(operation.corner, operation.radius)
    };
  }
  if (operation.kind === 'chamfer') {
    return {
      kind: 'chamfer',
      chamfer: chamferSketchCorner(kernel, operation.corner, operation.distance)
    };
  }
  return {
    kind: 'offset',
    curves: offsetSketchLoop(
      kernel,
      operation.loop,
      operation.distance,
      operation.join
    )
  };
}
