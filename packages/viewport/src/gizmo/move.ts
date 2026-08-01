import * as THREE from 'three';

/**
 * Move/rotate gizmo geometry, snapping, and focus.
 *
 * Everything here is pure with respect to the document: it answers "how big
 * should the handle be", "what step should this drag round to", and "which
 * handle is the pointer over". Committing the resulting transform is the
 * app's job.
 */

export type MoveAxis = 'x' | 'y' | 'z';
export type MoveHandleKind = 'axis' | 'ring' | 'center';

export interface MoveGizmoFocus {
  kind: MoveHandleKind;
  axis: MoveAxis;
}

/** Pending Move/Rotate values, previewed live and committed as one feature. */
export interface MovePreview {
  bodyId: string;
  translation: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
}

/** Current gizmo snap increments (shown in the overlay, zoom-adaptive). */
export interface MoveSnap {
  move: number;
  rotate: number;
}

export interface MoveGizmoVisualData {
  moveHandleVisual?: boolean;
  moveHandleFocus?: boolean;
  kind?: MoveHandleKind;
  axis?: MoveAxis;
  baseColor?: number;
  baseOpacity?: number;
}

const MOVE_SNAP_STEPS = [100, 50, 25, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.01];
const ROTATE_SNAP_STEPS = [90, 45, 15, 5, 1, 0.5, 0.1];
/** A snap increment must span at least this many pixels to feel deliberate. */
const SNAP_MIN_PIXELS = 8;
/** Arrow shaft length in CSS pixels; rings and hit targets scale with it. */
const MOVE_GIZMO_LENGTH_PIXELS = 104;

export const MOVE_AXIS_VECTORS: Record<MoveAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

export const MOVE_AXIS_COLORS: Record<MoveAxis, number> = {
  x: 0xef6a6a,
  y: 0x6fd66f,
  z: 0x5f8fef
};

/**
 * Converts the desired fixed screen-space gizmo length into world units.
 * Re-evaluating this as the camera zooms keeps the control usable without
 * allowing it to grow over the model or collapse into an unpickable speck.
 */
export function moveGizmoWorldScale(worldPerPixel: number): number {
  if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) {
    return 1;
  }
  return worldPerPixel * MOVE_GIZMO_LENGTH_PIXELS;
}

/**
 * Translation snap step for the current zoom: the smallest "nice" step that
 * still spans ≥8px on screen. Zooming in therefore unlocks finer steps
 * (10 mm → 1 mm → 0.1 mm …).
 */
export function chooseMoveSnapStep(worldPerPixel: number): number {
  if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) {
    return 1;
  }
  const minWorld = worldPerPixel * SNAP_MIN_PIXELS;
  const candidates = MOVE_SNAP_STEPS.filter((step) => step >= minWorld);
  return candidates.at(-1) ?? MOVE_SNAP_STEPS[0]!;
}

/** Rotation snap step for the current zoom (ring arc pixels per degree). */
export function chooseRotateSnapStep(pixelsPerDegree: number): number {
  if (!Number.isFinite(pixelsPerDegree) || pixelsPerDegree <= 0) {
    return 15;
  }
  const minDegrees = SNAP_MIN_PIXELS / pixelsPerDegree;
  const candidates = ROTATE_SNAP_STEPS.filter((step) => step >= minDegrees);
  return candidates.at(-1) ?? ROTATE_SNAP_STEPS[0]!;
}

/**
 * Three.js Euler matching the exact kernel's world-axis X, then Y, then Z
 * application order (represented as Euler order 'ZYX').
 */
export function moveEuler(rotationDeg: {
  x: number;
  y: number;
  z: number;
}): THREE.Euler {
  return new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg.x),
    THREE.MathUtils.degToRad(rotationDeg.y),
    THREE.MathUtils.degToRad(rotationDeg.z),
    'ZYX'
  );
}

export function isSameMoveGizmoFocus(
  left: MoveGizmoFocus | null,
  right: MoveGizmoFocus | null
): boolean {
  return left?.kind === right?.kind && left?.axis === right?.axis;
}

export function moveGizmoHandleLabel(
  kind: MoveHandleKind,
  axis: MoveAxis
): string {
  if (kind === 'center') {
    return 'Move freely';
  }
  return `${kind === 'ring' ? 'Rotate' : 'Move'} ${axis.toUpperCase()} axis`;
}

/**
 * Keeps hover feedback inside Three.js instead of scheduling React renders on
 * every pointer move. The focused handle retains its axis color and gains a
 * white outline while all competing handles recede.
 */
export function applyMoveGizmoFocus(
  group: THREE.Group,
  focus: MoveGizmoFocus | null
) {
  group.userData.focus = focus;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const data = object.userData as MoveGizmoVisualData;
    const matches = data.kind === focus?.kind && data.axis === focus?.axis;
    if (data.moveHandleFocus) {
      object.visible = matches;
      return;
    }
    if (!data.moveHandleVisual) {
      return;
    }
    const material = (
      object as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.Material | THREE.Material[]
      >
    ).material;
    if (!(material instanceof THREE.MeshBasicMaterial)) {
      return;
    }
    const baseOpacity = data.baseOpacity ?? 1;
    material.opacity = focus ? (matches ? 1 : baseOpacity * 0.2) : baseOpacity;
    material.color.setHex(data.baseColor ?? 0xffffff);
  });
}

/** Parameter t of the closest point on a line to the pointer ray. */
export function closestAxisT(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): number | null {
  const r = origin.clone().sub(ray.origin);
  const b = direction.dot(ray.direction);
  const c = direction.dot(r);
  const f = ray.direction.dot(r);
  const denominator = 1 - b * b;
  if (Math.abs(denominator) < 1e-9) {
    return null; // axis parallel to the view ray
  }
  return (b * f - c) / denominator;
}

