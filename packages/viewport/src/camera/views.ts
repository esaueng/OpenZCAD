import * as THREE from 'three';
import type { StandardView } from '../types';

export const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  // Direction from the target toward the camera, in the Z-up frame. Top now
  // looks down +Z, which is parallel to the up vector, so it keeps a hair of
  // -Y: that both stops OrbitControls seeing a degenerate axis and settles
  // screen-up on +Y rather than an arbitrary diagonal.
  iso: new THREE.Vector3(1, -1, 0.9).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  top: new THREE.Vector3(0, -0.0001, 1).normalize(),
  right: new THREE.Vector3(1, 0, 0)
};

/**
 * How many pixels a world-space size spans on screen, for either projection.
 * Used to keep screen-constant affordances (labels, handles, snap steps) sized
 * against the model rather than against the camera.
 */
export function projectedWorldSizePx(
  camera: THREE.Camera,
  center: THREE.Vector3,
  worldSize: number,
  viewportHeight: number
): number {
  if (camera instanceof THREE.OrthographicCamera) {
    const visibleHeight = Math.max(camera.top - camera.bottom, 1e-9);
    return (viewportHeight * camera.zoom * worldSize) / visibleHeight;
  }
  if (camera instanceof THREE.PerspectiveCamera) {
    const distance = Math.max(camera.position.distanceTo(center), 1e-9);
    const visibleHeight =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return (viewportHeight * worldSize) / Math.max(visibleHeight, 1e-9);
  }
  return viewportHeight;
}
