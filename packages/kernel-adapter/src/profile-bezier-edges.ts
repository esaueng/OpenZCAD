import type {
  BezierRegionCurve,
  PlaneBasis,
  Vec2Like,
  Vec3
} from '@openzcad/geometry';

/**
 * Exact bezier profile edges, on by default.
 *
 * Glyph outlines are quadratic (TrueType) or cubic (PostScript) beziers, and
 * the text fast path hands them to the kernel as exact NURBS edges. That is
 * the difference between a smooth wall and a visibly faceted one: an Open Sans
 * 'o' is 25 walls exact and 409 flattened, and every one of those 409 is a
 * separate face the viewer outlines, so a flattened letter reads as striped
 * rather than round. It also decides whether STEP export carries curves.
 *
 * This was briefly defaulted off, and the reasoning was wrong in an
 * instructive way. An extruded glyph with exact walls *is* misclassified in
 * the middle of its bezier cap band — 16 of 109 probe points through an
 * extruded 'o' disagree with a winding-number ground truth, where flattened
 * walls score 0 of 109, and remus tracks that as the `#[ignore]` repro
 * `o_glyph_bezier_cap_band_is_misclassified`. From "booleans stand on
 * classification" it seemed to follow that emboss and engrave were unreliable
 * on curved letters. That inference was not tested, and it is false.
 *
 * Emboss and engrave contact the slab on a *flat* face; the misclassified
 * band is nowhere near the intersection the boolean has to resolve. Measured
 * directly in `text-kernel-build.test.ts`, a 'Bo' — counters and curved stems
 * — unions and subtracts against a slab through both wall modes and lands
 * watertight, non-manifold-free, and within 1e-4 of the closed-form volume
 * either way. A boolean that had consulted a lying classifier would not hit
 * that number by luck.
 *
 * So the defect is real, still open, and does not reach the flows this
 * feature exists for. What it does still affect is direct `classifyPoint`
 * queries deep inside a curved glyph wall. If that starts to matter, the fix
 * is the kernel repro, not this flag.
 *
 * `setBezierProfileEdges(false)` selects flattening for a caller that needs
 * it, and `globalThis.openzcadBezierProfileEdges = false` does it for a
 * deployment before this module loads.
 */

/**
 * Whether beziers reach the kernel exact. Kept as a named constant because
 * tests pin it: the default is a decision backed by the curved-glyph boolean
 * measurement above, not an incidental value.
 */
export const DEFAULT_EXACT_BEZIER_EDGES = true;

/** Chord deviation the fallback polyline may keep, as a fraction of extent. */
const FALLBACK_CHORD_RATIO = 1 / 2000;
/** Ceiling on the fallback's segment count for one bezier. */
const MAX_FALLBACK_SEGMENTS = 64;
/**
 * How far `v` may drift from `normal × u` before a lifted bezier and a
 * JS-computed line endpoint would disagree about where the plane's second
 * axis points. Well above float noise, far below anything that would mirror
 * or rotate the text.
 */
const BASIS_HANDEDNESS_TOLERANCE = 1e-9;

/**
 * Global override read once at module load, so a deployment can select the
 * exact path without a code change:
 * `globalThis.openzcadBezierProfileEdges = true`.
 */
function initialFlag(): boolean {
  const override = (globalThis as Record<string, unknown>)
    .openzcadBezierProfileEdges;
  return override === undefined
    ? DEFAULT_EXACT_BEZIER_EDGES
    : override === true;
}

let bezierProfileEdges = initialFlag();

/** True when profile beziers reach the kernel as exact NURBS edges. */
export function bezierProfileEdgesEnabled(): boolean {
  return bezierProfileEdges;
}

/** Flip the exact-bezier path. `false` selects the flattening fallback. */
export function setBezierProfileEdges(enabled: boolean): void {
  bezierProfileEdges = enabled;
}

/**
 * `liftCurve2dToPlane` derives the plane's second axis as `normal × x_axis`.
 * Every basis this app produces is right-handed (`u × v = normal`), so that
 * matches `v` — but a face-attached frame is measured, not constructed, and a
 * frame that ever drifted would silently mirror the text about its baseline
 * rather than fail. Checking is two cross products.
 */
export function basisMatchesLiftedFrame(basis: PlaneBasis): boolean {
  const derived: Vec3 = {
    x: basis.normal.y * basis.u.z - basis.normal.z * basis.u.y,
    y: basis.normal.z * basis.u.x - basis.normal.x * basis.u.z,
    z: basis.normal.x * basis.u.y - basis.normal.y * basis.u.x
  };
  return (
    Math.abs(derived.x - basis.v.x) <= BASIS_HANDEDNESS_TOLERANCE &&
    Math.abs(derived.y - basis.v.y) <= BASIS_HANDEDNESS_TOLERANCE &&
    Math.abs(derived.z - basis.v.z) <= BASIS_HANDEDNESS_TOLERANCE
  );
}

