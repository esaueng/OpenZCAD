import {
  MAX_SKETCH_SPLINE_POINTS,
  type ParamValue,
  type SketchObjectData
} from '@openzcad/shared';
import { geometryTolerance } from './tolerance';

/**
 * I01 curve entities: the exact geometry behind the `ellipse` and `spline`
 * sketch objects.
 *
 * Every consumer — region analysis, the viewport, the exact kernel builder,
 * the OCCT parity reference and the DXF/SVG exporters — derives its curve
 * from the functions here, so a spline is interpolated once, by one
 * algorithm, and the profile the viewport fills is the face the kernel
 * builds. The kernel never interpolates: it receives the control points and
 * knots computed here (`liftCurve2dToPlane`, NURBS), which is why the fit is
 * implemented in this module rather than delegated to `interpolatePoints`.
 *
 * Splines are normalized to one representation: a non-rational, clamped
 * B-spline (`SplineGeometry`). A closed spline is built periodic and then
 * clamped at its seam by knot insertion, which changes the representation but
 * not the curve, so it stays smooth through the seam.
 */

export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * A resolved ellipse or elliptical arc. The point at parameter `t` is
 * `center + radiusX·cos t·u + radiusY·sin t·v` with `u` at `rotation`
 * radians from the sketch x axis. The curve runs counter-clockwise in `t`
 * from `start` through `start + sweep`; `sweep` is 2π for a full ellipse.
 */
export interface EllipseGeometry {
  center: CurvePoint;
  radiusX: number;
  radiusY: number;
  rotation: number;
  start: number;
  sweep: number;
}

/**
 * A non-rational clamped B-spline: `knots.length === controls.length +
 * degree + 1`, the first and last knots repeated `degree + 1` times, so the
 * curve starts on `controls[0]` and ends on the last control point. The
 * parameter domain is `[knots[0], knots[knots.length - 1]]`.
 */
export interface SplineGeometry {
  degree: number;
  knots: number[];
  controls: CurvePoint[];
  /** True when the curve was built periodic: its ends meet smoothly. */
  closed: boolean;
}

const TWO_PI = Math.PI * 2;
const DEGREES = Math.PI / 180;

export function ellipsePoint(ellipse: EllipseGeometry, t: number): CurvePoint {
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ux = Math.cos(ellipse.rotation);
  const uy = Math.sin(ellipse.rotation);
  return {
    x:
      ellipse.center.x +
      ellipse.radiusX * cos * ux -
      ellipse.radiusY * sin * uy,
    y:
      ellipse.center.y + ellipse.radiusX * cos * uy + ellipse.radiusY * sin * ux
  };
}

/** First and second derivative with respect to `t`. */
export function ellipseDerivatives(
  ellipse: EllipseGeometry,
  t: number
): { d1: CurvePoint; d2: CurvePoint } {
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ux = Math.cos(ellipse.rotation);
  const uy = Math.sin(ellipse.rotation);
  return {
    d1: {
      x: -ellipse.radiusX * sin * ux - ellipse.radiusY * cos * uy,
      y: -ellipse.radiusX * sin * uy + ellipse.radiusY * cos * ux
    },
    d2: {
      x: -ellipse.radiusX * cos * ux + ellipse.radiusY * sin * uy,
      y: -ellipse.radiusX * cos * uy - ellipse.radiusY * sin * ux
    }
  };
}

/** True when an ellipse's sweep is a whole turn. */
export function isFullEllipse(
  ellipse: Pick<EllipseGeometry, 'sweep'>
): boolean {
  return Math.abs(ellipse.sweep - TWO_PI) <= 1e-9;
}

/**
 * `½∫ P × P' dt` over `[t0, t1]` of an ellipse — its Green's-theorem area
 * contribution, exact in closed form: `½[c × (P(t1) − P(t0)) + a·b·(t1 − t0)]`.
 */
