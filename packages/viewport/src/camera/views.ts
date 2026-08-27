import * as THREE from 'three';
import type { StandardView, ViewTarget } from '../types';
import type { CameraPose } from '../render/scene';

export const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  // Direction from the target toward the camera, in the Z-up frame. Top and
  // bottom look along the up vector, so each keeps a hair of Y: OrbitControls
  // derives its azimuth from the camera position, and an exact pole would
  // leave that angle undefined — the first orbit drag away from it would pick
  // an arbitrary roll. The nudges are chosen so both poles settle on the same
  // screen-up as `cameraUpForDirection` derives, +Y.
  iso: new THREE.Vector3(1, -1, 0.9).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  top: new THREE.Vector3(0, -0.0001, 1).normalize(),
  // Looking up flips the world-up projection's sign, so bottom's nudge flips
  // with it: +Y here is what lands the bottom view with screen-up on +Y,
  // agreeing with top instead of arriving 180° rolled.
  bottom: new THREE.Vector3(0, 0.0001, -1).normalize(),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0)
};

const WORLD_UP = new THREE.Vector3(0, 0, 1);
/**
 * Screen-up at the poles, where world up has no component to project. +Y is
 * the limit `cameraUpForDirection` approaches when the camera arrives at top
 * from the front — and, with bottom's nudge mirrored, when it arrives at
 * bottom too — so the fallback continues the projection rather than
 * introducing a roll of its own.
 */
const POLE_UP = new THREE.Vector3(0, 1, 0);

/**
 * The camera roll a view direction implies: world up projected onto the plane
 * perpendicular to the view, falling back to `POLE_UP` looking straight up or
 * down. This is the single answer to "which way is screen-up here" — the view
 * cube's face labels, the glide's final orientation, and OrbitControls' own
 * `lookAt` all agree with it, which is what keeps a label upright when the
 * camera arrives at the face it names.
 */
export function cameraUpForDirection(direction: THREE.Vector3): THREE.Vector3 {
  const view = direction.clone().normalize();
  const up = WORLD_UP.clone().addScaledVector(view, -WORLD_UP.dot(view));
  if (up.lengthSq() < 1e-12) {
    return POLE_UP.clone();
  }
  return up.normalize();
}

/**
 * The full camera orientation a view direction implies, roll included.
 * Standard-view glides slerp between these instead of interpolating the
 * camera position, so a long reorientation swings around the model on an arc
 * rather than diving through it, and the roll turns smoothly instead of
 * snapping in the final frames near a pole.
 */
export function tweenOrientationFor(
  direction: THREE.Vector3
): THREE.Quaternion {
  const view = direction.clone().normalize();
  const matrix = new THREE.Matrix4().lookAt(
    view,
    new THREE.Vector3(0, 0, 0),
    cameraUpForDirection(view)
  );
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

/** Where a view request points the camera: named views or a cube diagonal. */
export function viewDirectionFor(target: ViewTarget): THREE.Vector3 {
  if (typeof target === 'string') {
    return VIEW_DIRECTIONS[target].clone();
  }
  const [x, y, z] = target.corner;
  return new THREE.Vector3(x, y, z).normalize();
}

/** Padding around a face framed by the normal-to-selection action. */
const FACE_VIEW_PADDING = 1.18;

/**
 * Area-weighted centroid of a face's display triangles, given as consecutive
 * corner triples. Face framing must target this, not the surface's parametric
 * reference point: that anchor can sit on the face's rim (on a cylinder-top
 * disc it does), which frames the view off-centre and over-distanced.
 *
 * Returns null when the triangles are missing or degenerate so callers fall
 * back to the reference point instead of aiming at the origin.
 */
export function faceTrianglesCentroid(
  corners: readonly THREE.Vector3[]
): THREE.Vector3 | null {
  const centroid = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i + 2 < corners.length; i += 3) {
    const a = corners[i];
    const b = corners[i + 1];
    const c = corners[i + 2];
    if (!a || !b || !c) {
      return null;
    }
    const triangleArea = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a))
      .length();
    centroid.addScaledVector(
      new THREE.Vector3().add(a).add(b).add(c).divideScalar(3),
      triangleArea
    );
    area += triangleArea;
  }
  if (!Number.isFinite(area) || area < 1e-12) {
    return null;
  }
  return centroid.divideScalar(area);
}

/**
 * Computes a camera pose that centres one planar face and looks back along its
 * outward normal. The face vertices are projected into the eventual screen
 * basis, so a wide face fits a portrait viewport without relying on a
 * world-axis bounding box.
 *
 * Returns null for incomplete or degenerate derived geometry. Camera commands
 * must fail closed rather than inventing a usable plane from a bad normal.
 */