/**
 * `curve_params` for `liftCurve2dToPlane(curveType = 3)`:
 * `[degree, n_cp, ...knots (n_cp + degree + 1), ...xy pairs (2 · n_cp),
 * ...weights (n_cp)]`. A bezier is a NURBS with a clamped knot vector that
 * has no interior knots — `[0,0,0,1,1,1]` for a quadratic,
 * `[0,0,0,0,1,1,1,1]` for a cubic — and unit weights, which is what makes it
 * non-rational.
 */
export function bezierNurbsParams(curve: BezierRegionCurve): Float64Array {
  const points: Vec2Like[] = [curve.a, ...curve.controls, curve.b];
  const count = points.length;
  const degree = count - 1;
  if (degree < 2 || degree > 3) {
    throw new Error(
      `A profile bezier must be quadratic or cubic; received degree ${degree}.`
    );
  }
  const params = new Float64Array(2 + 2 * count + 2 * count + count);
  let at = 0;
  params[at++] = degree;
  params[at++] = count;
  for (let index = 0; index < count; index += 1) {
    params[at++] = 0;
  }
  for (let index = 0; index < count; index += 1) {
    params[at++] = 1;
  }
  for (const point of points) {
    params[at++] = point.x;
    params[at++] = point.y;
  }
  for (let index = 0; index < count; index += 1) {
    params[at++] = 1;
  }
  return params;
}

function bezierPointAt(points: readonly Vec2Like[], t: number): Vec2Like {
  const u = 1 - t;
  if (points.length === 3) {
    const [p0, p1, p2] = points as [Vec2Like, Vec2Like, Vec2Like];
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
    };
  }
  const [p0, p1, p2, p3] = points as [Vec2Like, Vec2Like, Vec2Like, Vec2Like];
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y
  };
}

/**
 * The fallback polyline for one bezier, as ordered 2D points.
 *
 * The first and last entries are the curve's own endpoint objects, never
 * re-evaluations of the polynomial at t = 0 and t = 1: a neighbouring line or
 * bezier shares those same objects, and `makeWire` welds at 1e-7, so a
 * recomputed endpoint is how a wire fails to close.
 */
export function flattenBezierCurve(curve: BezierRegionCurve): Vec2Like[] {
  const points: Vec2Like[] = [curve.a, ...curve.controls, curve.b];
  const dx = curve.b.x - curve.a.x;
  const dy = curve.b.y - curve.a.y;
  const chord = Math.hypot(dx, dy);
  let deviation = 0;
  let extent = 0;
  for (const control of curve.controls) {
    deviation = Math.max(
      deviation,
      chord > 0
        ? Math.abs(
            (control.x - curve.a.x) * dy - (control.y - curve.a.y) * dx
          ) / chord
        : Math.hypot(control.x - curve.a.x, control.y - curve.a.y)
    );
  }
  for (const point of points) {
    extent = Math.max(
      extent,
      Math.hypot(point.x - curve.a.x, point.y - curve.a.y)
    );
  }
  // Chord error of an n-piece subdivision falls off as 1/n².
  const target =
    extent > 0 ? Math.sqrt(deviation / (FALLBACK_CHORD_RATIO * extent)) : 1;
  const steps = Math.min(
    MAX_FALLBACK_SEGMENTS,
    Math.max(1, Math.ceil(Number.isFinite(target) ? target : 1))
  );
  const out: Vec2Like[] = [curve.a];
  for (let index = 1; index < steps; index += 1) {
    out.push(bezierPointAt(points, index / steps));
  }
  out.push(curve.b);
  return out;
}

/**
 * Reported when the exact path was *asked for* and could not be delivered.
 *
 * Flattening is the default (see the module note), and warning about the
 * default on every rebuild would be noise on the normal path — the kind of
 * warning users learn to scroll past, which costs the signal when something
 * genuinely goes wrong. So this fires only for the anomaly: the caller enabled
 * exact beziers and the geometry refused them anyway. Callers pass the reason.
 */
export function bezierFallbackWarning(reason: string, count: number): string {
  return (
    `${count} bezier profile edge${count === 1 ? '' : 's'} were flattened to ` +
    `line segments instead of exact NURBS edges (${reason}). Curved outlines ` +
    'will look faceted and export faceted.'
  );
}

/**
 * The other, far more common way a curved profile arrives flattened.
 *
 * Real fonts draw glyphs as overlapping strokes inside one self-intersecting
 * contour and let the nonzero fill rule sort it out at paint time. A B-Rep
 * face cannot: those contours have to be resolved by a polygon union, which
 * works on polylines and hands back polylines. The result is indistinguishable
 * from an authored polygon by the time it reaches the kernel, so the geometry
 * layer flags it (`SketchProfile.outline.fidelity`) and this reports it.
 *
 * It is font-dependent, not text-dependent, which is why the message names the
 * way out: Open Sans, Lora and Oswald have no self-overlapping ASCII glyph.
 */