export function ellipseAreaTerm(
  ellipse: EllipseGeometry,
  t0: number,
  t1: number
): number {
  const p0 = ellipsePoint(ellipse, t0);
  const p1 = ellipsePoint(ellipse, t1);
  const c = ellipse.center;
  return (
    (c.x * (p1.y - p0.y) -
      c.y * (p1.x - p0.x) +
      ellipse.radiusX * ellipse.radiusY * (t1 - t0)) /
    2
  );
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

/** Resolves an `ellipse` object; throws on an unusable dimension. */
export function resolveEllipseGeometry(
  data: Extract<SketchObjectData, { objectKind: 'ellipse' }>,
  resolve: (value: ParamValue) => number
): EllipseGeometry {
  const radiusX = finite(resolve(data.radiusX), 'Ellipse radius');
  const radiusY = finite(resolve(data.radiusY), 'Ellipse radius');
  if (radiusX <= 0 || radiusY <= 0) {
    throw new Error('Ellipse radii must be positive.');
  }
  const rotation =
    finite(resolve(data.rotationDeg), 'Ellipse rotation') * DEGREES;
  const center = {
    x: finite(resolve(data.centerX), 'Ellipse centre'),
    y: finite(resolve(data.centerY), 'Ellipse centre')
  };
  if ((data.startParamDeg === undefined) !== (data.endParamDeg === undefined)) {
    throw new Error('An elliptical arc needs both a start and an end.');
  }
  if (data.startParamDeg === undefined || data.endParamDeg === undefined) {
    return { center, radiusX, radiusY, rotation, start: 0, sweep: TWO_PI };
  }
  const startDeg = finite(resolve(data.startParamDeg), 'Arc start');
  const endDeg = finite(resolve(data.endParamDeg), 'Arc end');
  const sweepDeg = ellipticalArcSweepDegrees(startDeg, endDeg);
  return {
    center,
    radiusX,
    radiusY,
    rotation,
    start: normalizeRadians(startDeg * DEGREES),
    sweep: sweepDeg * DEGREES
  };
}

/**
 * Counter-clockwise sweep from `start` to `end` in (0, 360] degrees. A raw
 * −360° wraps to nothing and is refused, as `boundedArcSweepDegrees` refuses
 * it for a circular arc: `start` 360 and `end` 0 is no arc at all.
 */
export function ellipticalArcSweepDegrees(start: number, end: number): number {
  const delta = end - start;
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 360) {
    throw new Error('Elliptical arc sweep must be non-zero and at most 360°.');
  }
  const sweep = delta < 0 ? delta + 360 : delta;
  if (!(sweep > 0)) {
    throw new Error('Elliptical arc sweep must be non-zero.');
  }
  return sweep;
}

