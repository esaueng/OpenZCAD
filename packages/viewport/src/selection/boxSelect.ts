import { CLICK_THRESHOLD_PX } from '../input/GestureRouter';
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
  /** Triangle vertex indices into `positions`. */
  indices: ArrayLike<number>;
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

/**
 * Pixels a drag must cover before it counts as a rectangle at all: the same
 * distance that separates a click from a drag anywhere else in the viewport.
 */
export const BOX_SELECT_MIN_PX = CLICK_THRESHOLD_PX;

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

interface ProjectedPoint {
  x: number;
  y: number;
  behind: boolean;
}

const INTERSECTION_EPSILON = 1e-9;

function pointInRect(point: ProjectedPoint, rect: ScreenRect): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function cross(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: { x: number; y: number }
): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle(
  point: { x: number; y: number },
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint
): boolean {
  if (Math.abs(cross(a, b, c)) <= INTERSECTION_EPSILON) {
    return false;
  }
  const ab = cross(a, b, point);
  const bc = cross(b, c, point);
  const ca = cross(c, a, point);
  const hasNegative =
    ab < -INTERSECTION_EPSILON ||
    bc < -INTERSECTION_EPSILON ||
    ca < -INTERSECTION_EPSILON;
  const hasPositive =
    ab > INTERSECTION_EPSILON ||
    bc > INTERSECTION_EPSILON ||
    ca > INTERSECTION_EPSILON;
  return !(hasNegative && hasPositive);
}

function pointOnSegment(
  point: { x: number; y: number },
  from: { x: number; y: number },
  to: { x: number; y: number }
): boolean {
  return (
    point.x >= Math.min(from.x, to.x) - INTERSECTION_EPSILON &&
    point.x <= Math.max(from.x, to.x) + INTERSECTION_EPSILON &&
    point.y >= Math.min(from.y, to.y) - INTERSECTION_EPSILON &&
    point.y <= Math.max(from.y, to.y) + INTERSECTION_EPSILON
  );
}

function segmentsIntersect(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const cdB = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);

  if (
    ((abC > INTERSECTION_EPSILON && abD < -INTERSECTION_EPSILON) ||
      (abC < -INTERSECTION_EPSILON && abD > INTERSECTION_EPSILON)) &&
    ((cdA > INTERSECTION_EPSILON && cdB < -INTERSECTION_EPSILON) ||
      (cdA < -INTERSECTION_EPSILON && cdB > INTERSECTION_EPSILON))
  ) {
    return true;
  }
  return (
    (Math.abs(abC) <= INTERSECTION_EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= INTERSECTION_EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= INTERSECTION_EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= INTERSECTION_EPSILON && pointOnSegment(b, c, d))
  );
}

function triangleIntersectsRect(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint,
  rect: ScreenRect
): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect) || pointInRect(c, rect)) {
    return true;
  }
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom }
  ];
  if (corners.some((corner) => pointInTriangle(corner, a, b, c))) {
    return true;
  }
  const triangleEdges: [ProjectedPoint, ProjectedPoint][] = [
    [a, b],
    [b, c],
    [c, a]
  ];
  const rectEdges = corners.map(
    (corner, index) => [corner, corners[(index + 1) % corners.length]!] as const
  );
  return triangleEdges.some(([from, to]) =>
    rectEdges.some(([rectFrom, rectTo]) =>
      segmentsIntersect(from, to, rectFrom, rectTo)
    )
  );
}

/**
 * The bodies a drag rectangle selects.
 *
 * The test uses the viewport's projected triangles. Window select is exact
 * under that reading: a body is enclosed precisely when every vertex is.
 * Crossing tests the actual triangle projection, including a rectangle
 * dropped inside one broad face. A projected bounding box is not enough:
 * holes, concavities, and disconnected pieces contain empty space that must
 * remain empty to a selection sweep.
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
    let anyVisible = false;
    const projected: ProjectedPoint[] = [];
    for (let index = 0; index < count; index += 1) {
      point.set(
        candidate.positions[index * 3] ?? 0,
        candidate.positions[index * 3 + 1] ?? 0,
        candidate.positions[index * 3 + 2] ?? 0
      );
      const screen = project(point, camera, width, height);
      projected.push(screen);
      if (screen.behind) {
        // Half a body behind the camera is not fully enclosed by anything.
        allInside = false;
        continue;
      }
      anyVisible = true;
      if (!pointInRect(screen, rect)) {
        allInside = false;
      }
    }
    if (!anyVisible) {
      continue;
    }
    let crossingHit = false;
    if (mode === 'crossing') {
      const triangleCount = Math.floor(candidate.indices.length / 3);
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const a = projected[candidate.indices[triangle * 3] ?? -1];
        const b = projected[candidate.indices[triangle * 3 + 1] ?? -1];
        const c = projected[candidate.indices[triangle * 3 + 2] ?? -1];
        // Near-plane clipping is not represented in the mesh data available
        // here. Skip such a triangle rather than inventing a visible area.
        if (!a || !b || !c || a.behind || b.behind || c.behind) {
          continue;
        }
        if (triangleIntersectsRect(a, b, c, rect)) {
          crossingHit = true;
          break;
        }
      }
    }
    const hit = mode === 'window' ? allInside : crossingHit;
    if (hit) {
      selected.push(candidate.bodyId);
    }
  }
  return selected;
}
