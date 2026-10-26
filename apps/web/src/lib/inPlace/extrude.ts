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
 * Where the back arrow stands: inside the profile, a quarter of the way
 * along its widest interior span (of equal ones, the farthest from the
 * draft rig's hinge) from the end farther from the hinge, so it shares a
 * grip with neither the region's own arrow (in the middle) nor the rig. Any vertex average can lie outside a
 * concave profile (in a C's notch); a span between two crossings of the
 * outline cannot. The spans are cut by lines across the profile, square to
 * `along` (the hinge's side, else the first side). A crossing of an inner
 * loop (`holes`, a washer's bore) ends a span too, so none runs over a void.
 */
export function extrudeBackArrowOrigin(
  outline: readonly Vector3[],
  normal: Vector3,
  foot: Vector3 | null,
  along?: Vector3,
  holes: readonly (readonly Vector3[])[] = []
): Vector3 {
  const span = widestInteriorSpan(outline, normal, foot, along, holes);
  if (!span) return outline[0]!;
  const width = span.end - span.start;
  const nearStart = span.at(span.start + width * 0.25);
  const nearEnd = span.at(span.end - width * 0.25);
  if (!foot) return nearStart;
  return length(sub(nearStart, foot)) >= length(sub(nearEnd, foot))
    ? nearStart
    : nearEnd;
}

/**
 * The profile's widest interior span (see `extrudeBackArrowOrigin`): its two
 * ends along the cutting line, and the world point at a place along it.
 */
function widestInteriorSpan(
  outline: readonly Vector3[],
  normal: Vector3,
  foot: Vector3 | null,
  along: Vector3 | undefined,
  holes: readonly (readonly Vector3[])[]
): { start: number; end: number; at(x: number): Vector3 } | null {
  const n = unit(normal);
  const origin = outline[0];
  if (!origin) return null;
  const first = outline.find((point) => length(sub(point, origin)) > 1e-9);
  if (!first) return null;
  const u = unit(along ?? sub(first, origin));
  const v = unit(cross(n, u));
  const project = (point: Vector3) => {
    const offset = sub(point, origin);
    return { x: dot(offset, u), y: dot(offset, v) };
  };
  const flat = outline.map(project);
  // Every loop's sides, the outer one's and each hole's: even-odd pairing
  // over all of them leaves a hole out of the spans.
  const loops = [flat, ...holes.map((loop) => loop.map(project))];
  const ys = flat.map((point) => point.y);
  const low = Math.min(...ys);
  const high = Math.max(...ys);
  const footFlat = foot
    ? { x: dot(sub(foot, origin), u), y: dot(sub(foot, origin), v) }
    : null;
  const spanScore = (y: number, start: number, end: number) =>
    footFlat
      ? Math.hypot((start + end) / 2 - footFlat.x, y - footFlat.y)
      : -Math.abs(y - (low + high) / 2);
  let best: { y: number; start: number; end: number } | null = null;
  for (let line = 1; line < 16; line += 1) {
    // Off every vertex's height, so a crossing is never counted twice.
    const y = low + ((high - low) * line) / 16 + (high - low) * 1e-7;
    const xs: number[] = [];
    for (const loop of loops) {
      for (let index = 0; index < loop.length; index += 1) {
        const a = loop[index]!;
        const b = loop[(index + 1) % loop.length]!;
        if (a.y <= y !== b.y <= y) {
          xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
    }
    xs.sort((left, right) => left - right);
    for (let index = 0; index + 1 < xs.length; index += 2) {
      const start = xs[index]!;
      const end = xs[index + 1]!;
      // The widest; of equal ones, the one standing farthest from the
      // hinge (else nearest the profile's mid-height).
      const width = end - start;
      const bestWidth = best ? best.end - best.start : -Infinity;
      if (
        width > bestWidth + 1e-9 ||
        (width > bestWidth - 1e-9 &&
          best !== null &&
          spanScore(y, start, end) > spanScore(best.y, best.start, best.end))
      ) {
        best = { y, start, end };
      }
    }
  }
  if (!best) return null;
  const line = best.y;
  return {
    start: best.start,
    end: best.end,
    at: (x: number): Vector3 => ({
      x: origin.x + u.x * x + v.x * line,
      y: origin.y + u.y * x + v.y * line,
      z: origin.z + u.z * x + v.z * line
    })
  };
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
  state: ExtrudeHandleState,
  /** The region's inner loops, which the back arrow keeps out of. */
  holes: readonly (readonly Vector3[])[] = [],
  /**
   * Draw the distance's own arrow too: an edit has no region arrow, so its
   * distance stands in the middle of the profile, on the face it moves (half
   * way up a symmetric extrude).
   */
  withDistance = false
): HandleSpec[] {
  if (outline.length === 0) return [];
  const n = unit(normal);
  const handles: HandleSpec[] = [];
  const hinge = extrudeDraftHinge(outline, n);
  if (withDistance && state.extent === 'blind') {
    const span = widestInteriorSpan(
      outline,
      n,
      hinge?.foot ?? null,
      hinge?.along,
      holes
    );
    handles.push({
      valueId: 'distance',
      kind: 'linear',
      key: keyOf('distance', key, state.symmetric ? 'symmetric' : 'one-side'),
      params: {
        origin: span ? span.at((span.start + span.end) / 2) : outline[0]!,
        direction: n,
        ...(state.symmetric ? { scale: 0.5 } : {})
      }
    });
  }
  // Nothing has left the sketch yet: there is no back face and no wall, and
  // the region's own arrow is the one thing to drag.
  if (state.extent === 'blind' && !(Math.abs(state.distance) > 0)) {
    return handles;
  }
  const sense = state.distance < 0 ? -1 : 1;
  if (extrudeTakesBackDistance(state)) {
    handles.push({
      valueId: 'backDistance',
      kind: 'linear',
      key: keyOf('back', key, sense),
      params: {
        origin: extrudeBackArrowOrigin(
          outline,
          n,
          hinge?.foot ?? null,
          hinge?.along,
          holes
        ),
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