export function flattenedOutlineWarning(count: number): string {
  return (
    `${count} text region${count === 1 ? '' : 's'} reached the kernel as ` +
    "polylines rather than the font's own curves, because their glyph " +
    'outlines overlap and had to be resolved by a polygon union. Those walls ' +
    'will look faceted and export faceted. Open Sans, Lora and Oswald have no ' +
    'self-overlapping ASCII glyph and stay exact.'
  );
}

/**
 * The tolerance at which the pinned kernel's extrude reads a NURBS profile
 * edge as an analytic curve: `Tolerance::new().linear × 100`, absolute in
 * model units (remus `crates/operations/src/extrude.rs`, side-face
 * construction).
 */
export const KERNEL_EXTRUDE_RECOGNITION_TOLERANCE = 1e-5;

/** Samples the kernel's `recognize_curve` takes, uniformly in parameter. */
const RECOGNITION_SAMPLES = 16;

/**
 * Whether the pinned kernel's extrude will build this bezier's side wall as a
 * cylinder.
 *
 * remus `extrude` recognizes each NURBS profile edge with
 * `recognize_curve(nc, 1e-5)` before it builds that edge's side face, and
 * takes a `Circle` verdict as licence for a `Cylinder` wall — without the
 * exact-circle check (`nurbs_is_quadratic_circle`) that its own cap-edge pass
 * applies. A nearly straight polynomial bezier fits some huge circle to
 * 1e-5, so its wall becomes, say, a 302 mm cylinder that leaves the bezier
 * cap edges it is bounded by by up to 10 µm, and the exact boolean refuses
 * any cut, union or intersect that has to trim that wall. Open Sans's 'b' at
 * em 10 is the first glyph found doing it, and about 2 % of all glyph
 * segments across the bundled fonts do at some size.
 *
 * This replays the kernel's own test — sixteen samples, a line check, then
 * the algebraic circle fit — so the adapter can decline to hand the kernel an
 * edge it will misread. It was checked against the kernel's verdict on every
 * bezier of every bundled ASCII glyph at six sizes (57 147 segments, zero
 * disagreements). A line verdict wins over a circle one, exactly as in the
 * kernel, and leaves a ruled B-spline wall.
 *
 * 2D is enough: the kernel samples the lifted 3D curve, and lifting into a
 * plane is an isometry.
 */
export function kernelReadsBezierAsCircle(
  points: readonly Vec2Like[],
  tolerance = KERNEL_EXTRUDE_RECOGNITION_TOLERANCE
): boolean {
  if (points.length < 3) return false;
  const samples = Array.from({ length: RECOGNITION_SAMPLES }, (_, index) =>
    bezierPointAt(points, index / (RECOGNITION_SAMPLES - 1))
  );
  if (recognizedAsLine(samples, tolerance)) return false;
  const first = samples[0]!;
  // The kernel needs one sample triple spanning a plane before it fits.
  let spansPlane = false;
  search: for (let i = 1; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const cross =
        (samples[i]!.x - first.x) * (samples[j]!.y - first.y) -
        (samples[i]!.y - first.y) * (samples[j]!.x - first.x);
      if (Math.abs(cross) > tolerance) {
        spansPlane = true;
        break search;
      }
    }
  }
  if (!spansPlane) return false;
  const ux0 = samples[1]!.x - first.x;
  const uy0 = samples[1]!.y - first.y;
  const uLength = Math.hypot(ux0, uy0);
  if (uLength < 1e-15) return false;
  const ux = ux0 / uLength;
  const uy = uy0 / uLength;
  const local = samples.map((sample) => {
    const dx = sample.x - first.x;
    const dy = sample.y - first.y;
    return { x: dx * ux + dy * uy, y: dx * -uy + dy * ux };
  });
  // Least squares over each sample against the first, which eliminates r².
  const origin = local[0]!;
  const originSquared = origin.x * origin.x + origin.y * origin.y;
  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b0 = 0;
  let b1 = 0;
  for (const point of local.slice(1)) {
    const r0 = 2 * (point.x - origin.x);
    const r1 = 2 * (point.y - origin.y);
    const rhs = point.x * point.x + point.y * point.y - originSquared;
    a00 += r0 * r0;
    a01 += r0 * r1;
    a11 += r1 * r1;
    b0 += r0 * rhs;
    b1 += r1 * rhs;
  }
  const determinant = a00 * a11 - a01 * a01;
  if (Math.abs(determinant) < 1e-30) return false;
  const cx = (b0 * a11 - b1 * a01) / determinant;
  const cy = (a00 * b1 - a01 * b0) / determinant;
  const radii = local.map((point) => Math.hypot(point.x - cx, point.y - cy));
  const mean =
    radii.reduce((total, radius) => total + radius, 0) / radii.length;
  if (mean < tolerance) return false;
  return radii.every((radius) => Math.abs(radius - mean) <= tolerance);
}

