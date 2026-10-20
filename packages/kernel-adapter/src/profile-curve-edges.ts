import {
  ellipseRegionSweep,
  splineBezierSegments,
  splineBreakpoints,
  splinePoint,
  splineSubcurve,
  type BezierRegionCurve,
  type EllipseRegionCurve,
  type PlaneBasis,
  type SplineRegionCurve
} from '@openzcad/geometry';
import type { RemusKernel } from './remus-runtime';
import {
  KERNEL_EXTRUDE_RECOGNITION_TOLERANCE,
  bezierNurbsParams,
  kernelReadsSamplesAsCircle,
  kernelSafeBezierPieces
} from './profile-bezier-edges';

/**
 * Exact profile edges for the I01 curve entities (schema v27).
 *
 * An ellipse piece becomes a true `Ellipse` edge and a spline piece a NURBS
 * edge carrying the knots and control points the geometry layer computed —
 * the kernel never re-fits a spline, so the face it builds is the region the
 * viewport filled. Both go through `liftCurve2dToPlane`, which derives the
 * plane's second axis as `normal × u`; callers check that basis first
 * (`basisMatchesLiftedFrame`).
 */

const ELLIPSE_CURVE_TYPE = 2;
const NURBS_CURVE_TYPE = 3;
const QUARTER = Math.PI / 2;
const TWO_PI = Math.PI * 2;

function lift(
  kernel: RemusKernel,
  basis: PlaneBasis,
  curveType: number,
  params: Float64Array,
  normalSign: 1 | -1,
  tStart: number,
  tEnd: number
): number {
  return kernel.liftCurve2dToPlane(
    curveType,
    params,
    basis.origin.x,
    basis.origin.y,
    basis.origin.z,
    basis.u.x,
    basis.u.y,
    basis.u.z,
    basis.normal.x * normalSign,
    basis.normal.y * normalSign,
    basis.normal.z * normalSign,
    tStart,
    tEnd
  );
}

/**
 * How one ellipse piece is built, in kernel-neutral terms. Shared with the
 * OCCT parity reference so both kernels cut the same pieces at the same
 * parameters and their vertices coincide.
 *
 * Kernels want the major radius first, so a taller-than-wide ellipse is
 * restated with the axes swapped (rotation + 90°, parameter − 90°). A
 * clockwise piece is built mirrored about the ellipse's own major axis
 * (`sign = −1`: the plane normal negated, so the parameter runs `t → −t`),
 * where it runs counter-clockwise: every trim then increases, which is the
 * orientation the kernel certifies, and the edge still travels the way the
 * loop does — the same reason a hole circle is built about the negated axis.
 *
 * Pieces are at most a quarter turn and never cross the 0/2π seam, as arcs
 * are, so no trim depends on how a kernel wraps a periodic range. A
 * counter-clockwise full ellipse stays one closed edge, which the pinned
 * Remus extrude passes through to one exact wall. A clockwise one (a hole
 * loop) is four quarter edges: that extrude passes only a closed *circle*
 * through as a hole and chord-splits any other closed edge into facets.
 */
export interface EllipseEdgePlan {
  major: number;
  minor: number;
  /** Radians from the sketch x axis to the major axis. */
  rotation: number;
  /** +1 counter-clockwise; −1 built about the negated normal. */
  sign: 1 | -1;
  /** Increasing parameter ranges in the (possibly mirrored) frame. */
  ranges: [number, number][];
  full: boolean;
}

export function ellipseEdgePlan(curve: EllipseRegionCurve): EllipseEdgePlan {
  let major = curve.radiusX;
  let minor = curve.radiusY;
  let rotation = curve.rotation;
  let shift = 0;
  if (curve.radiusY > curve.radiusX) {
    major = curve.radiusY;
    minor = curve.radiusX;
    rotation += QUARTER;
    shift = -QUARTER;
  }
  const sweep = ellipseRegionSweep(curve);
  const sign = curve.ccw ? 1 : -1;
  const span = Math.abs(sweep);
  if (Math.abs(span - TWO_PI) < 1e-9 && curve.ccw) {
    return { major, minor, rotation, sign, ranges: [[0, TWO_PI]], full: true };
  }
  const start = sign * (curve.startParam + shift);
  const begin = ((start % TWO_PI) + TWO_PI) % TWO_PI;
  const end = begin + span;
  const stops = [begin];
  const count = Math.max(1, Math.ceil(span / QUARTER));
  for (let index = 1; index < count; index += 1) {
    stops.push(begin + (span * index) / count);
  }
  if (end > TWO_PI + 1e-12) {
    stops.push(TWO_PI);
  }
  stops.sort((a, b) => a - b);
  stops.push(end);
  const ranges: [number, number][] = [];
  for (let index = 0; index + 1 < stops.length; index += 1) {
    let from = stops[index]!;
    let to = stops[index + 1]!;
    if (to - from < 1e-12) {
      continue;
    }
    if (from >= TWO_PI - 1e-12) {
      from -= TWO_PI;
      to -= TWO_PI;
    }
    ranges.push([Math.max(from, 0), to]);
  }
  return { major, minor, rotation, sign, ranges, full: false };
}