function normalizeRadians(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

// ---------------------------------------------------------------------------
// B-splines
// ---------------------------------------------------------------------------

/** Largest `span` with `knots[span] <= u < knots[span + 1]` inside the domain. */
function findSpan(degree: number, knots: readonly number[], u: number): number {
  const last = knots.length - degree - 2;
  if (u >= knots[last + 1]!) {
    // At (or past) the end: the last non-empty span.
    let span = last;
    while (span > degree && knots[span]! >= knots[span + 1]!) {
      span -= 1;
    }
    return span;
  }
  if (u <= knots[degree]!) {
    let span = degree;
    while (span < last && knots[span + 1]! <= knots[degree]!) {
      span += 1;
    }
    return span;
  }
  let low = degree;
  let high = last + 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (u < knots[mid]!) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return low;
}

/** The `degree + 1` non-zero basis values at `u` (Cox–de Boor). */
function basisFunctions(
  span: number,
  u: number,
  degree: number,
  knots: readonly number[]
): number[] {
  const basis = [1];
  const left = [0];
  const right = [0];
  for (let j = 1; j <= degree; j += 1) {
    left[j] = u - knots[span + 1 - j]!;
    right[j] = knots[span + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r += 1) {
      const denominator = right[r + 1]! + left[j - r]!;
      const term = denominator === 0 ? 0 : basis[r]! / denominator;
      basis[r] = saved + right[r + 1]! * term;
      saved = left[j - r]! * term;
    }
    basis[j] = saved;
  }
  return basis;
}

function evaluateBSpline(
  degree: number,
  knots: readonly number[],
  controls: readonly CurvePoint[],
  u: number
): CurvePoint {
  if (degree === 0) {
    return { ...controls[findSpanDegreeZero(knots, u)]! };
  }
  const span = findSpan(degree, knots, u);
  const basis = basisFunctions(span, u, degree, knots);
  let x = 0;
  let y = 0;
  for (let j = 0; j <= degree; j += 1) {
    const control = controls[span - degree + j]!;
    x += basis[j]! * control.x;
    y += basis[j]! * control.y;
  }
  return { x, y };
}

function findSpanDegreeZero(knots: readonly number[], u: number): number {
  for (let index = knots.length - 2; index >= 0; index -= 1) {
    if (knots[index]! <= u && knots[index]! < knots[index + 1]!) {
      return index;
    }
  }
  return 0;
}

export function splineDomain(spline: SplineGeometry): [number, number] {
  return [spline.knots[0]!, spline.knots[spline.knots.length - 1]!];
}

export function splinePoint(spline: SplineGeometry, u: number): CurvePoint {
  const [start, end] = splineDomain(spline);
  if (u <= start) {
    return { ...spline.controls[0]! };
  }
  if (u >= end) {
    return { ...spline.controls[spline.controls.length - 1]! };
  }
  return evaluateBSpline(spline.degree, spline.knots, spline.controls, u);
}

/** The hodograph: a B-spline one degree lower whose points are `C'(u)`. */
function derivativeCurve(
  degree: number,
  knots: readonly number[],
  controls: readonly CurvePoint[]
): { degree: number; knots: number[]; controls: CurvePoint[] } {
  if (degree === 0) {
    return {
      degree: 0,
      knots: [...knots],
      controls: controls.map(() => ({ x: 0, y: 0 }))
    };
  }
  const next: CurvePoint[] = [];
  for (let i = 0; i + 1 < controls.length; i += 1) {
    const span = knots[i + degree + 1]! - knots[i + 1]!;
    const factor = span === 0 ? 0 : degree / span;
    next.push({
      x: factor * (controls[i + 1]!.x - controls[i]!.x),
      y: factor * (controls[i + 1]!.y - controls[i]!.y)
    });
  }
  return { degree: degree - 1, knots: knots.slice(1, -1), controls: next };
}

const derivativeCache = new WeakMap<
  SplineGeometry,
  {
    first: ReturnType<typeof derivativeCurve>;
    second: ReturnType<typeof derivativeCurve>;
  }
>();

function derivativesOf(spline: SplineGeometry) {
  let cached = derivativeCache.get(spline);
  if (!cached) {
    const first = derivativeCurve(spline.degree, spline.knots, spline.controls);
    const second = derivativeCurve(first.degree, first.knots, first.controls);
    cached = { first, second };
    derivativeCache.set(spline, cached);
  }
  return cached;
}

/**
 * An upper bound on |C''(u)| over the whole spline: the largest control
 * point of its second-derivative curve, which contains that curve by the
 * convex-hull property. A chord over `[u0, u1]` then stays within
 * `(u1 − u0)² / 8` times this bound of the curve.
 */
export function splineSecondDerivativeBound(spline: SplineGeometry): number {
  const { second } = derivativesOf(spline);
  let bound = 0;
  for (const point of second.controls) {
    bound = Math.max(bound, Math.hypot(point.x, point.y));
  }
  return bound;
}

/** First and second derivative of a spline with respect to its parameter. */
export function splineDerivatives(
  spline: SplineGeometry,
  u: number
): { d1: CurvePoint; d2: CurvePoint } {
  const cached = derivativesOf(spline);
  const [start, end] = splineDomain(spline);
  const at = Math.min(Math.max(u, start), end);
  return {
    d1: evaluateBSpline(
      cached.first.degree,
      cached.first.knots,
      cached.first.controls,
      at
    ),
    d2:
      cached.second.controls.length > 0
        ? evaluateBSpline(
            cached.second.degree,
            cached.second.knots,
            cached.second.controls,
            at
          )
        : { x: 0, y: 0 }
  };
}

/** Inserts the knot `u` once (Boehm). Returns new arrays. */
function insertKnot(
  degree: number,
  knots: readonly number[],
  controls: readonly CurvePoint[],
  u: number
): { knots: number[]; controls: CurvePoint[] } {
  const k = findSpan(degree, knots, u);
  const next: CurvePoint[] = [];
  for (let i = 0; i <= controls.length; i += 1) {
    if (i <= k - degree) {
      next.push({ ...controls[i]! });
    } else if (i > k) {
      next.push({ ...controls[i - 1]! });
    } else {
      const denominator = knots[i + degree]! - knots[i]!;
      const alpha = denominator === 0 ? 0 : (u - knots[i]!) / denominator;
      next.push({
        x: alpha * controls[i]!.x + (1 - alpha) * controls[i - 1]!.x,
        y: alpha * controls[i]!.y + (1 - alpha) * controls[i - 1]!.y
      });
    }
  }
  const nextKnots = [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)];
  return { knots: nextKnots, controls: next };
}

function multiplicity(knots: readonly number[], u: number): number {
  return knots.filter((knot) => knot === u).length;
}

