import * as THREE from 'three';
import {
  screenDragAxis,
  screenDragValue,
  snapTo,
  type ScreenDragAxis
} from '@openzcad/viewport';
import type { UnitSystem, Vector3 } from '@openzcad/shared';
import { formatAssemblyValue } from './assemblyUi';

/**
 * Dragging a part in the exploded view (AS03). Pure pointer math: the drag
 * follows the world axis (X, Y or Z) whose on-screen direction best matches
 * the pointer's first travel, and reads the distance along it from the
 * pointer's total travel. Exploded offsets are world translations, so a part
 * slides straight out along that axis however its joints turned it, and the
 * stored offsets stay clean multiples of the length step.
 */

export type ExplodeAxis = 'x' | 'y' | 'z';

const AXES: Readonly<Record<ExplodeAxis, THREE.Vector3>> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

export interface ExplodeDragSession {
  axis: ExplodeAxis;
  screen: ScreenDragAxis;
  /** The part's offset when the drag began (world). */
  startOffset: Vector3;
}

export interface ExplodeDragReading {
  offset: Vector3;
  /** Signed travel along the axis since the drag began (world). */
  distance: number;
}

/**
 * The axis whose projected screen direction carries most of `travel`.
 * `projected` is each axis' screen motion, CSS px (+Y down), per world
 * unit at the grab point: a foreshortened axis scores low by its length.
 * Null for no travel.
 */
export function chooseExplodeAxis(
  projected: Readonly<Record<ExplodeAxis, { x: number; y: number }>>,
  travel: { dx: number; dy: number }
): ExplodeAxis | null {
  const length = Math.hypot(travel.dx, travel.dy);
  if (!(length > 0)) return null;
  const ux = travel.dx / length;
  const uy = travel.dy / length;
  let best: ExplodeAxis | null = null;
  let bestScore = 0;
  for (const axis of ['x', 'y', 'z'] as const) {
    const p = projected[axis];
    const score = Math.abs(p.x * ux + p.y * uy);
    if (score > bestScore + 1e-9) {
      best = axis;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Starts a drag at `grab` (world) once the pointer has moved by `travel`
 * CSS px. `worldPerPixelAt` is the camera's scale at a world point.
 */
export function beginExplodeDrag(
  grab: Vector3,
  camera: THREE.Camera,
  viewport: { width: number; height: number },
  worldPerPixelAt: (point: THREE.Vector3) => number,
  travel: { dx: number; dy: number },
  startOffset: Vector3
): ExplodeDragSession | null {
  const point = new THREE.Vector3(grab.x, grab.y, grab.z);
  const worldPerPixel = worldPerPixelAt(point);
  if (!(worldPerPixel > 0) || viewport.width <= 0 || viewport.height <= 0)
    return null;
  const fallback = 1 / worldPerPixel;
  const screens = {} as Record<ExplodeAxis, ScreenDragAxis>;
  const projected = {} as Record<ExplodeAxis, { x: number; y: number }>;
  const origin = point.clone().project(camera);
  for (const axis of ['x', 'y', 'z'] as const) {
    screens[axis] = screenDragAxis(
      point,
      AXES[axis],
      camera,
      viewport,
      fallback
    );
    const end = point.clone().add(AXES[axis]).project(camera);
    projected[axis] = {
      x: ((end.x - origin.x) * viewport.width) / 2,
      y: (-(end.y - origin.y) * viewport.height) / 2
    };
  }
  const axis = chooseExplodeAxis(projected, travel);
  return axis
    ? { axis, screen: screens[axis], startOffset: { ...startOffset } }
    : null;
}

/**
 * The offset a drag of (dx, dy) CSS px from the press reads: snapped to
 * `step` unless `fine` (Shift), which keeps two decimals like Move.
 */
export function readExplodeDrag(
  session: ExplodeDragSession,
  dx: number,
  dy: number,
  step: number,
  fine: boolean
): ExplodeDragReading {
  const raw = screenDragValue(session.screen, dx, dy);
  const start = session.startOffset[session.axis];
  const value = snapTo(start + raw, step, fine);
  return {
    offset: { ...session.startOffset, [session.axis]: value },
    distance: value - start
  };
}

/** "X +12.0 mm": the axis and the travel since the drag began. */
export function formatExplodeDragValue(
  axis: ExplodeAxis,
  distance: number,
  lengthUnit?: UnitSystem
): string {
  const text = formatAssemblyValue(distance, 'mm', lengthUnit);
  const sign = text.startsWith('-') ? '' : '+';
  return `${axis.toUpperCase()} ${sign}${text}`;
}