/** Edges tracing one ellipse piece in its loop's direction. */
export function ellipseRegionEdges(
  kernel: RemusKernel,
  basis: PlaneBasis,
  curve: EllipseRegionCurve
): number[] {
  const plan = ellipseEdgePlan(curve);
  // `liftCurve2dToPlane` derives the second axis as normal × u, so negating
  // the normal mirrors the sketch's y: the centre's y and the rotation flip
  // with it, which is the same mirror about the ellipse's own axis.
  const params = Float64Array.of(
    curve.center.x,
    plan.sign * curve.center.y,
    plan.major,
    plan.minor,
    plan.sign * plan.rotation
  );
  return plan.ranges.map(([from, to]) =>
    lift(kernel, basis, ELLIPSE_CURVE_TYPE, params, plan.sign, from, to)
  );
}

/** `curve_params` for a NURBS `liftCurve2dToPlane`, unit weights. */
export function splineNurbsParams(curve: SplineRegionCurve): Float64Array {
  const count = curve.controls.length;
  const params = new Float64Array(2 + curve.knots.length + 3 * count);
  let at = 0;
  params[at++] = curve.degree;
  params[at++] = count;
  for (const knot of curve.knots) {
    params[at++] = knot;
  }
  for (const point of curve.controls) {
    params[at++] = point.x;
    params[at++] = point.y;
  }
  for (let index = 0; index < count; index += 1) {
    params[at++] = 1;
  }
  return params;
}

/**
 * A spline piece as the curves its edges are built from. A whole closed
 * spline is cut into two exact halves: the pinned Remus extrude chord-splits
 * any closed single edge that is not a circle or ellipse into flat facets.
 * Shared with the OCCT parity reference for coinciding vertices.
 */
export function splineEdgePieces(
  curve: SplineRegionCurve
): SplineRegionCurve[] {
  const spline = {
    degree: curve.degree,
    knots: curve.knots,
    controls: curve.controls,
    closed: false
  };
  const start = curve.knots[0]!;
  const end = curve.knots[curve.knots.length - 1]!;
  const reach = Math.max(
    1,
    ...curve.controls.map((point) =>
      Math.max(Math.abs(point.x), Math.abs(point.y))
    )
  );
  if (
    Math.hypot(curve.a.x - curve.b.x, curve.a.y - curve.b.y) >
    reach * 1e-12
  ) {
    return [curve];
  }
  const breaks = splineBreakpoints(spline);
  const middle =
    breaks.length > 2
      ? breaks[Math.floor(breaks.length / 2)]!
      : (start + end) / 2;
  const halves = [
    splineSubcurve(spline, start, middle),
    splineSubcurve(spline, middle, end)
  ];
  // Joints by identity, ends on the loop's own point.
  halves[1]!.controls[0] = halves[0]!.controls.at(-1)!;
  halves[0]!.controls[0] = curve.a;
  halves[1]!.controls[halves[1]!.controls.length - 1] = curve.b;
  return halves.map((half) => ({
    ...curve,
    a: half.controls[0]!,
    b: half.controls.at(-1)!,
    knots: half.knots,
    controls: half.controls
  }));
}

/**
 * Edges tracing one spline piece: one NURBS edge per piece from
 * `splineEdgePieces`. When the pinned kernel's extrude would read an edge
 * as a circle (see `kernelReadsBezierAsCircle`) and build a cylinder wall
 * off its own cap edges, that piece goes in as its exact Bézier spans
 * instead, each split further where that kernel test still misfires.
 */
export function splineRegionEdges(
  kernel: RemusKernel,
  basis: PlaneBasis,
  curve: SplineRegionCurve
): number[] {
  return splineEdgePieces(curve).flatMap((piece) =>
    splinePieceEdges(kernel, basis, piece)
  );
}

function splinePieceEdges(
  kernel: RemusKernel,
  basis: PlaneBasis,
  curve: SplineRegionCurve
): number[] {
  const spline = {
    degree: curve.degree,
    knots: curve.knots,
    controls: curve.controls,
    closed: false
  };
  const start = curve.knots[0]!;
  const end = curve.knots[curve.knots.length - 1]!;
  const samples = Array.from({ length: 16 }, (_, index) =>
    splinePoint(spline, start + ((end - start) * index) / 15)
  );
  if (
    !kernelReadsSamplesAsCircle(samples, KERNEL_EXTRUDE_RECOGNITION_TOLERANCE)
  ) {
    return [
      lift(
        kernel,
        basis,
        NURBS_CURVE_TYPE,
        splineNurbsParams(curve),
        1,
        start,
        end
      )
    ];
  }
  const segments = splineBezierSegments(spline);
  // Joints by identity, ends on the loop's own points.
  segments[0]![0] = curve.a;
  segments.at(-1)![segments.at(-1)!.length - 1] = curve.b;
  for (let index = 1; index < segments.length; index += 1) {
    segments[index]![0] = segments[index - 1]!.at(-1)!;
  }
  const edges: number[] = [];
  for (const segment of segments) {
    if (segment.length < 3 || segment.length > 4) {
      throw new Error(
        `A spline of degree ${segment.length - 1} cannot be built exactly.`
      );
    }
    const bezier: BezierRegionCurve = {
      kind: 'bezier',
      a: segment[0]!,
      b: segment.at(-1)!,
      controls: segment.slice(
        1,
        -1
      ) as unknown as BezierRegionCurve['controls'],
      sourceObjectId: curve.sourceObjectId
    };
    for (const piece of kernelSafeBezierPieces(bezier)) {
      edges.push(
        lift(kernel, basis, NURBS_CURVE_TYPE, bezierNurbsParams(piece), 1, 0, 1)
      );
    }
  }
  return edges;
}
