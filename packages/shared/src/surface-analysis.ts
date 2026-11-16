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

export type SurfaceAnalysisKind = 'draft';

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

export type SurfaceAnalysisRequest = DraftAnalysisRequest;

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
}

export interface SurfaceAnalysisReport {
  request: SurfaceAnalysisRequest;
  bodies: SurfaceAnalysisBody[];
  unsupported: SurfaceAnalysisUnsupported[];
  /** Bodies asked for that have no exact geometry (hidden, consumed, gone). */
  missing: string[];
}
