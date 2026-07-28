import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraPose } from '../render/scene';
import { orbitPivotForPoint, tweenDurationFor } from './views';
import { pointerBindingsFor, type MiddleDragAction } from '../input/bindings';
import type { ProjectionMode } from '../types';

/** A durable camera pose: what a reload restores. */
export interface ViewportCameraState {
  position: THREE.Vector3Tuple;
  target: THREE.Vector3Tuple;
  orthographicZoom: number;
  /** Vertical half-size of the orthographic frustum before zoom is applied. */
  orthographicHalfHeight?: number;
}

/**
 * OrbitControls keeps easing after its `end` event when damping is on.
 * Persisting once the change stream settles makes a reload match the final
 * visible frame without writing storage on every frame.
 */
const VIEW_SETTLE_MS = 120;

interface CameraTween {
  startTime: number;
  duration: number;
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  near: number;
  far: number;
  onComplete?: () => void;
}

export interface CameraControllerOptions {
  /** Sized element the cameras frame; supplies the aspect ratio. */
  host: HTMLElement;
  /** The element OrbitControls binds its pointer listeners to. */
  domElement: HTMLElement;
  /** Invalidates the viewport so the render loop draws another frame. */
  requestRender(): void;
  /** Durable pose sink, already debounced past OrbitControls' damping tail. */
  onViewChange(state: ViewportCameraState): void;
  /** Read per call: the preference can change without rebuilding the scene. */
  reducedMotion(): boolean;
  /**
   * Whether the wheel zooms toward the pointer rather than the orbit target.
   * Read per call for the same reason.
   */
  zoomToCursor(): boolean;
  /** What a middle-button drag does. Read per call, like the others. */
  middleDrag(): MiddleDragAction;
}

/**
 * Owns the viewport's cameras, orbit controls, projection mode, and glides.
 *
 * Everything here is presentation: the controller never reads or writes
 * document state, and reports poses through `onViewChange` rather than
 * persisting them itself.
 */
export class CameraController {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;

  private options: CameraControllerOptions;
  private orbit: OrbitControls<THREE.Camera>;
  private mode: ProjectionMode = 'perspective';
  private active: THREE.Camera;
  private tween: CameraTween | null = null;
  private settleTimeout: number | null = null;

  constructor(options: CameraControllerOptions) {
    this.options = options;
    const aspect = this.aspect();

    this.perspective = new THREE.PerspectiveCamera(45, aspect, 0.1, 4000);
    // Z-up, matching the solid kernel: a part's vertical size is its `depth`,
    // and cylinders extrude along +Z. This must be set before OrbitControls is
    // constructed below — OrbitControls snapshots `object.up` into a quaternion
    // in its constructor and never refreshes it, so assigning `up` afterwards
    // leaves the orbit axis on +Y while `camera.up` reads (0,0,1).
    this.perspective.up.set(0, 0, 1);
    this.perspective.position.set(90, -90, 80);

    this.orthographic = new THREE.OrthographicCamera(
      -90,
      90,
      90 / aspect,
      -90 / aspect,
      -2000,
      4000
    );
    // syncOrthographic copies position and quaternion but never `up`, and
    // rebinding can hand this camera to a fresh OrbitControls.
    this.orthographic.up.copy(this.perspective.up);
    this.orthographic.position.copy(this.perspective.position);

    this.active = this.perspective;
    this.orbit = this.createOrbit(this.perspective);
    this.orbit.target.set(0, 0, 0);
  }

  get controls(): OrbitControls<THREE.Camera> {
    return this.orbit;
  }

  get activeCamera(): THREE.Camera {
    return this.active;
  }

  get projection(): ProjectionMode {
    return this.mode;
  }

  get hasActiveTween(): boolean {
    return this.tween !== null;
  }

  private aspect(): number {
    const { host } = this.options;
    return host.clientWidth / Math.max(host.clientHeight, 1);
  }

  private emitViewChange = () => {
    this.options.onViewChange(this.capture());
  };

  private scheduleSettledViewChange = () => {
    this.options.requestRender();
    if (this.settleTimeout !== null) {
      window.clearTimeout(this.settleTimeout);
    }
    this.settleTimeout = window.setTimeout(() => {
      this.settleTimeout = null;
      this.emitViewChange();
    }, VIEW_SETTLE_MS);
  };

