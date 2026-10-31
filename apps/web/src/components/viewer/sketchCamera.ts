import * as THREE from 'three';
import type { Vector3 } from '@openzcad/shared';

/** Presentation-only: a view within one degree already faces this plane. */
export function alreadyFacesSketch(
  camera: THREE.Camera,
  normal: Vector3
): boolean {
  const direction = new THREE.Vector3(normal.x, normal.y, normal.z);
  if (direction.lengthSq() < 1e-12) return false;
  return (
    camera.getWorldDirection(new THREE.Vector3()).dot(direction.normalize()) <
    -Math.cos(Math.PI / 180)
  );
}

/** The visible roll, including a held plane roll rather than world up. */
export function sketchReturnUp(camera: THREE.Camera): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
}