/**
 * The exact piece of a B-spline between parameters `a < b`, as a clamped
 * B-spline over `[a, b]`. Works on clamped and unclamped (periodic) knot
 * vectors alike: both ends are raised to multiplicity `degree` by knot
 * insertion, which leaves the curve untouched, and the control points
 * between them are the piece.
 */
function subcurve(
  degree: number,
  knotsIn: readonly number[],
  controlsIn: readonly CurvePoint[],
  a: number,
  b: number
): { knots: number[]; controls: CurvePoint[] } {
  let knots = [...knotsIn];
  let controls = [...controlsIn];
  for (const u of [a, b]) {
    while (multiplicity(knots, u) < degree) {
      ({ knots, controls } = insertKnot(degree, knots, controls, u));
    }
  }
  const lastA = knots.lastIndexOf(a);
  const firstB = knots.indexOf(b);
  const pieceControls = controls.slice(lastA - degree, firstB);
  const pieceKnots = [
    ...Array<number>(degree + 1).fill(a),
    ...knots.slice(lastA + 1, firstB),
    ...Array<number>(degree + 1).fill(b)
  ];
  return { knots: pieceKnots, controls: pieceControls };
}

/** The piece of a clamped spline over `[a, b]` (`a < b`, inside the domain). */
export function splineSubcurve(
  spline: SplineGeometry,
  a: number,
  b: number
): SplineGeometry {
  const [start, end] = splineDomain(spline);
  if (a <= start && b >= end) {
    return spline;
  }
  const piece = subcurve(
    spline.degree,
    spline.knots,
    spline.controls,
    Math.max(a, start),
    Math.min(b, end)
  );
  return { degree: spline.degree, ...piece, closed: false };
}

/** The same curve traversed the other way, over the same domain. */
export function reverseSpline(spline: SplineGeometry): SplineGeometry {
  const [start, end] = splineDomain(spline);
  return {
    degree: spline.degree,
    knots: [...spline.knots].reverse().map((knot) => start + end - knot),
    controls: [...spline.controls].reverse(),
    closed: spline.closed
  };
}

/** Distinct knot values inside the domain, ends included, ascending. */
export function splineBreakpoints(spline: SplineGeometry): number[] {
  const values: number[] = [];
  for (const knot of spline.knots) {
    if (values.length === 0 || knot > values[values.length - 1]!) {
      values.push(knot);
    }
  }
  return values;
}

/**
 * The spline as consecutive Bézier segments of its own degree, one per knot
 * span, each `degree + 1` control points. Exact: the SVG exporter writes
 * these as path commands, and degree ≤ 3 maps onto `Q`/`C`.
 */
export function splineBezierSegments(spline: SplineGeometry): CurvePoint[][] {
  const breaks = splineBreakpoints(spline);
  const segments: CurvePoint[][] = [];
  for (let index = 0; index + 1 < breaks.length; index += 1) {
    segments.push(
      splineSubcurve(spline, breaks[index]!, breaks[index + 1]!).controls
    );
  }
  return segments;
}

/** One Bézier piece of a spline over the parameter range `[t0, t1]`. */
interface BezierPiece {
  controls: CurvePoint[];
  t0: number;
  t1: number;
}

function splitBezier(piece: BezierPiece): [BezierPiece, BezierPiece] {
  const left: CurvePoint[] = [];
  const right: CurvePoint[] = [];
  let row = piece.controls;
  while (row.length > 0) {
    left.push(row[0]!);
    right.unshift(row[row.length - 1]!);
    row = row.slice(1).map((point, index) => ({
      x: (row[index]!.x + point.x) / 2,
      y: (row[index]!.y + point.y) / 2
    }));
  }
  const middle = (piece.t0 + piece.t1) / 2;
  return [
    { controls: left, t0: piece.t0, t1: middle },
    { controls: right, t0: middle, t1: piece.t1 }
  ];
}

function bezierBox(piece: BezierPiece) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of piece.controls) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

