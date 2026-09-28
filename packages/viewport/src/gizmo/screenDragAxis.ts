import type * as THREE from 'three';

/**
 * A world direction as a drag follows it on screen.
 *
 * `directionX`/`directionY` are a unit vector in CSS pixels with +Y pointing
 * DOWN the screen, the frame pointer events report `clientY` in. A drag of
 * (dx, dy) pixels therefore moves the value by
 * `(dx * directionX + dy * directionY) / pixelsPerUnit` — positive along the
 * world direction, whichever way that direction happens to point on screen.
 */
export interface ScreenDragAxis {
  directionX: number;
  directionY: number;
  pixelsPerUnit: number;
  /** The head-on scale: pixels one world unit spans facing the camera. */
  fallbackPixelsPerUnit: number;
}

/**
 * Pure. Projects `direction` at `point` through `camera` into a viewport of
 * `width` × `height` CSS pixels. Falls back to screen-vertical (a drag UP the
 * screen reads positive) when the direction is nearly head-on, and never lets
 * a foreshortened direction drop below 60% of the head-on scale, so tiny
 * pixel motions cannot turn into huge values.
 *
 * The camera's world matrices must be current.
 */
export function screenDragAxis(
  point: THREE.Vector3,
  direction: THREE.Vector3,
  camera: THREE.Camera,
  viewport: { width: number; height: number },
  fallbackPixelsPerUnit: number
): ScreenDragAxis {
  const projectedStart = point.clone().project(camera);
  const projectedEnd = point.clone().add(direction).project(camera);
  const projectedX = ((projectedEnd.x - projectedStart.x) * viewport.width) / 2;
  // NDC +Y is up; client +Y is down.
  const projectedY =
    (-(projectedEnd.y - projectedStart.y) * viewport.height) / 2;
  const projectedLength = Math.hypot(projectedX, projectedY);
  const usable = projectedLength >= fallbackPixelsPerUnit * 0.15;
  return {
    directionX: usable ? projectedX / projectedLength : 0,
    directionY: usable ? projectedY / projectedLength : -1,
    pixelsPerUnit: Math.max(
      usable ? projectedLength : fallbackPixelsPerUnit,
      fallbackPixelsPerUnit * 0.6,
      0.1
    ),
    fallbackPixelsPerUnit
  };
}

/** Pure. The signed world distance a pointer drag of (dx, dy) px reads. */
export function screenDragValue(
  axis: Pick<ScreenDragAxis, 'directionX' | 'directionY' | 'pixelsPerUnit'>,
  dx: number,
  dy: number
): number {
  return (dx * axis.directionX + dy * axis.directionY) / axis.pixelsPerUnit;
}