export function computeNormalToFacePose(
  camera: THREE.PerspectiveCamera,
  facePoints: readonly THREE.Vector3[],
  center: THREE.Vector3,
  outwardNormal: THREE.Vector3
): CameraPose | null {
  if (
    facePoints.length === 0 ||
    ![center.x, center.y, center.z].every(Number.isFinite) ||
    ![outwardNormal.x, outwardNormal.y, outwardNormal.z].every(Number.isFinite)
  ) {
    return null;
  }
  const normalLength = outwardNormal.length();
  if (!Number.isFinite(normalLength) || normalLength < 1e-12) {
    return null;
  }

  const direction = outwardNormal.clone().divideScalar(normalLength);
  // Match the named top/bottom views: an exact pole leaves OrbitControls'
  // azimuth undefined, so the first orbit after arriving can choose a random
  // roll. This hair is visually head-on while keeping that azimuth stable.
  if (direction.x * direction.x + direction.y * direction.y < 1e-16) {
    direction.set(
      0,
      direction.z >= 0 ? -0.0001 : 0.0001,
      direction.z >= 0 ? 1 : -1
    );
    direction.normalize();
  }

  const up = cameraUpForDirection(direction);
  const right = up.clone().cross(direction).normalize();
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const tanHalfFov = Math.tan(halfFov);
  const aspect = Math.max(camera.aspect, 1e-6);
  if (!Number.isFinite(tanHalfFov) || tanHalfFov <= 0) {
    return null;
  }

  let requiredDistance = 0;
  let faceRadius = 0;
  for (const point of facePoints) {
    if (![point.x, point.y, point.z].every(Number.isFinite)) {
      return null;
    }
    const offset = point.clone().sub(center);
    const depthTowardCamera = offset.dot(direction);
    requiredDistance = Math.max(
      requiredDistance,
      depthTowardCamera + Math.abs(offset.dot(up)) / tanHalfFov,
      depthTowardCamera + Math.abs(offset.dot(right)) / (tanHalfFov * aspect)
    );
    faceRadius = Math.max(faceRadius, offset.length());
  }
  if (
    !Number.isFinite(requiredDistance) ||
    !Number.isFinite(faceRadius) ||
    faceRadius < 1e-12
  ) {
    return null;
  }

  const distance = Math.max(requiredDistance * FACE_VIEW_PADDING, 1e-9);
  const near = Math.max(
    Math.min(camera.near, distance / 1_000),
    distance / 1_000_000,
    1e-9
  );
  return {
    position: center.clone().addScaledVector(direction, distance),
    target: center.clone(),
    near,
    // Preserve a farther existing scene range while guaranteeing the selected
    // face remains inside the frustum at every supported model scale.
    far: Math.max(camera.far, distance * 12 + faceRadius * 4, near * 1_000)
  };
}

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

/** Maps normalized tween time to normalized progress. */
export type CameraEase = (t: number) => number;

/**
 * The default glide: symmetric cubic in-out. Fine for pivots and restores,
 * where nothing about the move tells the user which end matters.
 */
export const easeInOutCubic: CameraEase = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * View jumps (standard views, fit, normal-to-face) leave at full speed and
 * decay monotonically — the move reads as "thrown" toward the destination,
 * so the user knows where they are going from the first frame. Matches the
 * measured envelope of the reference CAD's view transitions.
 */
export const viewJumpEase: CameraEase = (t) => 1 - Math.pow(1 - t, 3);

/**
 * A velocity trapezoid: ramp up over `attack`, cruise, ramp down over
 * `decel` (both fractions of the duration). C1-continuous. This is the
 * measured envelope of the reference CAD's sketch-entry snap — a short
 * attack so the response is immediate, a cruise long enough to stay
 * readable, and a soft landing.
 */
export function trapezoidEase(attack: number, decel: number): CameraEase {
  const cruise = 1 / (1 - attack / 2 - decel / 2);
  return (t) => {
    if (t <= 0) {
      return 0;
    }
    if (t >= 1) {
      return 1;
    }
    if (t < attack) {
      return (cruise * t * t) / (2 * attack);
    }
    if (t <= 1 - decel) {
      return cruise * (attack / 2 + (t - attack));
    }
    return 1 - (cruise * (1 - t) * (1 - t)) / (2 * decel);
  };
}

/**
 * Entering or leaving a sketch is the longest choreographed move: a fixed
 * duration (it is a mode change, not a nudge, so travel scaling would make
 * short trips feel abrupt) with a ~100 ms attack and a ~240 ms landing.
 */
export const SKETCH_GLIDE_MS = 800;
export const sketchGlideEase: CameraEase = trapezoidEase(0.125, 0.3);

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