/** True when every control point lies within `tolerance` of the chord. */
function bezierFlat(piece: BezierPiece, tolerance: number): boolean {
  const a = piece.controls[0]!;
  const b = piece.controls[piece.controls.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return piece.controls.every((point) =>
    length > 0
      ? Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length <=
        tolerance
      : Math.hypot(point.x - a.x, point.y - a.y) <= tolerance
  );
}

/** Total absolute turning of a Bézier piece's control polygon, radians. */
function controlTurning(piece: BezierPiece): number {
  let total = 0;
  let previous: CurvePoint | null = null;
  for (let index = 1; index < piece.controls.length; index += 1) {
    const a = piece.controls[index - 1]!;
    const b = piece.controls[index]!;
    const edge = { x: b.x - a.x, y: b.y - a.y };
    if (edge.x === 0 && edge.y === 0) {
      continue;
    }
    if (previous) {
      total += Math.abs(
        Math.atan2(
          previous.x * edge.y - previous.y * edge.x,
          previous.x * edge.x + previous.y * edge.y
        )
      );
    }
    previous = edge;
  }
  return total;
}

/**
 * A point where a spline crosses itself, or null.
 *
 * Exact recursive subdivision of its Bézier spans, never a fixed sampling:
 * pieces whose control hulls cannot meet are pruned, and the rest are split
 * at their parameter midpoint until both are flat to `tolerance`, where the
 * two chords stand for the curve. So a loop of any size above the tolerance
 * is found, however few knot spans carry it. Pieces that share a joint (the
 * neighbours of a split, or a closed spline's seam) do not count their own
 * common end as a crossing.
 */
export function splineSelfIntersection(
  spline: SplineGeometry,
  tolerance: number
): CurvePoint | null {
  const [start, end] = splineDomain(spline);
  const breaks = splineBreakpoints(spline);
  const spans: BezierPiece[] = [];
  for (let index = 0; index + 1 < breaks.length; index += 1) {
    spans.push({
      controls: splineSubcurve(spline, breaks[index]!, breaks[index + 1]!)
        .controls,
      t0: breaks[index]!,
      t1: breaks[index + 1]!
    });
  }
  const MAX_DEPTH = 52;
  // Which end of `a` it shares with `b`: 1 for a's end, 0 for its start.
  const sharedEnd = (a: BezierPiece, b: BezierPiece): 0 | 1 | null =>
    a.t1 === b.t0 || (spline.closed && a.t1 === end && b.t0 === start)
      ? 1
      : a.t0 === b.t1 || (spline.closed && a.t0 === start && b.t1 === end)
        ? 0
        : null;

  const chordCrossing = (a: BezierPiece, b: BezierPiece): CurvePoint | null => {
    const a0 = a.controls[0]!;
    const a1 = a.controls[a.controls.length - 1]!;
    const b0 = b.controls[0]!;
    const b1 = b.controls[b.controls.length - 1]!;
    const rx = a1.x - a0.x;
    const ry = a1.y - a0.y;
    const qx = b1.x - b0.x;
    const qy = b1.y - b0.y;
    const denominator = rx * qy - ry * qx;
    if (Math.abs(denominator) < 1e-300) {
      return null;
    }
    const wx = b0.x - a0.x;
    const wy = b0.y - a0.y;
    const r = (wx * qy - wy * qx) / denominator;
    const q = (wx * ry - wy * rx) / denominator;
    const joint = sharedEnd(a, b);
    // The common end of two neighbours is a joint, not a crossing.
    const slack = 1e-9;
    const rLow = joint === 0 ? slack : -slack;
    const rHigh = joint === 1 ? 1 - slack : 1 + slack;
    const qLow = joint === 1 ? slack : -slack;
    const qHigh = joint === 0 ? 1 - slack : 1 + slack;
    if (r < rLow || r > rHigh || q < qLow || q > qHigh) {
      return null;
    }
    return { x: a0.x + rx * r, y: a0.y + ry * r };
  };

  const pair = (
    a: BezierPiece,
    b: BezierPiece,
    depth: number
  ): CurvePoint | null => {
    const boxA = bezierBox(a);
    const boxB = bezierBox(b);
    if (
      boxA.maxX + tolerance < boxB.minX ||
      boxB.maxX + tolerance < boxA.minX ||
      boxA.maxY + tolerance < boxB.minY ||
      boxB.maxY + tolerance < boxA.minY
    ) {
      return null;
    }
    const flatA = bezierFlat(a, tolerance);
    const flatB = bezierFlat(b, tolerance);
    if ((flatA && flatB) || depth >= MAX_DEPTH) {
      return chordCrossing(a, b);
    }
    // Split the less flat piece (the longer one when both are curved).
    const splitA =
      !flatA &&
      (flatB ||
        Math.hypot(boxA.maxX - boxA.minX, boxA.maxY - boxA.minY) >=
          Math.hypot(boxB.maxX - boxB.minX, boxB.maxY - boxB.minY));
    if (splitA) {
      const [left, right] = splitBezier(a);
      return pair(left, b, depth + 1) ?? pair(right, b, depth + 1);
    }
    const [left, right] = splitBezier(b);
    return pair(a, left, depth + 1) ?? pair(a, right, depth + 1);
  };

  // A piece crosses itself only through two of its own sub-pieces, and
  // never when its control polygon turns through less than a half turn:
  // the curve turns no more than its polygon, and a curve that turns less
  // than π is simple.
  const self = (piece: BezierPiece, depth: number): CurvePoint | null => {
    if (
      bezierFlat(piece, tolerance) ||
      controlTurning(piece) < Math.PI ||
      depth >= MAX_DEPTH
    ) {
      return null;
    }
    const [left, right] = splitBezier(piece);
    return (
      self(left, depth + 1) ??
      self(right, depth + 1) ??
      pair(left, right, depth + 1)
    );
  };

  for (let i = 0; i < spans.length; i += 1) {
    const inner = self(spans[i]!, 0);
    if (inner) {
      return inner;
    }
    for (let j = i + 1; j < spans.length; j += 1) {
      const crossing = pair(spans[i]!, spans[j]!, 0);
      if (crossing) {
        return crossing;
      }
    }
  }
  return null;
}

const GAUSS_4 = [
  { x: -0.8611363115940526, w: 0.3478548451374538 },
  { x: -0.3399810435848563, w: 0.6521451548625461 },
  { x: 0.3399810435848563, w: 0.6521451548625461 },
  { x: 0.8611363115940526, w: 0.3478548451374538 }
] as const;

/**
 * `½∫ P × P' du` over `[a, b]` — the spline's Green's-theorem area term. The
 * integrand is a polynomial of degree `2·degree − 1 ≤ 5` on each knot span,
 * so four-point Gauss–Legendre per span is exact.
 */
export function splineAreaTerm(
  spline: SplineGeometry,
  a: number,
  b: number
): number {
  if (b === a) {
    return 0;
  }
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const breaks = splineBreakpoints(spline);
  let total = 0;
  const pieces = [
    low,
    ...breaks.filter((knot) => knot > low && knot < high),
    high
  ];
  for (let index = 0; index + 1 < pieces.length; index += 1) {
    const from = pieces[index]!;
    const to = pieces[index + 1]!;
    const half = (to - from) / 2;
    const mid = (to + from) / 2;
    for (const node of GAUSS_4) {
      const u = mid + half * node.x;
      const p = splinePoint(spline, u);
      const { d1 } = splineDerivatives(spline, u);
      total += node.w * half * (p.x * d1.y - p.y * d1.x);
    }
  }
  return (b > a ? total : -total) / 2;
}

function solveDense(matrix: number[][], rhs: CurvePoint[]): CurvePoint[] {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const bx = rhs.map((point) => point.x);
  const by = rhs.map((point) => point.y);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot]![column]!) < 1e-14) {
      throw new Error('These fit points do not define a spline.');
    }
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    [bx[column], bx[pivot]] = [bx[pivot]!, bx[column]!];
    [by[column], by[pivot]] = [by[pivot]!, by[column]!];
    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row]![column]! / a[column]![column]!;
      if (factor === 0) {
        continue;
      }
      for (let k = column; k < n; k += 1) {
        a[row]![k] = a[row]![k]! - factor * a[column]![k]!;
      }
      bx[row] = bx[row]! - factor * bx[column]!;
      by[row] = by[row]! - factor * by[column]!;
    }
  }
  const out: CurvePoint[] = Array.from({ length: n }, () => ({ x: 0, y: 0 }));
  for (let row = n - 1; row >= 0; row -= 1) {
    let x = bx[row]!;
    let y = by[row]!;
    for (let k = row + 1; k < n; k += 1) {
      x -= a[row]![k]! * out[k]!.x;
      y -= a[row]![k]! * out[k]!.y;
    }
    out[row] = { x: x / a[row]![row]!, y: y / a[row]![row]! };
  }
  return out;
}

