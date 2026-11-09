/**
 * Whether an approximate blend's patches agree with the seams between them.
 *
 * Every other acceptance rule on a fillet reads the result as a whole —
 * bounds, a volume envelope, relaxed validity, whether a band exists — and a
 * blend whose patches are trimmed by the wrong curves passes all of them.
 * Measured on the pinned kernel: the top rim of an r6 cylinder unioned onto a
 * box corner arrives as four quarter arcs, and filleting it at r >= 3 comes
 * back `ok`, `approximate`, valid and inside every envelope, but the four
 * NURBS patches meet along straight chords and the top face is a square. At
 * r3.8 each seam lies 1.11 off BOTH patches it joins (0.29r, the sag of a
 * quarter-circle chord), while the rim arcs those patches share with the
 * cylinder lie on them to 8e-5. The user sees a dome with a square top and
 * creases, shipped with only the generic approximation advisory.
 *
 * An edge lies on every face it bounds by definition, so the test needs no
 * model of what the blend ought to be: sample the edge and project the
 * samples onto each face's untrimmed surface. The trimmed
 * `pointToFaceDistance` cannot be used — a point on a face's own trim
 * boundary is at distance zero from the trimmed face however far it is from
 * the surface, so it reads every seam above as 0.
 *
 * Scope. Only edges whose every face is one of the blend's own approximate
 * (NURBS) faces are measured: the seams the kernel invented between two
 * fits, which no exact surface constrains. Two shapes are deliberately left
 * out:
 *
 * - Analytic faces are not projected onto. They are the kernel's closed-form
 *   result, and the pinned kernel's Newton projection is not reliable on
 *   them (it reports a cylinder wall's own rim tens of millimetres off).
 * - An edge between a NURBS corner patch and an exact face is not measured.
 *   On the pin, the accepted mixed-seam (r1) and union-junction (r5) corner
 *   fillets end their straight-edge cylinder band on a chord as well, 0.29r
 *   off the band and the patch. Refusing those would retract fillets that
 *   build today, which is a product decision rather than this guard's; the
 *   kernel fix for the chord boundaries covers them.
 *
 * A projection that throws or returns nothing finite is not evidence either
 * way, and is skipped.
 */
import type { RemusKernel } from './remus-runtime';
import { edgeToFaceMapOf } from './exact-sync-memo';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';

export interface BlendEdgeIncoherence {
  face: number;
  edge: number;
  /** Largest distance of a sampled edge point from the face's surface. */
  deviation: number;
}

/** Most points sampled on one edge; the cost is one projection each. */
const MAX_SAMPLES_PER_EDGE = 17;

/** Interior fractions a straight edge is sampled at. */
const LINE_FRACTIONS = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

/** Points on `edge`, interior ones included, at most {@link MAX_SAMPLES_PER_EDGE}. */
function edgeSamplePoints(kernel: RemusKernel, edge: number): number[][] {
  const polyline = kernel.sampleEdge(edge, MEASUREMENT_DEFLECTION);
  const points: number[][] = [];
  for (let at = 0; at + 2 < polyline.length; at += 3) {
    points.push([polyline[at]!, polyline[at + 1]!, polyline[at + 2]!]);
  }
  if (points.length < 2) return points;
  if (kernel.getEdgeCurveType(edge) === 'LINE') {
    // A line is sampled at its two ends only, and the ends are vertices the
    // neighbouring faces already agree on. Its interior is exact by
    // interpolation, and the interior is where a chord leaves a curve.
    const start = points[0]!;
    const end = points[points.length - 1]!;
    return LINE_FRACTIONS.map((t) =>
      start.map((value, axis) => value + (end[axis]! - value) * t)
    );
  }
  if (points.length <= MAX_SAMPLES_PER_EDGE) return points;
  const stride = (points.length - 1) / (MAX_SAMPLES_PER_EDGE - 1);
  return Array.from(
    { length: MAX_SAMPLES_PER_EDGE },
    (_, index) => points[Math.round(index * stride)]!
  );
}

/** Largest measurable distance of `points` from `face`'s untrimmed surface. */
function surfaceDeviation(
  kernel: RemusKernel,
  face: number,
  points: readonly number[][]
): number {
  let deviation = 0;
  for (const [x, y, z] of points) {
    let distance: number | undefined;
    try {
      distance = kernel.projectPointOnSurface(face, x!, y!, z!)[5];
    } catch {
      distance = undefined;
    }
    if (distance !== undefined && Number.isFinite(distance)) {
      deviation = Math.max(deviation, distance);
    }
  }
  return deviation;
}

/**
 * The first seam between two of `faces` (the approximate faces of `solid`)
 * that lies farther than `tolerance` from one of them, or `null` when every
 * measurable seam lies on both.
 */
export function incoherentBlendEdge(
  kernel: RemusKernel,
  solid: number,
  faces: readonly number[],
  tolerance: number
): BlendEdgeIncoherence | null {
  const present = new Set(kernel.getSolidFaces(solid));
  const approximate = new Set(
    faces.filter(
      (face) => present.has(face) && kernel.getSurfaceType(face) === 'bspline'
    )
  );
  if (approximate.size === 0) return null;
  const edgeFaces = edgeToFaceMapOf(kernel, solid);
  const measured = new Set<number>();
  for (const face of approximate) {
    for (const edge of kernel.getFaceEdges(face)) {
      if (measured.has(edge)) continue;
      measured.add(edge);
      const bounding = edgeFaces[String(edge)] ?? [face];
      if (!bounding.every((other) => approximate.has(other))) continue;
      let points: number[][];
      try {
        points = edgeSamplePoints(kernel, edge);
      } catch {
        continue;
      }
      for (const other of new Set(bounding)) {
        const deviation = surfaceDeviation(kernel, other, points);
        if (deviation > tolerance) {
          return { face: other, edge, deviation };
        }
      }
    }
  }
  return null;
}
