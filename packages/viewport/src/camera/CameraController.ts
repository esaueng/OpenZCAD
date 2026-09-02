import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraPose } from '../render/scene';
import {
  easeInOutCubic,
  orbitPivotForPoint,
  tweenDurationFor,
  tweenOrientationFor,
  VIEW_DIRECTIONS,
  type CameraEase
} from './views';
import {
  pointerBindingsFor,
  shiftOrbitBindingsFor,
  type MiddleDragAction
} from '../input/bindings';
import type { ProjectionMode } from '../types';
import { wheelIntent, type PointerNavigationMode } from '../input/wheelGesture';
import {
  initialZoomDynamics,
  stepZoomDynamics,
  wheelNotches,
  type ZoomDynamicsState
} from './zoomDynamics';
import {
  advanceWheelZoom,
  applyAnchoredZoom,
  createZoomProjectionScratch,
  wheelDeltaToLogScale
} from './wheelZoom';

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

/**
 * Two damping regimes, switched at the gesture boundary. While the pointer is
 * down the camera must track the hand nearly 1:1 — CAD framing is a precision
 * task, and heavier smoothing reads as the model swimming after the cursor —
 * so the drag factor is just enough to absorb pointer jitter. Release hands
 * the remaining velocity to the glide factor for a short ease-out (~300 ms to
 * rest at 60 Hz): decisive like a tool, not an instant halt, not a map
 * viewer's coast past the framing the user chose.
 */
const DRAG_DAMPING = 0.35;
const GLIDE_DAMPING = 0.15;
/** Keep low-frame-rate devices from stretching a short CAD glide into a coast. */
const ORBIT_GLIDE_MAX_MS = 800;

/** Orbit radius of the home pose on a fresh document, before any fit runs. */
const DEFAULT_ORBIT_RADIUS = 150;

/**
 * A glide is parameterized as orientation + orbit, not as two positions: the
 * quaternions slerp while the target and orbit radius lerp. A straight
 * position lerp degrades exactly where view changes are biggest — flipping to
 * the opposite face drives the camera through the model at the midpoint, and
 * near a pole the roll that `lookAt` derives from the interpolated position
 * snaps in the last few frames.
 */
/** Overrides the glide's default duration and easing per move kind. */
export interface CameraGlideStyle {
  durationMs?: number;
  ease?: CameraEase;
}

interface CameraTween {
  startTime: number;
  duration: number;
  ease: CameraEase;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromQuaternion: THREE.Quaternion;
  toQuaternion: THREE.Quaternion;
  fromDistance: number;
  toDistance: number;
  near: number;
  far: number;
  onComplete?: () => void;
}