/**
 * Refuses points that all sit on one spot (within the geometry tolerance of
 * their scale): every curve through or pulled by them is a point, which
 * region analysis would drop as degenerate along with every profile it
 * bounded. Checked where a spline is built, so the entity card refuses the
 * edit instead of applying it.
 */
function requireSpread(points: readonly CurvePoint[]): void {
  const first = points[0]!;
  let scale = 0;
  let spread = 0;
  for (const point of points) {
    scale = Math.max(scale, Math.abs(point.x), Math.abs(point.y));
    spread = Math.max(spread, Math.hypot(point.x - first.x, point.y - first.y));
  }
  if (!(spread > geometryTolerance(scale))) {
    throw new Error('A spline needs at least two distinct points.');
  }
}

/** Cumulative chord lengths normalized to [0, 1]; refuses repeated points. */
function chordParameters(
  points: readonly CurvePoint[],
  closed: boolean
): number[] {
  const count = closed ? points.length + 1 : points.length;
  const lengths: number[] = [0];
  for (let index = 1; index < count; index += 1) {
    const a = points[index - 1]!;
    const b = points[index % points.length]!;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(chord > 0)) {
      throw new Error(
        'A spline cannot pass through the same point twice in a row.'
      );
    }
    lengths.push(lengths[index - 1]! + chord);
  }
  const total = lengths[lengths.length - 1]!;
  return lengths.map((length) => length / total);
}