function recognizedAsLine(
  samples: readonly Vec2Like[],
  tolerance: number
): boolean {
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const length = Math.hypot(last.x - first.x, last.y - first.y);
  if (length < 1e-15) return false;
  const dx = (last.x - first.x) / length;
  const dy = (last.y - first.y) / length;
  return samples.every(
    (sample) =>
      Math.abs((sample.x - first.x) * dy - (sample.y - first.y) * dx) <=
      tolerance
  );
}

/** Ceiling on the pieces one bezier is split into for the kernel. */
const MAX_KERNEL_SAFE_PIECES = 64;

/** de Casteljau split of a bezier's control points at `t`. */
function splitControlPoints(
  points: readonly Vec2Like[],
  t: number
): [Vec2Like[], Vec2Like[]] {
  const left: Vec2Like[] = [];
  const right: Vec2Like[] = [];
  let row: readonly Vec2Like[] = points;
  while (row.length > 0) {
    left.push(row[0]!);
    right.unshift(row.at(-1)!);
    const next: Vec2Like[] = [];
    for (let index = 0; index + 1 < row.length; index += 1) {
      next.push({
        x: row[index]!.x + (row[index + 1]!.x - row[index]!.x) * t,
        y: row[index]!.y + (row[index + 1]!.y - row[index]!.y) * t
      });
    }
    row = next;
  }
  return [left, right];
}

/**
 * The bezier as the kernel can extrude it: itself, or — when the pinned
 * kernel would misread it as a circle ({@link kernelReadsBezierAsCircle}) —
 * the same curve split by de Casteljau into the fewest equal-parameter pieces
 * that the kernel reads as lines.
 *
 * The split is exact: the pieces trace the original polynomial, so the walls
 * and caps keep the font's own curve and the volume is unchanged. A piece the
 * kernel reads as a line still gets a ruled B-spline wall (its cap-edge pass
 * only straightens a NURBS whose control polygon is itself straight to
 * 1e-7), so caps and walls agree, which is all the exact boolean needs. Each
 * piece must pass the line test at half the kernel's tolerance, a margin for
 * the kernel sampling the lifted 3D curve rather than these 2D points.
 *
 * Measured over every bundled font, sizes 5, 10 and 20, A–Z, a–z and 0–9:
 * of the 201 glyph regions with a misread segment, 200 refused an exact cut
 * through a slab face as built, and all 201 cut exactly once split; the 1002
 * regions without one cut exactly either way. Only flagged segments are split,
 * so every other wall keeps the "one glyph segment, one wall" structure.
 *
 * Endpoints are the curve's own point objects and the pieces share their
 * joints by identity, which keeps `makeWire`'s 1e-7 weld bit-exact.
 */
export function kernelSafeBezierPieces(
  curve: BezierRegionCurve
): BezierRegionCurve[] {
  const points = [curve.a, ...curve.controls, curve.b];
  if (!kernelReadsBezierAsCircle(points)) return [curve];
  const lineTolerance = KERNEL_EXTRUDE_RECOGNITION_TOLERANCE / 2;
  for (let count = 2; count <= MAX_KERNEL_SAFE_PIECES; count += 1) {
    const pieces: Vec2Like[][] = [];
    let rest: readonly Vec2Like[] = points;
    for (let index = 0; index < count - 1; index += 1) {
      const [left, right] = splitControlPoints(rest, 1 / (count - index));
      pieces.push(left);
      rest = right;
    }
    pieces.push([...rest]);
    // Share joints by identity, and keep the curve's own endpoint objects.
    pieces[0]![0] = curve.a;
    pieces.at(-1)![pieces.at(-1)!.length - 1] = curve.b;
    for (let index = 1; index < pieces.length; index += 1) {
      pieces[index]![0] = pieces[index - 1]!.at(-1)!;
    }
    const straight = pieces.every((piece) => {
      const samples = Array.from({ length: RECOGNITION_SAMPLES }, (_, at) =>
        bezierPointAt(piece, at / (RECOGNITION_SAMPLES - 1))
      );
      return recognizedAsLine(samples, lineTolerance);
    });
    if (!straight) continue;
    return pieces.map((piece) => ({
      ...curve,
      a: piece[0]!,
      b: piece.at(-1)!,
      controls: piece.slice(1, -1) as unknown as BezierRegionCurve['controls']
    }));
  }
  return [curve];
}