export interface CameraControllerOptions {
  /** Sized element the cameras frame; supplies the aspect ratio. */
  host: HTMLElement;
  /** The element OrbitControls binds its pointer listeners to. */
  domElement: HTMLElement;
  /** Boundary containing the canvas and any viewport chrome layered over it. */
  wheelElement?: HTMLElement;
  /** Invalidates the viewport so the render loop draws another frame. */
  requestRender(): void;
  /** Immediate in-memory pose sink, including gesture-time camera changes. */
  onViewChange(state: ViewportCameraState): void;
  /** Durable pose sink, called only after a camera gesture or glide settles. */
  onViewSettled(state: ViewportCameraState): void;
  /** Read per call: the preference can change without rebuilding the scene. */
  reducedMotion(): boolean;
  /**
   * Whether the wheel zooms toward the pointer rather than the orbit target.
   * Read per call for the same reason.
   */
  zoomToCursor(): boolean;
  /** What a middle-button drag does. Read per call, like the others. */
  middleDrag(): MiddleDragAction;
  /** How to read a wheel event: auto-detect, or force one device's meaning. */
  pointerNavigation?(): PointerNavigationMode;
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
  private flushingSettle = false;
  private orbitGlideEndsAt: number | null = null;
  private gestureActive = false;
  private externalOrbitActive = false;
  private disposed = false;
  private zoomDynamics: ZoomDynamicsState = initialZoomDynamics();
  private pendingZoomLogScale = 0;
  private zoomLastStepAt: number | null = null;
  private readonly zoomPointerNdc = new THREE.Vector2();
  private readonly zoomScratch = createZoomProjectionScratch();
  private readonly controlRoot: Node;
  private readonly wheelElement: HTMLElement;
  private controlKeyActive = false;

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
    // Home pose: the shared iso direction, so a fresh document, the ISO view
    // preset, and the fit action all agree on one default orientation.
    this.perspective.position
      .copy(VIEW_DIRECTIONS.iso)
      .multiplyScalar(DEFAULT_ORBIT_RADIUS);

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
    this.controlRoot = options.domElement.getRootNode();
    this.wheelElement = options.wheelElement ?? options.host;
    this.controlRoot.addEventListener('keydown', this.handleControlKeyDown, {
      passive: true,
      capture: true
    });
    this.controlRoot.addEventListener('keyup', this.handleControlKeyUp, {
      passive: true,
      capture: true
    });
    // Capture phase so this runs before OrbitControls' own pointerdown
    // handler reads the button mapping for the gesture.
    this.options.domElement.addEventListener(
      'pointerdown',
      this.applyRightButtonModifier,
      true
    );
    // Own wheel input at the outer viewport boundary so chrome layered beside
    // the canvas cannot leak a notch into page scrolling or bypass the camera.
    this.wheelElement.addEventListener('wheel', this.handleWheel, {
      capture: true,
      passive: false
    });
  }

  private handleControlKeyDown = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Control') {
      this.controlKeyActive = true;
    }
  };

  private handleControlKeyUp = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Control') {
      this.controlKeyActive = false;
    }
  };

  /** Queues zoom packets while preserving the existing trackpad-pan path. */
  private handleWheel = (event: WheelEvent) => {
    const intent = wheelIntent(
      {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey
      },
      this.options.pointerNavigation?.() ?? 'auto'
    );
    if (intent === 'pan') {
      // Take the event away from OrbitControls entirely: its wheel handler
      // only ever dollies, so leaving it to run would zoom as well as pan.
      event.preventDefault();
      event.stopImmediatePropagation();
      // A pan is the user taking over from any queued zoom or command glide.
      this.cancelZoom();
      this.cancelTween();
      // Content follows the fingers, the way a document does: a swipe that
      // scrolls a page down moves the model down.
      this.orbit.pan(-event.deltaX, -event.deltaY);
      this.orbit.update();
      // Debounced rather than written per event — a pan is hundreds of wheel
      // events, and the durable pose only has to match the last one.
      this.scheduleSettledViewChange();
      this.options.requestRender();
      return;
    }
    if (
      this.disposed ||
      !this.orbit.enabled ||
      !this.orbit.enableZoom ||
      this.gestureActive ||
      event.buttons !== 0
    ) {
      return;
    }
    const { state, speed } = stepZoomDynamics(
      this.zoomDynamics,
      performance.now(),
      wheelNotches(event.deltaY, event.deltaMode)
    );
    this.zoomDynamics = state;
    const impulse = wheelDeltaToLogScale({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      controlKeyActive: this.controlKeyActive,
      zoomSpeed: speed
    });
    if (impulse === 0) {
      return;
    }
    const rect = this.options.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.zoomPointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.pendingZoomLogScale += impulse;
    this.orbitGlideEndsAt = null;
    if (this.settleTimeout !== null) {
      window.clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    this.cancelTween();
    this.options.requestRender();
  };

  /**
   * Ctrl (or ⌘) + right-drag orbits; a plain right-drag pans. Shift must NOT
   * be the orbit modifier: Firefox reserves shift+right-click as an escape
   * hatch that always opens the native context menu, page suppression
   * ignored.
   *
   * OrbitControls itself flips rotate↔pan whenever ANY modifier is held, so
   * the trick is to present the mapping whose flip lands on the intended
   * action: plain → pan stays pan; ctrl/⌘ → pan flips to rotate; shift alone
   * → present rotate so the flip lands back on pan.
   */
  private applyRightButtonModifier = (event: PointerEvent) => {
    if (event.button !== 2) {
      return;
    }
    const orbitModifier = event.ctrlKey || event.metaKey;
    this.orbit.mouseButtons.RIGHT =
      event.shiftKey && !orbitModifier ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  };

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

  private emitSettledViewChange = () => {
    const state = this.capture();
    // Keep the in-memory pose exactly aligned with the durable final frame.
    this.options.onViewChange(state);
    this.options.onViewSettled(state);
  };

  /** Keeps the live pose current while parking durability on the settle path. */
  private handleOrbitChange = () => {
    this.emitViewChange();
    if (!this.flushingSettle) {
      this.scheduleSettledViewChange();
    }
  };

  /** Restores tight tracking; a grab mid-glide folds the residue into it. */
  private beginGesture = () => {
    this.cancelZoom();
    this.gestureActive = true;
    this.orbitGlideEndsAt = null;
    if (this.settleTimeout !== null) {
      window.clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    this.orbit.dampingFactor = DRAG_DAMPING;
  };

  /**
   * Keeps frames flowing after a gesture ends so the damping residue decays
   * on screen — the ease-out glide — instead of being flushed in one step,
   * which reads as the camera slamming to a halt on release. The render loop
   * re-requests frames for as long as `update()` reports movement, so one
   * kick here is enough to play the whole glide out.
   */
  private settleDamping = () => {
    this.gestureActive = false;
    if (this.options.reducedMotion()) {
      this.orbitGlideEndsAt = null;
      this.orbit.enableDamping = false;
      this.orbit.update();
      this.orbit.enableDamping = true;
      this.orbit.dampingFactor = DRAG_DAMPING;
      this.emitViewChange();
      this.scheduleSettledViewChange();
      return;
    }
    this.orbit.dampingFactor = GLIDE_DAMPING;
    this.orbitGlideEndsAt = performance.now() + ORBIT_GLIDE_MAX_MS;
    this.options.requestRender();
    // The live pose is readable at release, while durable persistence remains
    // parked until the damping tail reaches this controller's settle path.
    this.emitViewChange();
    this.scheduleSettledViewChange();
  };

  private scheduleSettledViewChange = () => {
    this.options.requestRender();
    if (this.settleTimeout !== null) {
      window.clearTimeout(this.settleTimeout);
    }
    this.settleTimeout = window.setTimeout(() => {
      this.settleTimeout = null;
      if (
        this.gestureActive ||
        this.tween ||
        this.pendingZoomLogScale !== 0 ||
        this.disposed
      ) {
        return;
      }
      this.orbitGlideEndsAt = null;
      // The glide has decayed below OrbitControls' movement epsilon by now,
      // but a sub-epsilon offset still sits frozen on the controls; thawed
      // mid-gesture it lands as a jump in whatever comes next — a pan
      // bleeding into an orbit. Flush it here, where it is invisible, so the
      // next gesture starts from rest.
      this.flushingSettle = true;
      try {
        this.orbit.enableDamping = false;
        this.orbit.update();
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = DRAG_DAMPING;
      } finally {
        this.flushingSettle = false;
      }
      this.emitSettledViewChange();
    }, VIEW_SETTLE_MS);
  };

  private createOrbit(camera: THREE.Camera): OrbitControls<THREE.Camera> {
    const orbit = new OrbitControls(camera, this.options.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = DRAG_DAMPING;
    orbit.zoomToCursor = this.options.zoomToCursor();
    this.applyPointerBindings(orbit);
    orbit.addEventListener('start', this.beginGesture);
    orbit.addEventListener('end', this.settleDamping);
    orbit.addEventListener('change', this.handleOrbitChange);
    return orbit;
  }

  private rebindControls(nextCamera: THREE.Camera) {
    const target = this.orbit.target.clone();
    this.orbit.removeEventListener('start', this.beginGesture);
    this.orbit.removeEventListener('end', this.settleDamping);
    this.orbit.removeEventListener('change', this.handleOrbitChange);
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
    // The rebind below constructs fresh OrbitControls, which snapshot the
    // camera's `up` once (see the constructor). Mid-glide that up is the
    // slerped tween frame, not world up; cancel first so the snapshot — and
    // every orbit after it — stays on the world axis.
    this.cancelZoom();
    this.cancelTween();
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
    this.scheduleSettledViewChange();
    this.options.requestRender();
  }

  /**
   * Glides the active camera to a new pose instead of snapping. The tween
   * always animates the perspective master camera; in orthographic mode the
   * per-frame sync mirrors it into the ortho frustum, and any user input
   * cancels the glide immediately.
   */
  startTween(
    pose: CameraPose,
    onComplete?: () => void,
    glide?: CameraGlideStyle
  ) {
    this.cancelZoom();
    // Consume leftover damping inertia so the glide starts from rest.
    this.orbitGlideEndsAt = null;
    this.orbit.dampingFactor = DRAG_DAMPING;
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
      this.scheduleSettledViewChange();
      this.options.requestRender();
      return;
    }
    // Starting from wherever the camera is right now — mid-glide included —
    // is what lets one view request interrupt another without a jump. The
    // from-orientation is the camera's live quaternion for the same reason:
    // re-deriving it from the position would erase an in-flight roll.
    const fromPosition = this.perspective.position.clone();
    const fromTarget = this.orbit.target.clone();
    const toOffset = pose.position.clone().sub(pose.target);
    const toDistance = toOffset.length();
    // A pose that parks the camera on its own target has no view direction;
    // hold the current one and let the distance collapse express it.
    const toDirection =
      toDistance > 1e-9
        ? toOffset.divideScalar(toDistance)
        : new THREE.Vector3(0, 0, 1).applyQuaternion(
            this.perspective.quaternion
          );
    this.tween = {
      startTime: performance.now(),
      duration:
        glide?.durationMs ??
        tweenDurationFor(fromPosition, pose.position, fromTarget, pose.target),
      ease: glide?.ease ?? easeInOutCubic,
      fromTarget,
      toTarget: pose.target.clone(),
      fromQuaternion: this.perspective.quaternion.clone(),
      toQuaternion: tweenOrientationFor(toDirection),
      fromDistance: Math.max(fromPosition.distanceTo(fromTarget), 1e-6),
      toDistance,
      near: pose.near,
      far: pose.far,
      onComplete
    };
    this.options.requestRender();
  }

  cancelTween() {
    if (this.tween) {
      this.tween = null;
      this.restoreWorldUp();
    }
  }

  private cancelZoom() {
    this.pendingZoomLogScale = 0;
    this.zoomLastStepAt = null;
  }

  /**
   * Hands roll authority back to `lookAt`'s world-up projection once a glide
   * ends. The glide's final frame was built from the same projection, so
   * nothing moves — but leaving a slerped up vector behind would roll every
   * subsequent orbit.
   */
  private restoreWorldUp() {
    this.perspective.up.set(0, 0, 1);
    this.orthographic.up.copy(this.perspective.up);
  }

  /**
   * Starts an orbit owned by an external viewport control such as the view
   * cube. This mirrors OrbitControls' pointer lifecycle without synthesizing
   * DOM events onto the canvas.
   */
  beginOrbitDrag() {
    if (this.disposed || this.externalOrbitActive) {
      return;
    }
    this.cancelTween();
    this.externalOrbitActive = true;
    this.beginGesture();
  }

  /**
   * Applies the same screen-space rotation scale OrbitControls uses for a
   * canvas drag. Keeping this conversion here makes cube and canvas orbiting
   * feel identical at every viewport size.
   */
  orbitByPixels(deltaX: number, deltaY: number) {
    if (
      this.disposed ||
      !this.externalOrbitActive ||
      !Number.isFinite(deltaX) ||
      !Number.isFinite(deltaY)
    ) {
      return;
    }
    const height = Math.max(this.options.domElement.clientHeight, 1);
    this.orbit.rotateLeft((2 * Math.PI * deltaX) / height);
    this.orbit.rotateUp((2 * Math.PI * deltaY) / height);
    this.orbit.update();
    this.options.requestRender();
  }

  /** Releases an external orbit into the same short damping tail as canvas. */
  endOrbitDrag() {
    if (this.disposed || !this.externalOrbitActive) {
      return;
    }
    this.externalOrbitActive = false;
    this.settleDamping();
  }

  /** Keeps screen-space projections in lockstep with OrbitControls' pose. */
  private updateOrbitForFrame(): boolean {
    const changed = this.orbit.update();
    this.active.updateMatrixWorld(true);
    return changed;
  }

  /**
   * Advances pointer-driven orbit damping with a real-time upper bound.
   *
   * OrbitControls applies damping per rendered frame. Without this deadline,
   * a busy or low-refresh device turns the same short residue into a much
   * longer wall-clock coast and drifts beyond the framing the user released.
   */
  stepOrbit(now: number): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.orbitGlideEndsAt !== null && now >= this.orbitGlideEndsAt) {
      this.orbitGlideEndsAt = null;
      this.orbit.enableDamping = false;
      const changed = this.updateOrbitForFrame();
      this.orbit.enableDamping = true;
      this.orbit.dampingFactor = DRAG_DAMPING;
      this.emitViewChange();
      this.scheduleSettledViewChange();
      return changed;
    }
    const changed = this.updateOrbitForFrame();
    if (this.orbitGlideEndsAt !== null && !changed) {
      this.orbitGlideEndsAt = null;
      this.orbit.dampingFactor = DRAG_DAMPING;
    }
    return changed;
  }

  /** Advances accumulated wheel or pinch input by one rendered frame. */
  stepZoom(now: number): boolean {
    if (this.disposed || this.pendingZoomLogScale === 0) {
      return false;
    }
    const elapsed =
      this.zoomLastStepAt === null ? null : now - this.zoomLastStepAt;
    this.zoomLastStepAt = now;
    const step = advanceWheelZoom(
      this.pendingZoomLogScale,
      elapsed,
      this.options.reducedMotion()
    );
    this.pendingZoomLogScale = step.remainingLogScale;
    const applied = applyAnchoredZoom(
      this.active,
      this.orbit.target,
      this.zoomPointerNdc,
      step.appliedLogScale,
      this.options.zoomToCursor(),
      this.zoomScratch
    );
    if (!applied) {
      this.cancelZoom();
      return false;
    }
    if (this.pendingZoomLogScale === 0) {
      this.zoomLastStepAt = null;
      return false;
    }
    return true;
  }

  /**
   * Re-pivots the orbit onto a picked point's depth. The camera does not
   * move and does not turn, so nothing on screen shifts; only the centre of
   * the next rotation changes.
   */
  pivotOn(point: THREE.Vector3) {
    this.cancelZoom();
    const forward = new THREE.Vector3();
    this.active.getWorldDirection(forward);
    const pivot = orbitPivotForPoint(this.active.position, forward, point);
    if (!pivot) {
      return;
    }
    this.orbit.target.copy(pivot);
    this.orbit.update();
    // OrbitControls only emits a change when the camera moves, which this
    // deliberately avoids. Publish the pivot to memory now; a press-and-hold
    // remains storage-free and its release re-arms this settle path.
    this.emitViewChange();
    this.scheduleSettledViewChange();
  }

  /**
   * Re-reads the navigation preferences onto the live controls. Called when
   * the user changes them; a projection switch picks them up on its own,
   * because it builds fresh controls.
   */
  refreshNavigationPreferences() {
    this.cancelZoom();
    this.orbit.zoomToCursor = this.options.zoomToCursor();
    this.applyPointerBindings(this.orbit);
  }

  /**
   * OrbitControls normally turns Shift+left-drag into a pan. Temporarily
   * presenting the left button as pan makes its built-in modifier swap choose
   * rotate instead, without replacing or patching the third-party controls.
   */
  setShiftOrbitActive(active: boolean) {
    this.applyPointerBindings(this.orbit, active);
  }

  private applyPointerBindings(
    orbit: OrbitControls<THREE.Camera>,
    shiftOrbit = false
  ) {
    const middleDrag = this.options.middleDrag();
    const bindings = shiftOrbit
      ? shiftOrbitBindingsFor(middleDrag)
      : pointerBindingsFor(middleDrag);
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
    const eased = tween.ease(t);
    const quaternion = tween.fromQuaternion
      .clone()
      .slerp(tween.toQuaternion, eased);
    const target = new THREE.Vector3().lerpVectors(
      tween.fromTarget,
      tween.toTarget,
      eased
    );
    const distance = THREE.MathUtils.lerp(
      tween.fromDistance,
      tween.toDistance,
      eased
    );
    // The camera sits along its own view axis: local +Z, taken to world.
    this.perspective.position
      .copy(target)
      .addScaledVector(
        new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion),
        distance
      );
    this.perspective.quaternion.copy(quaternion);
    // OrbitControls' update() runs right after this and re-derives the
    // orientation with `lookAt`. Handing both cameras the slerped frame's own
    // up axis makes that lookAt reproduce the slerp exactly instead of
    // stomping its roll with a world-up projection of the mid-glide view.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    this.perspective.up.copy(up);
    this.orthographic.up.copy(up);
    this.orbit.target.copy(target);
    if (this.mode === 'orthographic') {
      this.syncOrthographic(false);
    }
    if (t >= 1) {
      this.tween = null;
      this.restoreWorldUp();
      this.perspective.near = tween.near;
      this.perspective.far = tween.far;
      this.perspective.updateProjectionMatrix();
      tween.onComplete?.();
      this.emitViewChange();
      this.scheduleSettledViewChange();
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
    this.cancelZoom();
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
    this.scheduleSettledViewChange();
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.options.domElement.removeEventListener(
      'pointerdown',
      this.applyRightButtonModifier,
      true
    );
    this.wheelElement.removeEventListener('wheel', this.handleWheel, {
      capture: true
    });
    this.controlRoot.removeEventListener('keydown', this.handleControlKeyDown, {
      capture: true
    });
    this.controlRoot.removeEventListener('keyup', this.handleControlKeyUp, {
      capture: true
    });
    this.cancelZoom();
    this.gestureActive = false;
    this.externalOrbitActive = false;
    this.orbitGlideEndsAt = null;
    if (this.settleTimeout !== null) {
      window.clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    this.orbit.removeEventListener('start', this.beginGesture);
    this.orbit.removeEventListener('end', this.settleDamping);
    this.orbit.removeEventListener('change', this.handleOrbitChange);
    this.orbit.dispose();
  }
}
