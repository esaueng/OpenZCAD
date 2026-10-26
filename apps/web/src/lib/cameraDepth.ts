import type * as THREE from 'three';

/**
 * Whether `point` lies nearer than the camera's near plane, where neither a
 * perspective nor an orthographic view draws anything: a chip placed by
 * projecting such a point would stand for a handle no one can see.
 */
export function isBehindCamera(
  point: THREE.Vector3,
  camera: THREE.Camera
): boolean {
  // Both projections the viewer uses carry a near plane; a bare camera is
  // taken as clipping at its own position.
  const near =
    'near' in camera && typeof camera.near === 'number' ? camera.near : 0;
  return point.clone().applyMatrix4(camera.matrixWorldInverse).z > -near;
}
