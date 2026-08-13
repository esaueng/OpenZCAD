import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';

/**
 * Selection-first drag handles.
 *
 * Every rig is built the same way, and the viewport drives them all through
 * this one contract: arm a rig, rescale its `group` per frame, drag or type a
 * value, read it back on release. Adding an affordance — a radius handle on a
 * cylinder, an angle handle for a revolve, spacing for a pattern — means
 * implementing `DragRig`, not teaching the viewport a new shape.
 *
 * The split between the two groups is the part that is easy to get wrong.
 * `group` sits at a world anchor but its children are in pixel-ish local
 * units and it is rescaled every frame to stay screen-constant, exactly like
 * the move gizmo. `worldGroup` holds true world-space geometry — leaders,
 * ghosts — and must never be rescaled.
 */
export interface DragRig {
  /** Identifies the affordance; also tagged onto the hit mesh. */
  readonly kind: string;
  /** Screen-constant part (visuals + hit target); rescaled per frame. */
  readonly group: THREE.Group;
  /** World-space part; never rescaled. Empty when a rig needs none. */
  readonly worldGroup: THREE.Group;
  /** Where the gesture started, in world space. */
  readonly origin: THREE.Vector3;
  /** Unit direction a positive drag travels along. */
  readonly direction: THREE.Vector3;
  /** Drives the preview; also called by exact numeric entry. */
  setValue(value: number): void;
  value(): number;
  /** Optional invalid-preview treatment for rigs that can rebuild exactly. */
  setWarning?(warning: boolean): void;
  /** World point the value chip should track, given the rig's frame scale. */
  chipAnchor(gizmoScale: number): THREE.Vector3;
  /**
   * Advances the rig's own eased state — its entrance, and whether the
   * pointer is over it. Returns true while something is still moving, so the
   * render loop knows to keep drawing. Rigs without eased state omit it.
   */
  step?(dtMs: number): boolean;
  /** Marks the rig as the thing under the pointer, before any press. */
  setHot?(hot: boolean): void;
  /**
   * Entrance multiplier the viewport folds into its screen-constant scale.
   * Reported rather than applied, because the rig does not own its scale.
   */
  entranceScale?(): number;
  dispose(): void;
}

export interface HandleVec3 {
  x: number;
  y: number;
  z: number;
}

export const HANDLE_COLOR = 0xff8a2b;

/** Handles draw over the model so the target is never buried in geometry. */
export const HANDLE_RENDER_ORDER = 30;

/** Local distance past the handle where the value chip floats. */
export const CHIP_ANCHOR_LOCAL_DISTANCE = 1.3;

export function toVector3(value: HandleVec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

/** The opaque orange every handle shares. */
export function handleMaterial(opacity = 0.95): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: HANDLE_COLOR,
    transparent: true,
    opacity,
    depthTest: false
  });
}

/**
 * The invisible fat volume pointer picks test against. Kept well larger than
 * the visible handle so the affordance is reachable without precision aiming.
 */
export function createHitMesh(
  geometry: THREE.BufferGeometry,
  kind: string
): THREE.Mesh {
  const hit = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.userData.directHandle = true;
  hit.userData.handleKind = kind;
  return hit;
}

/** Adds children at the shared render order. */
export function addHandleParts(group: THREE.Group, parts: THREE.Object3D[]) {
  for (const part of parts) {
    part.renderOrder = HANDLE_RENDER_ORDER;
    group.add(part);
  }
}

/** Detaches and frees every geometry and material a rig owns. */
export function disposeRigGroups(...groups: THREE.Group[]) {
  for (const group of groups) {
    group.removeFromParent();
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof Line2) {
        (child.geometry as THREE.BufferGeometry).dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }
}
