import type {
  BezierRegionCurve,
  PlaneBasis,
  Vec2Like,
  Vec3
} from '@openzcad/geometry';

/**
 * Exact bezier profile edges, behind a feature flag that is **off by default**.
 *
 * Glyph outlines are quadratic (TrueType) or cubic (PostScript) beziers, and
 * the text fast path can hand them to the kernel as exact NURBS edges: a smooth
 * wall at any zoom and a faithful STEP export, where a flattened one produces a
 * visibly faceted stem. That is the better geometry, and it is not the default.
 *
 * The reason is a kernel defect, not a preference. An extruded glyph with
 * exact-NURBS walls comes back watertight, with the right face count, and
 * volume-correct to four decimals — and *misclassified*. Sweeping 109 points
 * through an extruded Open Sans 'o' at mid-height and comparing `classifyPoint`
 * against a winding-number ground truth computed from the same segments, 16 of
 * 109 are wrong: points outside the glyph report `inside`, points inside the
 * left wall report `outside`. The identical solid built with flattened walls
 * scores 0 of 109. brepkit tracks this as the `#[ignore]` ready-repro
 * `o_glyph_bezier_cap_band_is_misclassified`.
 *
 * Classification is what booleans stand on, so emboss and engrave — the whole
 * point of text on a model — are unreliable on curved letters through the exact
 * path. Faceted-but-correct beats smooth-but-wrong, so flattening is the
 * default until that repro passes.
 *
 * Turn the exact path back on with `setBezierProfileEdges(true)`, or
 * `globalThis.openzcadBezierProfileEdges = true` before this module loads. It
 * is the right default again the moment the kernel defect is fixed; flipping
 * `DEFAULT_EXACT_BEZIER_EDGES` is the whole change.
 */

/**
 * Whether beziers reach the kernel exact. `false` until
 * `o_glyph_bezier_cap_band_is_misclassified` passes — see the module note.
 */
export const DEFAULT_EXACT_BEZIER_EDGES = false;

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
  return override === undefined ? DEFAULT_EXACT_BEZIER_EDGES : override === true;
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
