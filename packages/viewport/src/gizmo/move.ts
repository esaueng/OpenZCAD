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
 * The Move feature rotates about the world origin (X, then Y, then Z — the
 * exact kernel applies the axes in that order, i.e. Euler 'ZYX'), then
 * translates. To make the gizmo rotate the body about its own center, fold
 * the difference into the committed translation: T = t + c − R·c.
 */
export function composeMoveTransform(
  center: { x: number; y: number; z: number },
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  const rotated = new THREE.Vector3(center.x, center.y, center.z).applyEuler(
    moveEuler(rotationDeg)
  );
  return {
    x: translation.x + center.x - rotated.x,
    y: translation.y + center.y - rotated.y,
    z: translation.z + center.z - rotated.z
  };
}

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