/**
 * A periodic B-spline over `t[0..n]` (`t[0] = 0`, `t[n] = 1`) with `n`
 * distinct control points, clamped at its seam. `controlFor(i)` is control
 * point `i mod n`.
 */
function clampedPeriodic(
  degree: number,
  breaks: readonly number[],
  controls: readonly CurvePoint[]
): SplineGeometry {
  const n = controls.length;
  const knotAt = (j: number): number => {
    const wraps = Math.floor(j / n);
    return breaks[j - wraps * n]! + wraps;
  };
  const knots: number[] = [];
  for (let i = 0; i <= n + 2 * degree; i += 1) {
    knots.push(knotAt(i - degree));
  }
  const wrapped: CurvePoint[] = [];
  for (let i = 0; i < n + degree; i += 1) {
    wrapped.push(controls[i % n]!);
  }
  const piece = subcurve(degree, knots, wrapped, 0, 1);
  return { degree, ...piece, closed: true };
}

function periodicBasisMatrix(
  degree: number,
  breaks: readonly number[],
  n: number
): number[][] {
  const knotAt = (j: number): number => {
    const wraps = Math.floor(j / n);
    return breaks[j - wraps * n]! + wraps;
  };
  const knots: number[] = [];
  for (let i = 0; i <= n + 2 * degree; i += 1) {
    knots.push(knotAt(i - degree));
  }
  const matrix = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let k = 0; k < n; k += 1) {
    const u = breaks[k]!;
    const span = k + degree;
    const basis = basisFunctions(span, u, degree, knots);
    for (let j = 0; j <= degree; j += 1) {
      const column = (span - degree + j) % n;
      matrix[k]![column] = matrix[k]![column]! + basis[j]!;
    }
  }
  return matrix;
}

/**
 * Global interpolation through `points`: cubic (or the highest degree the
 * point count allows), chord-length parameters, knots by averaging (the
 * standard construction), so the curve passes through every point exactly.
 * A closed fit is a periodic cubic with knots at the chord parameters.
 */
export function fitSplineThrough(
  points: readonly CurvePoint[],
  closed: boolean
): SplineGeometry {
  if (closed) {
    if (points.length < 3) {
      throw new Error('A closed fit spline needs at least 3 points.');
    }
    requireSpread(points);
    const breaks = chordParameters(points, true);
    const degree = 3;
    const matrix = periodicBasisMatrix(degree, breaks, points.length);
    const controls = solveDense(matrix, [...points]);
    return clampedPeriodic(degree, breaks, controls);
  }
  if (points.length < 3) {
    throw new Error('A fit spline needs at least 3 points.');
  }
  requireSpread(points);
  const degree = Math.min(3, points.length - 1);
  const params = chordParameters(points, false);
  const n = points.length - 1;
  const knots: number[] = Array<number>(degree + 1).fill(0);
  for (let j = 1; j <= n - degree; j += 1) {
    let sum = 0;
    for (let i = j; i < j + degree; i += 1) {
      sum += params[i]!;
    }
    knots.push(sum / degree);
  }
  knots.push(...Array<number>(degree + 1).fill(1));
  const matrix = params.map((u) => {
    const row = Array<number>(points.length).fill(0);
    const span = findSpan(degree, knots, u);
    const basis = basisFunctions(span, u, degree, knots);
    for (let j = 0; j <= degree; j += 1) {
      row[span - degree + j] = basis[j]!;
    }
    return row;
  });
  const controls = solveDense(matrix, [...points]);
  // Interpolation is exact at the ends by construction; pin them bit for bit
  // so a line drawn to a fit point meets the curve exactly.
  controls[0] = { ...points[0]! };
  controls[controls.length - 1] = { ...points[points.length - 1]! };
  return { degree, knots, controls, closed: false };
}

