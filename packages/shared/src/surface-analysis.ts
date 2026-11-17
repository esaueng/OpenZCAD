import type { Vector3 } from './index';

/**
 * M09 analysis overlays: what the exact kernel reports about a body's faces,
 * as data the viewport colours. One query (`exact-surface-analysis.ts` in the
 * kernel adapter) answers every kind on the same worker path the M09 clash
 * query runs on; nothing here is computed from the display mesh.
 *
 * Every overlay is sampled: the kernel evaluates its exact surface at sample
 * points (the vertices of a per-face tessellation, projected back onto the
 * exact surface), and the viewport interpolates colour between them. A value
 * AT a sample is exact; a face's range is the range over its samples, and is
 * exact only where the face's value cannot vary (a plane's draft). Each face
 * summary says which.
 *
 * Analysis is view state: it is never saved and never changes the document.
 * Lengths are in model units, angles in degrees.
 */

export type SurfaceAnalysisKind = 'draft' | 'curvature' | 'zebra' | 'thickness';

/**
 * Draft against a pull direction: the signed angle between each face and
 * the pull, positive where the face opens toward the pull (it releases),
 * negative where it faces away (an undercut on that side of the parting
 * line). Faces whose draft lies within ±`minimumDegrees` cannot release
 * cleanly and are reported as insufficient.
 */
export interface DraftAnalysisRequest {
  kind: 'draft';
  /** The pull (mould opening) direction; need not be unit length. */
  pull: Vector3;
  /** The smallest acceptable draft, in degrees (≥ 0). */
  minimumDegrees: number;
}

/**
 * Which curvature a curvature map shows, from the kernel's principal
 * curvatures k1 ≥ k2 at each sample (1/length, positive where the surface
 * is convex toward its outward normal):
 * - `gaussian`: k1·k2 (1/length²), orientation-independent; zero on
 *   developable faces (planes, cylinders, cones);
 * - `mean`: (k1 + k2)/2, signed: convex positive, concave (a bore, a
 *   fillet in a pocket) negative;
 * - `maximum`: max(|k1|, |k2|), the reciprocal of the tightest local
 *   radius.
 */
export type CurvatureMeasure = 'gaussian' | 'mean' | 'maximum';

export interface CurvatureAnalysisRequest {
  kind: 'curvature';
  measure: CurvatureMeasure;
}

/**
 * Zebra stripes: the exact outward normal at each sample, which the
 * viewport reflects into stripes that move with the view. Values are not
 * measured (every value is 0, NaN where the sample was not evaluated).
 */
export interface ZebraAnalysisRequest {
  kind: 'zebra';
  /** Stripe pairs across the reflected half-sphere (2–40). */
  stripes: number;
}

/**
 * Wall thickness by the ray method: from the centre of each sample triangle
 * on the surface, the distance through the material along the inward
 * normal to the far wall. Every figure is approximate (sampled, and found
 * to within the body's stated resolution) except a planar wall whose every
 * sample reaches a parallel opposing plane, which is that exact separation.
 * Thin walls are what 3D printing and moulding check; the minimum only
 * recolours.
 */
export interface ThicknessAnalysisRequest {
  kind: 'thickness';
  /** The thinnest acceptable wall, in model units (> 0). */
  minimum: number;
}

export type SurfaceAnalysisRequest =
  | DraftAnalysisRequest
  | CurvatureAnalysisRequest
  | ZebraAnalysisRequest
  | ThicknessAnalysisRequest;

/**
 * A draft this close to zero (degrees) is zero: a vertical wall evaluates to
 * ±1e-14, and a minimum of 0° must still report it as insufficient.
 */
export const DRAFT_ZERO_DEGREES = 1e-6;

/** The band one draft value falls in against a minimum (degrees). */
export function draftBand(
  value: number,
  minimumDegrees: number
): 'positive' | 'negative' | 'insufficient' {
  if (
    Math.abs(value) <= DRAFT_ZERO_DEGREES ||
    Math.abs(value) < minimumDegrees
  ) {
    return 'insufficient';
  }
  return value > 0 ? 'positive' : 'negative';
}

/**
 * How a face whose draft spans [min, max] reads against the minimum. The
 * bands are ordered (negative, insufficient, positive), so a range whose two
 * ends share a band lies wholly inside it.
 */
export function draftVerdict(
  min: number,
  max: number,
  minimumDegrees: number
): DraftFaceVerdict {
  const low = draftBand(min, minimumDegrees);
  const high = draftBand(max, minimumDegrees);
  return low === high ? low : 'mixed';
}

/** How a face reads against a draft requirement. */
export type DraftFaceVerdict =
  /** Every sample drafts at least the minimum toward the pull. */
  | 'positive'
  /** Every sample drafts at least the minimum away from the pull. */
  | 'negative'
  /** Every sample lies within ±minimum: too steep to release. */
  | 'insufficient'
  /** Samples fall in more than one band: the face needs splitting. */
  | 'mixed';

/**
 * The surface carrying a face, as the kernel names it (`plane`, `cylinder`,
 * `cone`, `sphere`, `torus`, `bspline`, …).
 */
export type SurfaceAnalysisSurface = string;

export interface SurfaceAnalysisFace {
  /** The face's index in its body's face order (the display mesh's). */
  face: number;
  surface: SurfaceAnalysisSurface;
  /** Smallest and largest value over the face's samples. */
  min: number;
  max: number;
  samples: number;
  /**
   * True when `min`/`max` are the face's exact extremes, not just the
   * extremes of its samples (a plane's draft is one exact value).
   */
  exact: boolean;
  /**
   * Curvature only: the face's smallest radius of curvature over its whole
   * trimmed domain, from the kernel's `getFaceMinRadius` (null for a plane,
   * which has none). `minRadiusExact` is true for the analytic surfaces,
   * where the kernel computes it in closed form, and false for NURBS, where
   * it refines a grid search.
   */
  minRadius?: number | null;
  minRadiusExact?: boolean;
  /**
   * Thickness only: where the face's thinnest sample is (the triangle
   * centre it was measured from), in model coordinates.
   */
  thinnestAt?: Vector3;
}

/**
 * Something the query could not answer, never shown as a value. `face` is
 * null when a whole body was refused.
 */
export interface SurfaceAnalysisUnsupported {
  bodyId: string;
  face: number | null;
  /** A short machine code: `kernel-refused`, `too-many-samples`, … */
  reason: string;
  /** The plain reason, as the kernel or the query gave it. */
  message: string;
}

/**
 * One body's overlay: a mesh in the body's own model coordinates, one value
 * per vertex (NaN where the kernel could not evaluate it, drawn neutral) and
 * the exact outward surface normal at each vertex.
 */
export interface SurfaceAnalysisBody {
  bodyId: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  values: Float32Array;
  faces: SurfaceAnalysisFace[];
  /**
   * Thickness only: the length to which each ray-method sample is resolved
   * (its error bound against the exact solid along that ray).
   */
  resolution?: number;
}

export interface SurfaceAnalysisReport {
  request: SurfaceAnalysisRequest;
  bodies: SurfaceAnalysisBody[];
  unsupported: SurfaceAnalysisUnsupported[];
  /** Bodies asked for that have no exact geometry (hidden, consumed, gone). */
  missing: string[];
}