export function snapTo(value: number, step: number, fine: boolean): number {
  if (fine) {
    return Math.round(value * 100) / 100;
  }
  return Math.round(value / step) * step;
}

/** Neutral highlight for whichever handle has focus. */
const FOCUS_COLOR = 0xf8fbff;
/** The free-move sphere at the gizmo's centre. */
const CENTER_COLOR = 0xe8f3ff;

function gizmoMaterial(color: number, opacity = 0.95) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false
  });
}

function invisibleMaterial() {
  return new THREE.MeshBasicMaterial({ visible: false });
}

/** Rotation that lays a torus in the plane perpendicular to `axis`. */
function ringRotation(axis: MoveAxis): THREE.Euler {
  if (axis === 'x') {
    return new THREE.Euler(0, Math.PI / 2, 0);
  }
  return axis === 'y'
    ? new THREE.Euler(Math.PI / 2, 0, 0)
    : new THREE.Euler(0, 0, 0);
}

/**
 * Builds the move/rotate gizmo: a translation arrow and a rotation ring per
 * axis, plus a free-move sphere, each with an invisible fat hit volume and a
 * hidden focus twin that `applyMoveGizmoFocus` reveals.
 *
 * Parts are returned rather than added to a group so the caller owns
 * parenting and disposal. Geometry is baked at `scale` — the render loop
 * rescales the group to stay screen-constant, and `baseGizmoScale` records
 * what the geometry was built at so that rescale is relative.
 */
export function buildMoveGizmoParts(scale: number): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const handleData = (kind: MoveHandleKind, axis: MoveAxis) => ({
    moveHandle: true,
    kind,
    axis
  });
  const visualData = (
    kind: MoveHandleKind,
    axis: MoveAxis,
    baseColor: number,
    baseOpacity: number
  ) => ({ ...handleData(kind, axis), moveHandleVisual: true, baseColor, baseOpacity });
  const focusData = (kind: MoveHandleKind, axis: MoveAxis) => ({
    moveHandleFocus: true,
    kind,
    axis
  });
  const add = (
    object: THREE.Object3D,
    userData: Record<string, unknown>,
    renderOrder: number
  ) => {
    object.userData = userData;
    object.renderOrder = renderOrder;
    parts.push(object);
  };

  for (const axis of ['x', 'y', 'z'] as const) {
    const direction = MOVE_AXIS_VECTORS[axis];
    const color = MOVE_AXIS_COLORS[axis];
    const alignment = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction
    );
    const along = (distance: number) =>
      direction.clone().multiplyScalar(distance);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(scale * 0.032, scale * 0.032, scale, 10),
      gizmoMaterial(color)
    );
    shaft.position.copy(along(scale / 2));
    shaft.quaternion.copy(alignment);

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(scale * 0.09, scale * 0.22, 14),
      gizmoMaterial(color)
    );
    head.position.copy(along(scale * 1.08));
    head.quaternion.copy(alignment);

    const arrowHit = new THREE.Mesh(
      new THREE.CylinderGeometry(scale * 0.14, scale * 0.14, scale * 1.3, 8),
      invisibleMaterial()
    );
    arrowHit.position.copy(along(scale * 0.65));
    arrowHit.quaternion.copy(alignment);

    const shaftFocus = new THREE.Mesh(
      new THREE.CylinderGeometry(scale * 0.055, scale * 0.055, scale, 12),
      gizmoMaterial(FOCUS_COLOR)
    );
    shaftFocus.position.copy(shaft.position);
    shaftFocus.quaternion.copy(alignment);
    shaftFocus.visible = false;

    const headFocus = new THREE.Mesh(
      new THREE.ConeGeometry(scale * 0.12, scale * 0.255, 16),
      gizmoMaterial(FOCUS_COLOR)
    );
    headFocus.position.copy(head.position);
    headFocus.quaternion.copy(alignment);
    headFocus.visible = false;

    const rotation = ringRotation(axis);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(scale * 0.85, scale * 0.02, 8, 56),
      gizmoMaterial(color, 0.6)
    );
    ring.rotation.copy(rotation);
    const ringFocus = new THREE.Mesh(
      new THREE.TorusGeometry(scale * 0.85, scale * 0.048, 10, 64),
      gizmoMaterial(FOCUS_COLOR)
    );
    ringFocus.rotation.copy(rotation);
    ringFocus.visible = false;
    const ringHit = new THREE.Mesh(
      new THREE.TorusGeometry(scale * 0.85, scale * 0.1, 6, 40),
      invisibleMaterial()
    );
    ringHit.rotation.copy(rotation);

    for (const part of [shaft, head]) {
      add(part, visualData('axis', axis, color, 0.95), 20);
    }
    add(arrowHit, handleData('axis', axis), 0);
    for (const part of [shaftFocus, headFocus]) {
      add(part, focusData('axis', axis), 19);
    }
    add(ring, visualData('ring', axis, color, 0.6), 19);
    add(ringHit, handleData('ring', axis), 0);
    add(ringFocus, focusData('ring', axis), 18);
  }

  const centerHandle = new THREE.Mesh(
    new THREE.SphereGeometry(scale * 0.11, 18, 12),
    gizmoMaterial(CENTER_COLOR, 0.9)
  );
  add(centerHandle, visualData('center', 'x', CENTER_COLOR, 0.9), 21);

  const centerFocus = new THREE.Mesh(
    new THREE.SphereGeometry(scale * 0.155, 20, 14),
    gizmoMaterial(FOCUS_COLOR)
  );
  centerFocus.visible = false;
  add(centerFocus, focusData('center', 'x'), 20);

  return parts;
}
