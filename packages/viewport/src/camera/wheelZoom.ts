import * as THREE from 'three';
import { normalizedWheelDelta } from './zoomDynamics';

const THREE_WHEEL_ZOOM_BASE = 0.95;
const WHEEL_DELTA_SCALE = 0.01;
const PINCH_DELTA_MULTIPLIER = 10;
const ZOOM_TIME_CONSTANT_MS = 45;
const MAX_ZOOM_LOG_RATE_PER_SECOND = 3;
/**
 * Reduced motion drops the easing, not the bound. Landing a whole burst in
 * one frame is exactly the discontinuity this module exists to prevent, so
 * that path ramps at a constant, faster rate and stops dead with no tail.
 */
const REDUCED_MOTION_LOG_RATE_PER_SECOND = 6;
const MAX_FRAME_STEP_MS = 50;
const DEFAULT_FRAME_STEP_MS = 1000 / 60;
const SETTLED_LOG_EPSILON = 1e-4;

export interface WheelZoomDelta {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  /** True only for a real Control key press; browser pinch events omit it. */
  controlKeyActive: boolean;
  /** Velocity-adaptive OrbitControls speed computed for this packet. */
  zoomSpeed: number;
}

export interface ZoomStep {
  appliedLogScale: number;
  remainingLogScale: number;
}

export interface ZoomProjectionScratch {
  readonly anchor: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly projected: THREE.Vector3;
  readonly nextTarget: THREE.Vector3;
  readonly translation: THREE.Vector3;
  readonly plane: THREE.Plane;
  readonly ray: THREE.Ray;
}

export function createZoomProjectionScratch(): ZoomProjectionScratch {
  return {
    anchor: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    projected: new THREE.Vector3(),
    nextTarget: new THREE.Vector3(),
    translation: new THREE.Vector3(),
    plane: new THREE.Plane(),
    ray: new THREE.Ray()
  };
}

/** Mirrors OrbitControls' wheel scale without applying it immediately. */
export function wheelDeltaToLogScale(input: WheelZoomDelta): number {
  if (
    !Number.isFinite(input.deltaY) ||
    input.deltaY === 0 ||
    !Number.isFinite(input.zoomSpeed) ||
    input.zoomSpeed <= 0
  ) {
    return 0;
  }
  let normalized = normalizedWheelDelta(input.deltaY, input.deltaMode);
  if (input.ctrlKey && !input.controlKeyActive) {
    normalized *= PINCH_DELTA_MULTIPLIER;
  }
  return (
    -Math.log(THREE_WHEEL_ZOOM_BASE) *
    normalized *
    WHEEL_DELTA_SCALE *
    input.zoomSpeed
  );
}

/**
 * Consumes a pending logarithmic distance change without making behavior
 * depend on the display refresh rate. The rate cap prevents a batched pinch
 * or accelerated wheel spin from becoming one oversized rendered step, in
 * both motion modes; reduced motion only swaps the eased approach for a
 * linear ramp.
 */
export function advanceWheelZoom(
  pendingLogScale: number,
  elapsedMs: number | null,
  reducedMotion: boolean
): ZoomStep {
  if (!Number.isFinite(pendingLogScale)) {
    return { appliedLogScale: 0, remainingLogScale: 0 };
  }
  if (Math.abs(pendingLogScale) <= SETTLED_LOG_EPSILON) {
    return { appliedLogScale: pendingLogScale, remainingLogScale: 0 };
  }

  const frameMs = Math.min(
    Math.max(elapsedMs ?? DEFAULT_FRAME_STEP_MS, 0),
    MAX_FRAME_STEP_MS
  );
  const alpha = reducedMotion
    ? 1
    : 1 - Math.exp(-frameMs / ZOOM_TIME_CONSTANT_MS);
  const requested = pendingLogScale * alpha;
  const rate = reducedMotion
    ? REDUCED_MOTION_LOG_RATE_PER_SECOND
    : MAX_ZOOM_LOG_RATE_PER_SECOND;
  const maximum = rate * (frameMs / 1000);
  const appliedLogScale = THREE.MathUtils.clamp(requested, -maximum, maximum);
  const remainingLogScale = pendingLogScale - appliedLogScale;
  if (Math.abs(remainingLogScale) <= SETTLED_LOG_EPSILON) {
    return {
      appliedLogScale: appliedLogScale + remainingLogScale,
      remainingLogScale: 0
    };
  }
  return { appliedLogScale, remainingLogScale };
}

export function targetPlanePoint(
  camera: THREE.Camera,
  target: THREE.Vector3,
  pointerNdc: THREE.Vector2,
  scratch: ZoomProjectionScratch
): THREE.Vector3 {
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(scratch.forward);
  scratch.plane.setFromNormalAndCoplanarPoint(scratch.forward, target);
  if (camera instanceof THREE.OrthographicCamera) {
    scratch.projected.set(pointerNdc.x, pointerNdc.y, -1).unproject(camera);
    scratch.ray.set(scratch.projected, scratch.forward);
  } else {
    scratch.projected.set(pointerNdc.x, pointerNdc.y, 0.5).unproject(camera);
    scratch.ray.set(
      camera.position,
      scratch.projected.sub(camera.position).normalize()
    );
  }
  return (
    scratch.ray.intersectPlane(scratch.plane, scratch.anchor) ??
    scratch.anchor.copy(target)
  );
}

/** Applies one bounded zoom step while keeping the pointer anchor stationary. */
export function applyAnchoredZoom(
  camera: THREE.Camera,
  target: THREE.Vector3,
  pointerNdc: THREE.Vector2,
  logScale: number,
  zoomToCursor: boolean,
  scratch: ZoomProjectionScratch
): boolean {
  if (!Number.isFinite(logScale) || logScale === 0) {
    return false;
  }
  const scale = Math.exp(logScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    return false;
  }
  const anchor = zoomToCursor
    ? targetPlanePoint(camera, target, pointerNdc, scratch)
    : scratch.anchor.copy(target);

  if (camera instanceof THREE.PerspectiveCamera) {
    camera.position.sub(anchor).multiplyScalar(scale).add(anchor);
    target.sub(anchor).multiplyScalar(scale).add(anchor);
  } else if (camera instanceof THREE.OrthographicCamera) {
    const nextZoom = camera.zoom / scale;
    if (!Number.isFinite(nextZoom) || nextZoom <= 0) {
      return false;
    }
    scratch.nextTarget
      .copy(target)
      .sub(anchor)
      .multiplyScalar(scale)
      .add(anchor);
    scratch.translation.copy(scratch.nextTarget).sub(target);
    camera.position.add(scratch.translation);
    target.copy(scratch.nextTarget);
    camera.zoom = nextZoom;
    camera.updateProjectionMatrix();
  } else {
    return false;
  }

  camera.updateMatrixWorld(true);
  return true;
}
