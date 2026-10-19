import {
  MAX_SKETCH_SPLINE_POINTS,
  type ParamValue,
  type SketchObjectData
} from '@openzcad/shared';

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

/** Counter-clockwise sweep from `start` to `end` in (0, 360] degrees. */
export function ellipticalArcSweepDegrees(start: number, end: number): number {
  const delta = end - start;
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 360) {
    throw new Error('Elliptical arc sweep must be non-zero and at most 360°.');
  }
  return delta < 0 ? delta + 360 : delta;
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

/** First and second derivative of a spline with respect to its parameter. */
export function splineDerivatives(
  spline: SplineGeometry,
  u: number
): { d1: CurvePoint; d2: CurvePoint } {
  let cached = derivativeCache.get(spline);
  if (!cached) {
    const first = derivativeCurve(spline.degree, spline.knots, spline.controls);
    const second = derivativeCurve(first.degree, first.knots, first.controls);
    cached = { first, second };
    derivativeCache.set(spline, cached);
  }
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
    const breaks = chordParameters(points, true);
    const degree = 3;
    const matrix = periodicBasisMatrix(degree, breaks, points.length);
    const controls = solveDense(matrix, [...points]);
    return clampedPeriodic(degree, breaks, controls);
  }
  if (points.length < 3) {
    throw new Error('A fit spline needs at least 3 points.');
  }
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