/**
 * The clamped uniform B-spline of `degree` over `points` as its control
 * polygon (degree lowered when there are too few points). A closed control
 * spline is the uniform periodic B-spline over the points.
 */
export function controlSpline(
  points: readonly CurvePoint[],
  requestedDegree: number,
  closed: boolean
): SplineGeometry {
  if (points.length < 3) {
    throw new Error('A control-point spline needs at least 3 points.');
  }
  requireSpread(points);
  if (closed) {
    const degree = Math.min(requestedDegree, points.length - 1);
    const n = points.length;
    const breaks = Array.from({ length: n + 1 }, (_, index) => index / n);
    return clampedPeriodic(degree, breaks, points);
  }
  const degree = Math.min(requestedDegree, points.length - 1);
  const spans = points.length - degree;
  const knots: number[] = Array<number>(degree + 1).fill(0);
  for (let index = 1; index < spans; index += 1) {
    knots.push(index / spans);
  }
  knots.push(...Array<number>(degree + 1).fill(1));
  return {
    degree,
    knots,
    controls: points.map((point) => ({ ...point })),
    closed: false
  };
}

/** The spline degrees a stored object may name. */
export function splineDegreeOf(
  data: Extract<SketchObjectData, { objectKind: 'spline' }>
): number {
  if (data.method === 'fit') {
    return 3;
  }
  return data.degree === 2 ? 2 : 3;
}

/** Resolves a `spline` object; throws on an unusable dimension or shape. */
export function resolveSplineGeometry(
  data: Extract<SketchObjectData, { objectKind: 'spline' }>,
  resolve: (value: ParamValue) => number
): SplineGeometry {
  if (
    !Array.isArray(data.points) ||
    data.points.length > MAX_SKETCH_SPLINE_POINTS
  ) {
    throw new Error(
      `A spline holds at most ${MAX_SKETCH_SPLINE_POINTS} points.`
    );
  }
  const points = data.points.map((point) => ({
    x: finite(resolve(point.x), 'Spline point'),
    y: finite(resolve(point.y), 'Spline point')
  }));
  const closed = data.closed === true;
  return data.method === 'fit'
    ? fitSplineThrough(points, closed)
    : controlSpline(points, splineDegreeOf(data), closed);
}

/** Polyline through a spline: `perSpan` samples per knot span. */
export function sampleSpline(
  spline: SplineGeometry,
  perSpan = 16,
  from?: number,
  to?: number
): CurvePoint[] {
  const [start, end] = splineDomain(spline);
  const low = from ?? start;
  const high = to ?? end;
  const breaks = splineBreakpoints(spline).filter(
    (knot) => knot > low && knot < high
  );
  const stops = [low, ...breaks, high];
  const points: CurvePoint[] = [splinePoint(spline, low)];
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const a = stops[index]!;
    const b = stops[index + 1]!;
    for (let step = 1; step <= perSpan; step += 1) {
      points.push(splinePoint(spline, a + ((b - a) * step) / perSpan));
    }
  }
  return points;
}

/** Polyline through an ellipse or elliptical arc. */
export function sampleEllipse(
  ellipse: EllipseGeometry,
  segmentsPerTurn = 64,
  from = 0,
  to = ellipse.sweep
): CurvePoint[] {
  const span = to - from;
  const steps = Math.max(
    2,
    Math.ceil((Math.abs(span) / TWO_PI) * segmentsPerTurn)
  );
  return Array.from({ length: steps + 1 }, (_, index) =>
    ellipsePoint(ellipse, ellipse.start + from + (span * index) / steps)
  );
}

/**
 * Polyline through any I01 curve object, or null for other kinds. The
 * sketch viewport draws these; profile fills come from region analysis.
 */
export function curveObjectPolyline(
  data: SketchObjectData,
  resolve: (value: ParamValue) => number
): CurvePoint[] | null {
  if (data.objectKind === 'ellipse') {
    return sampleEllipse(resolveEllipseGeometry(data, resolve));
  }
  if (data.objectKind === 'spline') {
    return sampleSpline(resolveSplineGeometry(data, resolve));
  }
  return null;
}
