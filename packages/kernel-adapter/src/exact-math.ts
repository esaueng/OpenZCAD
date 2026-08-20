/**
 * Kernel-free vector, matrix, and profile-point math shared across the exact
 * adapter's modules. Nothing here touches Remus handles or document state —
 * that boundary is what makes these safe to reuse from any extraction of
 * `exact.ts` without import cycles.
 */
import { resolveParamValue } from '@openzcad/document-core';
import {
  GEOMETRY_LINEAR_TOLERANCE,
  circleProfile,
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type Vec2,
  type Vec3
} from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';

export const GEOMETRY_EPSILON = 1e-9;
export const ANALYTIC_MATCH_EPSILON = 1e-7;
export const DIRECT_EDIT_TOLERANCE = 1e-6;
export const FULL_REVOLUTION = Math.PI * 2;

export function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

export function add(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z
  };
}

export function scale(vector: Vec3, factor: number): Vec3 {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
    z: vector.z * factor
  };
}

export function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

export function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function normalized(vector: Vec3): Vec3 | null {
  const magnitude = length(vector);
  return magnitude > GEOMETRY_EPSILON ? scale(vector, 1 / magnitude) : null;
}

export function finiteVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const [x, y, z] = value as unknown[];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return null;
  }
  return { x, y, z };
}

export function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > GEOMETRY_EPSILON
    ? value
    : null;
}

export function coordinateFrameMatrix(origin: Vec3, zAxis: Vec3): Float64Array {
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const xAxis = normalized(cross(reference, zAxis));
  if (!xAxis) {
    throw new Error('Could not construct a cylinder coordinate frame.');
  }
  const yAxis = cross(zAxis, xAxis);
  return new Float64Array([
    xAxis.x,
    yAxis.x,
    zAxis.x,
    origin.x,
    xAxis.y,
    yAxis.y,
    zAxis.y,
    origin.y,
    xAxis.z,
    yAxis.z,
    zAxis.z,
    origin.z,
    0,
    0,
    0,
    1
  ]);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function axisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
  return {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0
  };
}

export function pointOnPlane(basis: PlaneBasis, point: Vec2, offset: number): Vec3 {
  return {
    x:
      basis.origin.x +
      basis.u.x * point.x +
      basis.v.x * point.y +
      basis.normal.x * offset,
    y:
      basis.origin.y +
      basis.u.y * point.x +
      basis.v.y * point.y +
      basis.normal.y * offset,
    z:
      basis.origin.z +
      basis.u.z * point.x +
      basis.v.z * point.y +
      basis.normal.z * offset
  };
}

export function profilePoints(
  data: SketchObjectData,
  scope: Record<string, number>
): Vec2[] {
  switch (data.objectKind) {
    case 'rectangle':
      return rectangleProfile(
        resolveParamValue(data.width, scope, 'width'),
        resolveParamValue(data.height, scope, 'height'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'circle':
      return circleProfile(
        resolveParamValue(data.radius, scope, 'radius'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'polygon':
      return polygonProfile(
        resolveParamValue(data.sides, scope, 'sides'),
        resolveParamValue(data.radius, scope, 'radius'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'line':
    case 'arc':
      // Open curves cannot be swept directly; they participate in sketches
      // through detected closed regions instead.
      throw new Error(
        `A ${data.objectKind} is not a closed profile and cannot be extruded on its own.`
      );
    case 'text':
      // This legacy path sweeps a single polygonal profile. Text is many
      // regions with holes and exact beziers; approximating it here would
      // silently produce the wrong solid, so it must go through the region
      // path instead.
      throw new Error(
        'Text must be extruded through its detected sketch regions, not as a single profile.'
      );
  }
}

/**
 * Build the same ZYX Euler transform the viewport's Move gizmo composes, so a
 * dragged placement and the rebuilt body agree once more than one axis is
 * non-zero. Remus accepts row-major matrices and column vectors.
 *
 * `scale` multiplies the rotation block, i.e. T·R·S with the scaling about
 * the world origin. Uniform scale commutes with rotation, so this is also
 * S-then-R; the kernel keeps analytic surfaces exact under it.
 */
export function transformMatrix(
  translation: Vec3,
  rotationDeg: Vec3,
  scale = 1
): Float64Array {
  const rx = (rotationDeg.x * Math.PI) / 180;
  const ry = (rotationDeg.y * Math.PI) / 180;
  const rz = (rotationDeg.z * Math.PI) / 180;
  const ca = Math.cos(rx);
  const sa = Math.sin(rx);
  const cb = Math.cos(ry);
  const sb = Math.sin(ry);
  const cc = Math.cos(rz);
  const sc = Math.sin(rz);
  return new Float64Array([
    scale * cc * cb,
    scale * (cc * sb * sa - sc * ca),
    scale * (cc * sb * ca + sc * sa),
    translation.x,
    scale * sc * cb,
    scale * (sc * sb * sa + cc * ca),
    scale * (sc * sb * ca - cc * sa),
    translation.y,
    scale * -sb,
    scale * cb * sa,
    scale * cb * ca,
    translation.z,
    0,
    0,
    0,
    1
  ]);
}

export function uniformScaleMatrix(factor: number): Float64Array {
  return new Float64Array([
    factor,
    0,
    0,
    0,
    0,
    factor,
    0,
    0,
    0,
    0,
    factor,
    0,
    0,
    0,
    0,
    1
  ]);
}

export function quantizeEdgeCoordinate(value: number): number {
  return Math.round(value / GEOMETRY_LINEAR_TOLERANCE);
}

export function pointAt(values: number[], offset: number): Vec3 {
  return {
    x: values[offset] ?? 0,
    y: values[offset + 1] ?? 0,
    z: values[offset + 2] ?? 0
  };
}
