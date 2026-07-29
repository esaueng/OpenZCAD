import type { Vector3 } from '@openzcad/shared';

export const MIN_CYLINDER_RADIUS = 0.1;
export const MAX_CYLINDER_RADIUS = 1_000_000;

export interface CylinderRadialFrame {
  axisOrigin: Vector3;
  axisDirection: Vector3;
  radialDirection: Vector3;
  radiusAtHit: number;
  concavity: 'hole' | 'boss';
}

function length(vector: Vector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(vector: Vector3): Vector3 | null {
  const magnitude = length(vector);
  return magnitude > 1e-9
    ? {
        x: vector.x / magnitude,
        y: vector.y / magnitude,
        z: vector.z / magnitude
      }
    : null;
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function pointDistance(left: Vector3, right: Vector3): number {
  return Math.hypot(
    left.x - right.x,
    left.y - right.y,
    left.z - right.z
  );
}

/**
 * Matches the immutable world-space axis of two regenerated cylindrical
 * faces. Kernel topology IDs may change when the radius changes, but the axis
 * endpoints must not; accepting reversed endpoints handles equivalent kernel
 * orientation without accepting a translated or resized axis.
 */
export function sameCylinderAxis(
  firstStart: Vector3,
  firstEnd: Vector3,
  secondStart: Vector3,
  secondEnd: Vector3,
  relativeTolerance = 1e-7
): boolean {
  const scale = Math.max(
    1,
    length(firstStart),
    length(firstEnd),
    length(secondStart),
    length(secondEnd),
    pointDistance(firstStart, firstEnd),
    pointDistance(secondStart, secondEnd)
  );
  const tolerance = scale * relativeTolerance;
  const aligned =
    pointDistance(firstStart, secondStart) <= tolerance &&
    pointDistance(firstEnd, secondEnd) <= tolerance;
  const reversed =
    pointDistance(firstStart, secondEnd) <= tolerance &&
    pointDistance(firstEnd, secondStart) <= tolerance;
  return aligned || reversed;
}

/**
 * Resolves the fixed cylinder axis and outward radial direction at a picked
 * point. Axis endpoints and hit points are already world-space exact-kernel
 * measurements, so this works unchanged after arbitrary body transforms.
 */
export function cylinderRadialFrame(
  hitPoint: Vector3,
  surfaceNormal: Vector3,
  axisStart: Vector3,
  axisEnd: Vector3
): CylinderRadialFrame | null {
  const axisDirection = normalized({
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  });
  if (!axisDirection) {
    return null;
  }
  const fromAxisOrigin = {
    x: hitPoint.x - axisStart.x,
    y: hitPoint.y - axisStart.y,
    z: hitPoint.z - axisStart.z
  };
  const axialDistance = dot(fromAxisOrigin, axisDirection);
  const axisOrigin = {
    x: axisStart.x + axisDirection.x * axialDistance,
    y: axisStart.y + axisDirection.y * axialDistance,
    z: axisStart.z + axisDirection.z * axialDistance
  };
  const radial = {
    x: hitPoint.x - axisOrigin.x,
    y: hitPoint.y - axisOrigin.y,
    z: hitPoint.z - axisOrigin.z
  };
  const radiusAtHit = length(radial);
  const radialDirection = normalized(radial);
  if (!radialDirection) {
    return null;
  }
  return {
    axisOrigin,
    axisDirection,
    radialDirection,
    radiusAtHit,
    concavity:
      dot(surfaceNormal, radialDirection) < 0 ? 'hole' : 'boss'
  };
}

/** Signed world-space movement away from the cylinder axis. */
export function signedRadialDelta(
  initialHitPoint: Vector3,
  currentPoint: Vector3,
  initialRadialDirection: Vector3
): number {
  return dot(
    {
      x: currentPoint.x - initialHitPoint.x,
      y: currentPoint.y - initialHitPoint.y,
      z: currentPoint.z - initialHitPoint.z
    },
    initialRadialDirection
  );
}

/**
 * The direct-edit invariant: only radius changes. The fixed bounds prevent an
 * inverted or numerically unbounded drag before the exact kernel validates it.
 */
export function radiusFromRadialDelta(
  originalRadius: number,
  radialDelta: number,
  minRadius = MIN_CYLINDER_RADIUS,
  maxRadius = MAX_CYLINDER_RADIUS
): number {
  if (
    !Number.isFinite(originalRadius) ||
    !Number.isFinite(radialDelta) ||
    !Number.isFinite(minRadius) ||
    !Number.isFinite(maxRadius) ||
    minRadius <= 0 ||
    maxRadius < minRadius
  ) {
    throw new Error('Cylinder radius drag bounds must be finite and positive.');
  }
  return Math.min(
    maxRadius,
    Math.max(minRadius, originalRadius + radialDelta)
  );
}

export function radiusToDiameter(radius: number): number {
  return radius * 2;
}

export function diameterToRadius(diameter: number): number {
  return diameter / 2;
}
