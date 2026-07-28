import * as THREE from 'three';

/**
 * Dragging a rectangle to select several bodies at once.
 *
 * Which direction you drag decides how forgiving the rectangle is, following
 * the convention every mechanical CAD tool shares: drag left to right and
 * only bodies you fully enclosed are taken; drag right to left and anything
 * the rectangle touches comes with it. That is one gesture doing two jobs,
 * and it saves the user hunting for a mode.
 */
export type BoxSelectMode = 'window' | 'crossing';

/** A drag rectangle in the canvas's own pixel space. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One body reduced to what the test needs: its identity and its vertices. */
export interface BoxSelectCandidate {
  bodyId: string;
  /** XYZ-interleaved world positions, as the mesh already stores them. */
  positions: ArrayLike<number>;
}

export interface BoxSelectOptions {
  camera: THREE.Camera;
  /** Canvas size in pixels; projection is normalized against it. */
  width: number;
  height: number;
}

/**
 * Which way the drag went.
 *
 * A drag with no horizontal travel is treated as a window: the strict
 * reading is the safer default when the gesture did not say.
 */
export function boxSelectMode(startX: number, endX: number): BoxSelectMode {
  return endX < startX ? 'crossing' : 'window';
}

export function rectFromDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): ScreenRect {
  return {
    left: Math.min(startX, endX),
    right: Math.max(startX, endX),
    top: Math.min(startY, endY),
    bottom: Math.max(startY, endY)
  };
}

/** Pixels a drag must cover before it counts as a rectangle at all. */
export const BOX_SELECT_MIN_PX = 4;

export function isBoxSelectDrag(rect: ScreenRect): boolean {
  return (
    rect.right - rect.left >= BOX_SELECT_MIN_PX ||
    rect.bottom - rect.top >= BOX_SELECT_MIN_PX
  );
}

/**
 * Projects a world point into canvas pixels, with the sign of its depth.
 *
 * A point behind the camera still projects to a finite coordinate, and a
 * naive test would happily "select" a body behind the viewer. `behind` lets
 * the caller drop those instead.
 */
function project(
  point: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number
): { x: number; y: number; behind: boolean } {
  const projected = point.clone().project(camera);
  return {
    x: ((projected.x + 1) / 2) * width,
    y: ((1 - projected.y) / 2) * height,
    behind: projected.z > 1
  };
}

/**
 * The bodies a drag rectangle selects.
 *
 * The test is on mesh vertices rather than exact silhouettes, which is what
 * the viewport actually holds. Window select is exact under that reading: a
 * body is enclosed precisely when every vertex is. Crossing adds the case a
 * vertex test alone would miss — a rectangle dropped entirely inside one
 * broad face, with no vertex anywhere near it — by also taking a body whose
 * projected extent contains the whole rectangle.
 */
export function bodiesInBox(
  candidates: BoxSelectCandidate[],
  rect: ScreenRect,
  mode: BoxSelectMode,
  options: BoxSelectOptions
): string[] {
  const { camera, width, height } = options;
  const point = new THREE.Vector3();
  const selected: string[] = [];
  for (const candidate of candidates) {
    const count = Math.floor(candidate.positions.length / 3);
    if (count === 0) {
      continue;
    }
    let allInside = true;
    let anyInside = false;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let anyVisible = false;
    for (let index = 0; index < count; index += 1) {
      point.set(
        candidate.positions[index * 3] ?? 0,
        candidate.positions[index * 3 + 1] ?? 0,
        candidate.positions[index * 3 + 2] ?? 0
      );
      const screen = project(point, camera, width, height);
      if (screen.behind) {
        // Half a body behind the camera is not fully enclosed by anything.
        allInside = false;
        continue;
      }
      anyVisible = true;
      minX = Math.min(minX, screen.x);
      maxX = Math.max(maxX, screen.x);
      minY = Math.min(minY, screen.y);
      maxY = Math.max(maxY, screen.y);
      const inside =
        screen.x >= rect.left &&
        screen.x <= rect.right &&
        screen.y >= rect.top &&
        screen.y <= rect.bottom;
      if (inside) {
        anyInside = true;
      } else {
        allInside = false;
      }
    }
    if (!anyVisible) {
      continue;
    }
    const enclosesRect =
      minX <= rect.left &&
      maxX >= rect.right &&
      minY <= rect.top &&
      maxY >= rect.bottom;
    const hit =
      mode === 'window' ? allInside : anyInside || enclosesRect;
    if (hit) {
      selected.push(candidate.bodyId);
    }
  }
  return selected;
}
