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
