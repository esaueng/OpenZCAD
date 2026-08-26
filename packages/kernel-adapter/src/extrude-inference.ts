import type { BodyId, ExtrudeOperation } from '@openzcad/shared';

export interface ExtrudeInferenceBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface ExtrudeInferenceBody {
  bodyId: BodyId;
  name: string;
  volume: number;
  bbox: ExtrudeInferenceBounds;
}

export interface ExtrudeUnionMeasurement {
  target: ExtrudeInferenceBody;
  /** Exact volume of target union extrusion. */
  unionVolume: number;
}

export type ExtrudeInferenceReason =
  | 'no-live-body'
  | 'no-overlap'
  | 'partial-overlap'
  | 'enclosed'
  | 'coincident'
  | 'multiple-overlap'
  | 'exact-measurement-refused'
  // Direction override for a face-attached sketch whose drag went into the
  // face's own body: the gesture means cut even where volume reads "add".
  | 'into-face-body';

export interface ExtrudeOperationInference {
  operation: ExtrudeOperation;
  targetBodyId?: BodyId;
  targetBodyName?: string;
  reason: ExtrudeInferenceReason;
  sharedVolume?: number;
  tolerance: number;
}

const RELATIVE_VOLUME_TOLERANCE = 1e-6;
const BOUNDS_VOLUME_TOLERANCE = 1e-9;
const ABSOLUTE_LINEAR_TOLERANCE = 1e-9;

function boundsDiagonal(bounds: ExtrudeInferenceBounds): number {
  return Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
}

/** Scale-aware volume tolerance shared by preview inference and exact replay. */
export function extrudeVolumeTolerance(
  left: Pick<ExtrudeInferenceBody, 'volume' | 'bbox'>,
  right: Pick<ExtrudeInferenceBody, 'volume' | 'bbox'>
): number {
  const diagonal = Math.max(
    boundsDiagonal(left.bbox),
    boundsDiagonal(right.bbox),
    ABSOLUTE_LINEAR_TOLERANCE
  );
  return Math.max(
    diagonal ** 3 * BOUNDS_VOLUME_TOLERANCE,
    Math.abs(left.volume) * RELATIVE_VOLUME_TOLERANCE,
    Math.abs(right.volume) * RELATIVE_VOLUME_TOLERANCE
  );
}

/**
 * A positive-volume overlap needs a positive span on every axis. Near-zero
 * spans are tangency, not material, and stay a new-body extrusion.
 */
export function extrudeBoundsCanShareVolume(
  left: ExtrudeInferenceBounds,
  right: ExtrudeInferenceBounds
): boolean {
  const diagonal = Math.max(
    boundsDiagonal(left),
    boundsDiagonal(right),
    ABSOLUTE_LINEAR_TOLERANCE
  );
  const tolerance = Math.max(
    ABSOLUTE_LINEAR_TOLERANCE,
    diagonal * ABSOLUTE_LINEAR_TOLERANCE
  );
  return (['x', 'y', 'z'] as const).every(
    (axis) =>
      Math.min(left.max[axis], right.max[axis]) -
        Math.max(left.min[axis], right.min[axis]) >
      tolerance
  );
}

/**
 * Classify exact union measurements without using float equality.
 *
 * One partially overlapping live body means Add. An extrusion wholly inside
 * one larger body means Cut. Tangency/no overlap stays New Body. Multiple
 * overlaps, coincident solids, or any refused exact measurement also stay New
 * Body because silently choosing which existing body to consume is unsafe.
 */
export function classifyExtrudeOperation(
  extrusion: ExtrudeInferenceBody,
  measurements: ExtrudeUnionMeasurement[],
  unresolvedTargets: ExtrudeInferenceBody[] = [],
  liveBodyCount = measurements.length + unresolvedTargets.length
): ExtrudeOperationInference {
  const defaultTolerance = Math.max(
    boundsDiagonal(extrusion.bbox) ** 3 * BOUNDS_VOLUME_TOLERANCE,
    Math.abs(extrusion.volume) * RELATIVE_VOLUME_TOLERANCE
  );
  if (unresolvedTargets.length > 0) {
    return {
      operation: 'new-body',
      reason: 'exact-measurement-refused',
      tolerance: defaultTolerance
    };
  }

  let invalidMeasurement = false;
  const overlaps = measurements.flatMap((measurement) => {
    const tolerance = extrudeVolumeTolerance(extrusion, measurement.target);
    const rawShared =
      extrusion.volume + measurement.target.volume - measurement.unionVolume;
    const maximum = Math.min(extrusion.volume, measurement.target.volume);
    if (
      !Number.isFinite(rawShared) ||
      rawShared < -tolerance ||
      rawShared > maximum + tolerance
    ) {
      invalidMeasurement = true;
      return [];
    }
    const sharedVolume = Math.max(0, Math.min(maximum, rawShared));
    return sharedVolume > tolerance
      ? [{ ...measurement, sharedVolume, tolerance }]
      : [];
  });

  if (invalidMeasurement) {
    return {
      operation: 'new-body',
      reason: 'exact-measurement-refused',
      tolerance: defaultTolerance
    };
  }

  if (overlaps.length === 0) {
    return {
      operation: 'new-body',
      reason: liveBodyCount === 0 ? 'no-live-body' : 'no-overlap',
      tolerance: defaultTolerance
    };
  }
  if (overlaps.length > 1) {
    return {
      operation: 'new-body',
      reason: 'multiple-overlap',
      tolerance: Math.max(...overlaps.map((overlap) => overlap.tolerance))
    };
  }

  const overlap = overlaps[0]!;
  const extrusionRemainder = extrusion.volume - overlap.sharedVolume;
  const targetRemainder = overlap.target.volume - overlap.sharedVolume;
  if (extrusionRemainder <= overlap.tolerance) {
    if (targetRemainder <= overlap.tolerance) {
      return {
        operation: 'new-body',
        reason: 'coincident',
        sharedVolume: overlap.sharedVolume,
        tolerance: overlap.tolerance
      };
    }
    return {
      operation: 'cut',
      targetBodyId: overlap.target.bodyId,
      targetBodyName: overlap.target.name,
      reason: 'enclosed',
      sharedVolume: overlap.sharedVolume,
      tolerance: overlap.tolerance
    };
  }
  return {
    operation: 'add',
    targetBodyId: overlap.target.bodyId,
    targetBodyName: overlap.target.name,
    reason: 'partial-overlap',
    sharedVolume: overlap.sharedVolume,
    tolerance: overlap.tolerance
  };
}