  private createOrbit(camera: THREE.Camera): OrbitControls<THREE.Camera> {
    const orbit = new OrbitControls(camera, this.options.domElement);
    orbit.enableDamping = true;
    orbit.zoomToCursor = this.options.zoomToCursor();
    this.applyPointerBindings(orbit);
    orbit.addEventListener('end', this.emitViewChange);
    orbit.addEventListener('change', this.scheduleSettledViewChange);
    return orbit;
  }

  private rebindControls(nextCamera: THREE.Camera) {
    const target = this.orbit.target.clone();
    this.orbit.removeEventListener('end', this.emitViewChange);
    this.orbit.removeEventListener('change', this.scheduleSettledViewChange);
    this.orbit.dispose();
    this.orbit = this.createOrbit(nextCamera);
    this.orbit.target.copy(target);
  }

  /** Mirrors the perspective pose onto the ortho camera and its frustum. */
  syncOrthographic(resetZoom: boolean) {
    const { perspective, orthographic } = this;
    orthographic.position.copy(perspective.position);
    orthographic.quaternion.copy(perspective.quaternion);
    if (resetZoom) {
      orthographic.zoom = 1;
    }
    const distance = perspective.position.distanceTo(this.orbit.target);
    const halfHeight =
      distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2));
    const aspect = this.aspect();
    orthographic.left = -halfHeight * aspect;
    orthographic.right = halfHeight * aspect;
    orthographic.top = halfHeight;
    orthographic.bottom = -halfHeight;
    orthographic.updateProjectionMatrix();
  }

  /** Switches projection, rebinding controls and syncing camera poses. */
  applyProjection(mode: ProjectionMode) {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    if (mode === 'orthographic') {
      this.syncOrthographic(true);
      this.active = this.orthographic;
    } else {
      // Bake the ortho dolly zoom back into a perspective distance so the
      // framing survives the switch.
      const direction = this.orthographic.position
        .clone()
        .sub(this.orbit.target)
        .normalize();
      const distance =
        this.orthographic.position.distanceTo(this.orbit.target) /
        Math.max(this.orthographic.zoom, 0.0001);
      this.perspective.position
        .copy(this.orbit.target)
        .addScaledVector(direction, distance);
      this.perspective.quaternion.copy(this.orthographic.quaternion);
      this.active = this.perspective;
    }
    this.rebindControls(this.active);
    this.orbit.update();
    this.emitViewChange();
    this.options.requestRender();
  }

  /**
   * Glides the active camera to a new pose instead of snapping. The tween
   * always animates the perspective master camera; in orthographic mode the
   * per-frame sync mirrors it into the ortho frustum, and any user input
   * cancels the glide immediately.
   */
  startTween(pose: CameraPose, onComplete?: () => void) {
    // Consume leftover damping inertia so the glide starts from rest.
    this.orbit.update();
    if (this.options.reducedMotion()) {
      this.tween = null;
      this.perspective.position.copy(pose.position);
      this.orbit.target.copy(pose.target);
      this.perspective.near = pose.near;
      this.perspective.far = pose.far;
      this.perspective.updateProjectionMatrix();
      this.orbit.update();
      if (this.mode === 'orthographic') {
        this.syncOrthographic(false);
      }
      onComplete?.();
      this.emitViewChange();
      this.options.requestRender();
      return;
    }
    // Starting from wherever the camera is right now — mid-glide included —
    // is what lets one view request interrupt another without a jump.
    const fromPosition = this.perspective.position.clone();
    const fromTarget = this.orbit.target.clone();
    this.tween = {
      startTime: performance.now(),
      duration: tweenDurationFor(
        fromPosition,
        pose.position,
        fromTarget,
        pose.target
      ),
      fromPosition,
      toPosition: pose.position.clone(),
      fromTarget,
      toTarget: pose.target.clone(),
      near: pose.near,
      far: pose.far,
      onComplete
    };
    this.options.requestRender();
  }

  cancelTween() {
    this.tween = null;
  }

  /**
   * Re-pivots the orbit onto a picked point's depth. The camera does not
   * move and does not turn, so nothing on screen shifts; only the centre of
   * the next rotation changes.
   */
  pivotOn(point: THREE.Vector3) {
    const forward = new THREE.Vector3();
    this.active.getWorldDirection(forward);
    const pivot = orbitPivotForPoint(this.active.position, forward, point);
    if (!pivot) {
      return;
    }
    this.orbit.target.copy(pivot);
    this.orbit.update();
    // The target is part of the durable pose, and OrbitControls only emits
    // a change when the *camera* moves — which re-pivoting deliberately
    // avoids. Report it, or a reload restores a stale pivot.
    this.emitViewChange();
  }

  /**
   * Re-reads the navigation preferences onto the live controls. Called when
   * the user changes them; a projection switch picks them up on its own,
   * because it builds fresh controls.
   */
  refreshNavigationPreferences() {
    this.orbit.zoomToCursor = this.options.zoomToCursor();
    this.applyPointerBindings(this.orbit);
  }

  private applyPointerBindings(orbit: OrbitControls<THREE.Camera>) {
    const bindings = pointerBindingsFor(this.options.middleDrag());
    const toMouse = (action: string) =>
      action === 'orbit'
        ? THREE.MOUSE.ROTATE
        : action === 'pan'
          ? THREE.MOUSE.PAN
          : action === 'zoom'
            ? THREE.MOUSE.DOLLY
            : null;
    orbit.mouseButtons = {
      LEFT: toMouse(bindings.left),
      MIDDLE: toMouse(bindings.middle),
      RIGHT: toMouse(bindings.right)
    };
  }

  /** Advances an in-flight glide. Returns true while one is still running. */
  stepTween(now: number): boolean {
    const tween = this.tween;
    if (!tween) {
      return false;
    }
    const t = Math.min((now - tween.startTime) / tween.duration, 1);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.perspective.position.lerpVectors(
      tween.fromPosition,
      tween.toPosition,
      eased
    );
    this.orbit.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (this.mode === 'orthographic') {
      this.syncOrthographic(false);
    }
    if (t >= 1) {
      this.tween = null;
      this.perspective.near = tween.near;
      this.perspective.far = tween.far;
      this.perspective.updateProjectionMatrix();
      tween.onComplete?.();
      this.emitViewChange();
    }
    return true;
  }

  capture(): ViewportCameraState {
    const position = this.active.position;
    const target = this.orbit.target;
    return {
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
      orthographicZoom: this.orthographic.zoom,
      orthographicHalfHeight: Math.abs(this.orthographic.top)
    };
  }

  /**
   * Restores a durable pose. Returns after the perspective pose is in place;
   * the orthographic frustum is only rebuilt when that projection is asked
   * for, so a saved ortho framing survives the switch exactly.
   */
  restore(state: ViewportCameraState, projection: ProjectionMode) {
    this.perspective.position.fromArray(state.position);
    this.orbit.target.fromArray(state.target);
    this.perspective.lookAt(this.orbit.target);
    this.perspective.updateMatrixWorld(true);
    this.orbit.update();
    if (projection !== 'orthographic') {
      return;
    }
    this.applyProjection('orthographic');
    if (state.orthographicHalfHeight) {
      const aspect = this.aspect();
      const halfHeight = state.orthographicHalfHeight;
      this.orthographic.left = -halfHeight * aspect;
      this.orthographic.right = halfHeight * aspect;
      this.orthographic.top = halfHeight;
      this.orthographic.bottom = -halfHeight;
    }
    this.orthographic.zoom = state.orthographicZoom;
    this.orthographic.updateProjectionMatrix();
    this.orbit.update();
    this.emitViewChange();
  }

  /**
   * Resizing changes only the horizontal span. The active orthographic pose,
   * vertical framing, and zoom are preserved exactly.
   */
  handleResize() {
    const aspect = this.aspect();
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    if (this.mode !== 'orthographic') {
      return;
    }
    const halfHeight = Math.max(Math.abs(this.orthographic.top), 0.0001);
    this.orthographic.left = -halfHeight * aspect;
    this.orthographic.right = halfHeight * aspect;
    this.orthographic.top = halfHeight;
    this.orthographic.bottom = -halfHeight;
    this.orthographic.updateProjectionMatrix();
  }

  dispose() {
    if (this.settleTimeout !== null) {
      window.clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    this.orbit.removeEventListener('end', this.emitViewChange);
    this.orbit.removeEventListener('change', this.scheduleSettledViewChange);
    this.orbit.dispose();
  }
}
