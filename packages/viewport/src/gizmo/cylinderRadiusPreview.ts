import * as THREE from 'three';
import type { Vector3 } from '@openzcad/shared';

const MIN_AXIS_LENGTH_SQUARED = 1e-18;

/**
 * World-space affine transform that changes only distance from a cylinder axis.
 *
 * Exact-kernel body vertices are already expressed in world coordinates. This
 * matrix therefore scales the disposable viewport projection about the exact
 * axis while preserving every point's axial coordinate. It never mutates the
 * document or kernel geometry.
 */
export function cylinderRadiusPreviewMatrix(
  axisStart: Vector3,
  axisEnd: Vector3,
  radiusScale: number
): THREE.Matrix4 | null {
  if (!Number.isFinite(radiusScale) || radiusScale <= 0) {
    return null;
  }

  const axis = new THREE.Vector3(
    axisEnd.x - axisStart.x,
    axisEnd.y - axisStart.y,
    axisEnd.z - axisStart.z
  );
  if (axis.lengthSq() <= MIN_AXIS_LENGTH_SQUARED) {
    return null;
  }
  axis.normalize();

  // A = scale * I + (1 - scale) * u*u^T. The u component is unchanged;
  // the two components perpendicular to u are scaled equally.
  const complement = 1 - radiusScale;
  const xx = radiusScale + complement * axis.x * axis.x;
  const xy = complement * axis.x * axis.y;
  const xz = complement * axis.x * axis.z;
  const yy = radiusScale + complement * axis.y * axis.y;
  const yz = complement * axis.y * axis.z;
  const zz = radiusScale + complement * axis.z * axis.z;

  const origin = new THREE.Vector3(axisStart.x, axisStart.y, axisStart.z);
  const transformedOrigin = new THREE.Vector3(
    xx * origin.x + xy * origin.y + xz * origin.z,
    xy * origin.x + yy * origin.y + yz * origin.z,
    xz * origin.x + yz * origin.y + zz * origin.z
  );
  const translation = origin.sub(transformedOrigin);

  return new THREE.Matrix4().set(
    xx,
    xy,
    xz,
    translation.x,
    xy,
    yy,
    yz,
    translation.y,
    xz,
    yz,
    zz,
    translation.z,
    0,
    0,
    0,
    1
  );
}
