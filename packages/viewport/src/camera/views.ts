import * as THREE from 'three';
import type { StandardView } from '../types';

export const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  // Direction from the target toward the camera, in the Z-up frame. Top now
  // looks down +Z, which is parallel to the up vector, so it keeps a hair of
  // -Y: that both stops OrbitControls seeing a degenerate axis and settles
  // screen-up on +Y rather than an arbitrary diagonal.
  iso: new THREE.Vector3(1, -1, 0.9).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  top: new THREE.Vector3(0, -0.0001, 1).normalize(),
  // Bottom needs the same nudge off the up axis, in the same direction, so
  // that looking up and looking down agree about which way is screen-up.
  bottom: new THREE.Vector3(0, -0.0001, -1).normalize(),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0)
};

/** What each standard view is called in the interface. */
export const VIEW_LABELS: Record<StandardView, string> = {
  iso: 'Isometric',
  front: 'Front',
  back: 'Back',
  top: 'Top',
  bottom: 'Bottom',
  right: 'Right',
  left: 'Left'
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

/**
 * Projects a world point into viewport pixels, or null when it sits behind
 * the camera. Overlays anchored to geometry — value chips, dimension pills —
 * use this to follow their anchor every frame.
 */
export function projectToScreen(
  point: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number
): { x: number; y: number } | null {
  const projected = point.clone().project(camera);
  if (projected.z > 1) {
    return null;
  }
  return {
    x: ((projected.x + 1) / 2) * width,
    y: ((1 - projected.y) / 2) * height
  };
}

/**
 * The orbit pivot that puts a picked point at the centre of rotation without
 * reframing the view.
 *
 * A look-at camera cannot take an arbitrary off-axis pivot for free: moving
 * the target sideways either rotates the camera (if its position is held) or
 * pans it (if its orientation is). Either way the view jumps, which is worse
 * than the problem being solved. Projecting the point onto the view axis
 * keeps the camera's position *and* orientation exactly, and still fixes the
 * thing that actually hurts — orbiting a detail far from the model origin
 * swings it out of frame, because the pivot was never near what you were
 * looking at.
 *
 * Returns null when the point sits behind the camera or on its plane, where
 * there is no sensible pivot distance.
 */
export function orbitPivotForPoint(
  cameraPosition: THREE.Vector3,
  viewDirection: THREE.Vector3,
  point: THREE.Vector3,
  minDepth = 1e-3
): THREE.Vector3 | null {
  const forward = viewDirection.clone().normalize();
  const depth = point.clone().sub(cameraPosition).dot(forward);
  if (!Number.isFinite(depth) || depth <= minDepth) {
    return null;
  }
  return cameraPosition.clone().addScaledVector(forward, depth);
}

/** A glide short enough to feel instant for a nudge. */
export const MIN_TWEEN_MS = 170;
/** A glide long enough to stay readable across a full reorientation. */
export const MAX_TWEEN_MS = 520;
/** Duration for a move of roughly one orbit radius — the common view change. */
const REFERENCE_TWEEN_MS = 400;

/**
 * How long a camera glide should take, given how far it actually travels.
 *
 * A fixed duration makes every move feel wrong at one end: nudging to an
 * adjacent view drags, and flipping to the opposite side of a large part
 * whips past too fast to follow. Scaling by the distance travelled — measured
 * against the orbit radius, so it holds at any model scale — keeps short
 * moves snappy and long ones legible.
 */
export function tweenDurationFor(
  fromPosition: THREE.Vector3,
  toPosition: THREE.Vector3,
  fromTarget: THREE.Vector3,
  toTarget: THREE.Vector3
): number {
  const travel = Math.max(
    fromPosition.distanceTo(toPosition),
    fromTarget.distanceTo(toTarget)
  );
  // The orbit radius stands in for scene scale: the same travel means
  // something quite different on a bracket and on a building.
  const radius = Math.max(fromPosition.distanceTo(fromTarget), 1e-6);
  const ratio = travel / radius;
  if (!Number.isFinite(ratio)) {
    return REFERENCE_TWEEN_MS;
  }
  return THREE.MathUtils.clamp(
    REFERENCE_TWEEN_MS * Math.sqrt(ratio),
    MIN_TWEEN_MS,
    MAX_TWEEN_MS
  );
}
