import { MAX_SKETCH_POLYGON_SIDES } from './index';
import type {
  EntityId,
  ParamValue,
  SketchComposite,
  SketchCompositeId,
  SketchNode,
  SketchObjectData,
  SketchPointRef
} from './index';

/**
 * S04 composite identity — the pure, command-free half shared by the
 * document, the solver evidence and the viewport. See `SketchComposite` for
 * the contract: sides in counter-clockwise order, corner `i` the start of
 * side `i`, identity by index and never by coordinate.
 */

/** Creates a stable composite id; replayed verbatim, never derived from geometry. */
export function createSketchCompositeId(): SketchCompositeId {
  return `scmp_${crypto.randomUUID()}` as SketchCompositeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

/** The side counts a composite of `kind` may have. */
export function sketchCompositeSideRange(
  kind: SketchComposite['compositeKind']
): { min: number; max: number } {
  return kind === 'rectangle'
    ? { min: 4, max: 4 }
    : { min: 3, max: MAX_SKETCH_POLYGON_SIDES };
}

/**
 * Shape-only check of a saved record: a known kind and method, an owned id,
 * a side count the kind allows and no member named twice. Whether the
 * members still exist is the resolver's question, not this one's, so a
 * record whose lines were edited stays loadable and reports itself broken.
 */
export function isSketchComposite(value: unknown): value is SketchComposite {
  if (!isRecord(value)) return false;
  const { compositeId, compositeKind, method, edgeIds, helperIds } = value;
  if (typeof compositeId !== 'string' || !compositeId.startsWith('scmp_')) {
    return false;
  }
  const methodOk =
    compositeKind === 'rectangle'
      ? method === 'corner' || method === 'center' || method === 'three-point'
      : compositeKind === 'polygon'
        ? method === 'inscribed'
        : false;
  if (!methodOk || !isIdList(edgeIds)) return false;
  if (helperIds !== undefined && !isIdList(helperIds)) return false;
  const range = sketchCompositeSideRange(compositeKind as 'rectangle');
  if (edgeIds.length < range.min || edgeIds.length > range.max) return false;
  const members = [...edgeIds, ...(helperIds ?? [])];
  if (new Set(members).size !== members.length) return false;
  const known = new Set([
    'compositeId',
    'compositeKind',
    'method',
    'edgeIds',
    'helperIds'
  ]);
  return Object.keys(value).every((key) => known.has(key));
}

/** Every object the composite owns: its sides, then its helpers. */
export function sketchCompositeMemberIds(
  composite: SketchComposite
): EntityId[] {
  return [...composite.edgeIds, ...(composite.helperIds ?? [])];
}

/** The composite on `sketch` that owns `objectId`, if any. */
export function sketchCompositeOf(
  sketch: Pick<SketchNode, 'composites'>,
  objectId: string
): SketchComposite | null {
  return (
    sketch.composites?.find((composite) =>
      sketchCompositeMemberIds(composite).includes(objectId as EntityId)
    ) ?? null
  );
}

/** Corner `index` as a constraint point: the start of side `index`. */
export function sketchCompositeCornerRef(
  composite: SketchComposite,
  index: number
): SketchPointRef {
  const count = composite.edgeIds.length;
  const side = composite.edgeIds[((index % count) + count) % count]!;
  return { objectId: side, point: 'start' };
}

export interface SketchCompositePoint {
  x: number;
  y: number;
}

export type SketchCompositeResolution =
  | {
      status: 'resolved';
      /** Corner `i` is the start of side `i`. */
      corners: SketchCompositePoint[];
      /** The centroid of the corners: a rectangle's or regular polygon's centre. */
      center: SketchCompositePoint;
    }
  | { status: 'broken'; reason: string };

/**
 * The composite's corners from its current lines. Refuses by name, never by
 * guessing, when a side is missing or no longer a line, or when the sides no
 * longer close corner to corner (a trim or a free edit opened the loop).
 */
export function resolveSketchComposite(
  composite: SketchComposite,
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: (value: ParamValue) => number | undefined,
  tolerance = 1e-6
): SketchCompositeResolution {
  const ends: [SketchCompositePoint, SketchCompositePoint][] = [];
  for (const [index, edgeId] of composite.edgeIds.entries()) {
    const data = objects.get(edgeId);
    if (!data || data.objectKind !== 'line') {
      return {
        status: 'broken',
        reason: `Side ${index + 1} of the ${composite.compositeKind} is no longer a line.`
      };
    }
    const values = [data.x1, data.y1, data.x2, data.y2].map(resolve);
    if (
      values.some((value) => value === undefined || !Number.isFinite(value))
    ) {
      return {
        status: 'broken',
        reason: `Side ${index + 1} of the ${composite.compositeKind} does not resolve.`
      };
    }
    const [x1, y1, x2, y2] = values as number[];
    ends.push([
      { x: x1!, y: y1! },
      { x: x2!, y: y2! }
    ]);
  }
  for (const [index, [, end]] of ends.entries()) {
    const next = ends[(index + 1) % ends.length]![0];
    if (Math.hypot(end.x - next.x, end.y - next.y) > tolerance) {
      return {
        status: 'broken',
        reason: `The ${composite.compositeKind}'s sides no longer meet at corner ${((index + 1) % ends.length) + 1}.`
      };
    }
  }
  const corners = ends.map(([start]) => start);
  const center = {
    x: corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length,
    y: corners.reduce((sum, corner) => sum + corner.y, 0) / corners.length
  };
  const lapse = shapeLapse(composite, corners, center, objects, resolve);
  return lapse
    ? { status: 'broken', reason: lapse }
    : { status: 'resolved', corners, center };
}

/**
 * Why the closed loop is no longer the shape its record names, or null.
 * Closure alone is not enough: with its relations deleted, a rectangle can
 * be dragged into any quadrilateral and a polygon into any loop, and a card
 * that resizes it as a rectangle or by circumradius would misdescribe it.
 * Tolerances are relative to the shape's size.
 */
function shapeLapse(
  composite: SketchComposite,
  corners: SketchCompositePoint[],
  center: SketchCompositePoint,
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: (value: ParamValue) => number | undefined
): string | null {
  const count = corners.length;
  const sides = corners.map((corner, index) => {
    const next = corners[(index + 1) % count]!;
    return { x: next.x - corner.x, y: next.y - corner.y };
  });
  const lengths = sides.map((side) => Math.hypot(side.x, side.y));
  const scale = Math.max(...lengths);
  const slack = Math.max(scale * 1e-6, 1e-9);
  const kind = composite.compositeKind;
  if (lengths.some((length) => length <= slack)) {
    return `A side of the ${kind} has collapsed.`;
  }
  if (kind === 'rectangle') {
    for (let index = 0; index < count; index += 1) {
      const a = sides[index]!;
      const b = sides[(index + 1) % count]!;
      if (
        Math.abs(a.x * b.x + a.y * b.y) / lengths[(index + 1) % count]! >
        slack
      ) {
        return `The rectangle's corner ${((index + 1) % count) + 1} is no longer square.`;
      }
    }
    if (
      composite.method !== 'three-point' &&
      (Math.abs(sides[0]!.y) > slack || Math.abs(sides[1]!.x) > slack)
    ) {
      return 'The rectangle is no longer axis-aligned.';
    }
    return null;
  }
  if (lengths.some((length) => Math.abs(length - lengths[0]!) > slack)) {
    return 'The polygon’s sides are no longer equal.';
  }
  const circle = objects.get(composite.helperIds?.[0] ?? '');
  if (circle?.objectKind !== 'circle') {
    return 'The polygon’s circumcircle is missing.';
  }
  const [cx, cy, radius] = [circle.centerX, circle.centerY, circle.radius].map(
    resolve
  );
  if (
    cx === undefined ||
    cy === undefined ||
    radius === undefined ||
    Math.hypot(cx - center.x, cy - center.y) > slack ||
    corners.some(
      (corner) =>
        Math.abs(Math.hypot(corner.x - cx, corner.y - cy) - radius) > slack
    )
  ) {
    return 'The polygon’s vertices are no longer on its circumcircle.';
  }
  // Equal chords on one circle still admit a star: a pentagram's sides are
  // equal and its vertices sit on the circle. Only the walk to the next
  // vertex round the circle has the chord 2r·sin(π/n); a star skips some.
  if (
    lengths.some(
      (length) =>
        Math.abs(length - 2 * radius * Math.sin(Math.PI / count)) > slack
    )
  ) {
    return 'The polygon’s sides no longer run round its circumcircle in order.';
  }
  return null;
}
