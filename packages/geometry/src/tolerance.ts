/** Smallest linear tolerance used by geometry classification and healing. */
export const GEOMETRY_LINEAR_TOLERANCE = 1e-6;

/** Relative component keeps comparisons useful for very large coordinates. */
export const GEOMETRY_RELATIVE_TOLERANCE = 1e-10;

export function geometryTolerance(scale = 1): number {
  return Math.max(
    GEOMETRY_LINEAR_TOLERANCE,
    Math.abs(scale) * GEOMETRY_RELATIVE_TOLERANCE
  );
}

export function isNearlyZero(value: number, scale = 1): boolean {
  return Math.abs(value) <= geometryTolerance(scale);
}
