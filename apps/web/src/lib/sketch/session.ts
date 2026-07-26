import type { PlaneBasis } from '@openzcad/geometry';
import type {
  SketchObjectData,
  SketchPlaneFrame,
  Vector3
} from '@openzcad/shared';

/**
 * Pure math for in-viewport sketching: pointer-to-plane projection, snapping,
 * drag-to-shape construction, camera poses, and cursor dimension labels.
 * Everything here is unit-testable without three.js or the DOM.
 */

export interface SketchPoint {
  x: number;
  y: number;
}

const MIN_PROFILE_SIZE = 0.5;

/** Quantizes a sketch point to the linear snap grid. */
export function snapSketchPoint(point: SketchPoint, step = 1): SketchPoint {
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step
  };
}

/**
 * Builds a closed sketch object from a corner/center drag, or null while the
 * gesture is still too small to mean anything.
 */
export function sketchObjectFromDrag(
  tool: 'rectangle' | 'circle' | 'polygon',
  start: SketchPoint,
  end: SketchPoint
): SketchObjectData | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'rectangle') {
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    if (width < MIN_PROFILE_SIZE || height < MIN_PROFILE_SIZE) {
      return null;
    }
    return {
      objectKind: 'rectangle',
      width,
      height,
      centerX: (start.x + end.x) / 2,
      centerY: (start.y + end.y) / 2
    };
  }

  const radius = Math.hypot(dx, dy);
  if (radius < MIN_PROFILE_SIZE) {
    return null;
  }
  if (tool === 'circle') {
    return {
      objectKind: 'circle',
      radius,
      centerX: start.x,
      centerY: start.y
    };
  }
  return {
    objectKind: 'polygon',
    sides: 6,
    radius,
    centerX: start.x,
    centerY: start.y
  };
}

/** A line segment object between two sketch points. */
export function lineObjectFromPoints(
  a: SketchPoint,
  b: SketchPoint
): SketchObjectData | null {
  if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_PROFILE_SIZE) {
    return null;
  }
  return { objectKind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/**
 * Intersects a world-space ray with the sketch plane and returns the point in
 * sketch-local (u, v) coordinates; null when the ray is parallel or hits
 * behind the origin.
 */
export function screenRayToPlanePoint(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  basis: PlaneBasis
): SketchPoint | null {
  const denominator =
    rayDirection.x * basis.normal.x +
    rayDirection.y * basis.normal.y +
    rayDirection.z * basis.normal.z;
  if (Math.abs(denominator) < 1e-9) {
    return null;
  }
  const t =
    ((basis.origin.x - rayOrigin.x) * basis.normal.x +
      (basis.origin.y - rayOrigin.y) * basis.normal.y +
      (basis.origin.z - rayOrigin.z) * basis.normal.z) /
    denominator;
  if (t < 0) {
    return null;
  }
  const hit = {
    x: rayOrigin.x + rayDirection.x * t - basis.origin.x,
    y: rayOrigin.y + rayDirection.y * t - basis.origin.y,
    z: rayOrigin.z + rayDirection.z * t - basis.origin.z
  };
  return {
    x: hit.x * basis.u.x + hit.y * basis.u.y + hit.z * basis.u.z,
    y: hit.x * basis.v.x + hit.y * basis.v.y + hit.z * basis.v.z
  };
}

/**
 * Axis lock for chained lines: within ~5° of horizontal or vertical the
 * segment snaps exactly onto the axis, mirroring the reference's right-angle
 * indicator.
 */
export function axisLockPoint(
  anchor: SketchPoint,
  point: SketchPoint
): { point: SketchPoint; lockedAxis: 'horizontal' | 'vertical' | null } {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    return { point, lockedAxis: null };
  }
  const threshold = Math.tan((5 * Math.PI) / 180);
  if (Math.abs(dy) <= Math.abs(dx) * threshold) {
    return { point: { x: point.x, y: anchor.y }, lockedAxis: 'horizontal' };
  }
  if (Math.abs(dx) <= Math.abs(dy) * threshold) {
    return { point: { x: anchor.x, y: point.y }, lockedAxis: 'vertical' };
  }
  return { point, lockedAxis: null };
}

/**
 * Camera pose facing the sketch plane head-on from the given distance. Planes
 * whose normal is parallel to world +Z get a hair of -Y mixed in, exactly like
 * the standard top view, so OrbitControls never sees a degenerate up axis.
 */
export function sketchEntryPose(
  basis: PlaneBasis,
  distance: number
): { position: Vector3; target: Vector3 } {
  const clamped = Math.max(distance, 1);
  let direction = { ...basis.normal };
  if (Math.abs(direction.z) > 0.9999 && Math.abs(direction.y) < 1e-6) {
    const sign = direction.z >= 0 ? 1 : -1;
    const magnitude = Math.hypot(0.0001, 1);
    direction = { x: 0, y: -0.0001 / magnitude, z: sign / magnitude };
  }
  return {
    position: {
      x: basis.origin.x + direction.x * clamped,
      y: basis.origin.y + direction.y * clamped,
      z: basis.origin.z + direction.z * clamped
    },
    target: { ...basis.origin }
  };
}

/**
 * Builds an orthonormal right-handed sketch frame on a planar face, using the
 * same reference-axis convention as the kernel's cylinder frames so repeated
 * derivations agree.
 */
export function frameFromFace(
  center: Vector3,
  normal: Vector3
): SketchPlaneFrame {
  const magnitude = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const zAxis = {
    x: normal.x / magnitude,
    y: normal.y / magnitude,
    z: normal.z / magnitude
  };
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const xRaw = {
    x: reference.y * zAxis.z - reference.z * zAxis.y,
    y: reference.z * zAxis.x - reference.x * zAxis.z,
    z: reference.x * zAxis.y - reference.y * zAxis.x
  };
  const xMagnitude = Math.hypot(xRaw.x, xRaw.y, xRaw.z) || 1;
  const xAxis = {
    x: xRaw.x / xMagnitude,
    y: xRaw.y / xMagnitude,
    z: xRaw.z / xMagnitude
  };
  const yAxis = {
    x: zAxis.y * xAxis.z - zAxis.z * xAxis.y,
    y: zAxis.z * xAxis.x - zAxis.x * xAxis.z,
    z: zAxis.x * xAxis.y - zAxis.y * xAxis.x
  };
  return { origin: { ...center }, xAxis, yAxis, zAxis };
}

/** The live cursor dimension for an in-progress entity. */
export function dimensionForInProgress(
  tool: 'line' | 'circle' | 'rectangle',
  start: SketchPoint,
  current: SketchPoint
): string {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const round = (value: number): number => Math.round(value * 10) / 10;
  if (tool === 'circle') {
    return `⌀ ${round(Math.hypot(dx, dy) * 2)}`;
  }
  if (tool === 'rectangle') {
    return `${round(Math.abs(dx))} × ${round(Math.abs(dy))}`;
  }
  return `${round(Math.hypot(dx, dy))}`;
}
