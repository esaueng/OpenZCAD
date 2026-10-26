import type { Vector3 } from '@openzcad/shared';
import { MAX_DRAFT_DEG } from '../extrudeDraft';
import type { HandleSpec } from './tools';

/**
 * The in-place Extrude's own handles (U09), beside the region's arrow: a
 * second arrow out of the back face for an independent back distance, and a
 * draft rig hinged on a side wall's foot. Pure geometry, so every placement
 * rule is unit-tested; the viewport draws them as any command's handles.
 */

/** What the handles read of the extrude as it stands. */
export interface ExtrudeHandleState {
  extent: 'blind' | 'to-face' | 'through-all';
  symmetric: boolean;
  /** Signed: which side of the sketch the extrusion leaves by. */
  distance: number;
  backDistance: number;
  draftAngle: number;
}

/** The steepest draft a drag reaches, in whole degrees short of the bound. */
export const DRAFT_DRAG_LIMIT_DEG = MAX_DRAFT_DEG - 1;

function sub(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaled(a: Vector3, s: number): Vector3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function length(a: Vector3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function unit(a: Vector3): Vector3 {
  const size = length(a) || 1;
  return scaled(a, 1 / size);
}

function mean(points: readonly Vector3[]): Vector3 {
  const sum = points.reduce(
    (total, point) => ({
      x: total.x + point.x,
      y: total.y + point.y,
      z: total.z + point.z
    }),
    { x: 0, y: 0, z: 0 }
  );
  return scaled(sum, 1 / points.length);
}

function keyOf(...parts: (string | number)[]): string {
  return parts
    .map((part) => (typeof part === 'number' ? part.toFixed(6) : part))
    .join(':');
}

/** Whether the back distance applies: a one-sided blind extrude only. */
export function extrudeTakesBackDistance(state: ExtrudeHandleState): boolean {
  return state.extent === 'blind' && !state.symmetric;
}

/**
 * Whether a draft applies: it tapers a one-sided extrusion only, so not a
 * through-all cut, and a blind one only off Symmetric with no back distance.
 */
export function extrudeTakesDraft(state: ExtrudeHandleState): boolean {
  if (state.extent === 'through-all') return false;
  if (state.extent === 'to-face') return true;
  return !state.symmetric && !(state.backDistance > 0);
}

/**
 * Twice the outline's signed area about `normal`: positive when it runs
 * counter-clockwise seen from the normal's tip, so its inside lies left of
 * each side (`normal × side`).
 */
function windingAbout(outline: readonly Vector3[], normal: Vector3): number {
  let total = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index]!;
    const b = outline[(index + 1) % outline.length]!;
    total += dot(cross(a, b), normal);
  }
  return total;
}

/**
 * Where the draft rig stands: the middle of the outline's longest side, the
 * way the wall leaves the sketch, and the way into the profile there. Null
 * when the outline has no side to hinge on.
 */
export function extrudeDraftHinge(
  outline: readonly Vector3[],
  normal: Vector3
): { foot: Vector3; along: Vector3; inward: Vector3; size: number } | null {
  if (outline.length < 3) return null;
  const n = unit(normal);
  let best: { a: Vector3; b: Vector3; size: number } | null = null;
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index]!;
    const b = outline[(index + 1) % outline.length]!;
    const size = length(sub(b, a));
    if (!best || size > best.size + 1e-9) best = { a, b, size };
  }
  if (!best || best.size < 1e-9) return null;
  const along = unit(sub(best.b, best.a));
  const foot = scaled(
    {
      x: best.a.x + best.b.x,
      y: best.a.y + best.b.y,
      z: best.a.z + best.b.z
    },
    0.5
  );
  // Into the profile: square to the side, in the plane, on the side the
  // outline's winding puts its inside. Its middle would not do: a concave
  // profile's middle can lie across a reflex side's line.
  const across = unit(cross(n, along));
  const inward = windingAbout(outline, n) < 0 ? scaled(across, -1) : across;
  let min = { ...outline[0]! };
  let max = { ...outline[0]! };
  for (const point of outline) {
    min = {
      x: Math.min(min.x, point.x),
      y: Math.min(min.y, point.y),
      z: Math.min(min.z, point.z)
    };
    max = {
      x: Math.max(max.x, point.x),
      y: Math.max(max.y, point.y),
      z: Math.max(max.z, point.z)
    };
  }
  return { foot, along, inward, size: length(sub(max, min)) };
}

/**
 * Where the back arrow stands: half-way from the profile's middle to the
 * outline point farthest from the draft rig's hinge, so it shares a grip with
 * neither the region's own arrow (at the middle) nor the draft rig.
 */
export function extrudeBackArrowOrigin(
  outline: readonly Vector3[],
  foot: Vector3 | null
): Vector3 {
  const middle = mean(outline);
  if (!foot) return middle;
  let far = outline[0]!;
  for (const point of outline) {
    if (length(sub(point, foot)) > length(sub(far, foot)) + 1e-9) far = point;
  }
  return scaled(
    { x: middle.x + far.x, y: middle.y + far.y, z: middle.z + far.z },
    0.5
  );
}

/**
 * The back arrow and the draft rig for one region. `key` names the region
 * (its sketch and cell): a rig is rebuilt for a new region or a flipped
 * side, never for a value change, so a drag is never interrupted.
 */
export function extrudeHandles(
  outline: readonly Vector3[],
  normal: Vector3,
  key: string,
  state: ExtrudeHandleState
): HandleSpec[] {
  if (outline.length === 0) return [];
  // Nothing has left the sketch yet: there is no back face and no wall, and
  // the region's own arrow is the one thing to drag.
  if (state.extent === 'blind' && !(Math.abs(state.distance) > 0)) return [];
  const n = unit(normal);
  const sense = state.distance < 0 ? -1 : 1;
  const handles: HandleSpec[] = [];
  const hinge = extrudeDraftHinge(outline, n);
  if (extrudeTakesBackDistance(state)) {
    handles.push({
      valueId: 'backDistance',
      kind: 'linear',
      key: keyOf('back', key, sense),
      params: {
        origin: extrudeBackArrowOrigin(outline, hinge?.foot ?? null),
        direction: scaled(n, -sense)
      }
    });
  }
  if (hinge && extrudeTakesDraft(state)) {
    const leaves = scaled(n, sense);
    // Positive draft tapers inward as the wall leaves the sketch: the turn
    // from the wall's straight direction towards the inside is positive.
    const axis = unit(cross(leaves, hinge.inward));
    handles.push({
      valueId: 'draftAngle',
      kind: 'angle',
      key: keyOf(
        'draft',
        key,
        sense,
        hinge.foot.x,
        hinge.foot.y,
        hinge.foot.z,
        axis.x,
        axis.y,
        axis.z
      ),
      params: {
        center: hinge.foot,
        axis,
        startDirection: leaves,
        radius: Math.max(1, hinge.size * 0.3)
      }
    });
  }
  return handles;
}
