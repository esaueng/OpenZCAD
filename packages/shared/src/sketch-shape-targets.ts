import type { EntityId, ParamValue, SketchObjectData } from './index';
import { MAX_SKETCH_POLYGON_SIDES } from './index';

/**
 * S02-D (schema v125): reference targets on a legacy parametric rectangle or
 * regular polygon, measured where it stands without converting it.
 *
 * Corners and sides keep the order the region and boundary-provenance
 * contracts already use (S04-C `b1/.../e/<index>` tokens): a rectangle's
 * corner 0 is its lower-left corner, counter-clockwise; a polygon's corner 0
 * is its top vertex, counter-clockwise. Side `i` runs from corner `i` to
 * corner `i + 1`. `count` is a witness of the shape's side count when the
 * target was made: a polygon whose count no longer matches is unresolved by
 * name, never re-indexed onto a different vertex.
 */
export interface SketchShapeCornerTarget {
  kind: 'shape-corner';
  objectId: EntityId;
  /** Zero-based; never wrapped or clamped. */
  index: number;
  count: number;
}

export interface SketchShapeSideTarget {
  kind: 'shape-side';
  objectId: EntityId;
  /** Zero-based; never wrapped or clamped. */
  index: number;
  count: number;
}

export interface SketchShapeCenterTarget {
  kind: 'shape-center';
  objectId: EntityId;
}

export type SketchShapeTarget =
  SketchShapeCornerTarget | SketchShapeSideTarget | SketchShapeCenterTarget;

export interface SketchShapePoint {
  x: number;
  y: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndexed(
  value: unknown,
  kind: 'shape-corner' | 'shape-side'
): boolean {
  return (
    isRecord(value) &&
    value.kind === kind &&
    typeof value.objectId === 'string' &&
    value.objectId.length > 0 &&
    Number.isInteger(value.count) &&
    (value.count as number) >= 3 &&
    (value.count as number) <= MAX_SKETCH_POLYGON_SIDES &&
    Number.isInteger(value.index) &&
    (value.index as number) >= 0 &&
    (value.index as number) < (value.count as number) &&
    Object.keys(value).length === 4
  );
}

export function isSketchShapeCornerTarget(
  value: unknown
): value is SketchShapeCornerTarget {
  return isIndexed(value, 'shape-corner');
}

export function isSketchShapeSideTarget(
  value: unknown
): value is SketchShapeSideTarget {
  return isIndexed(value, 'shape-side');
}

export function isSketchShapeCenterTarget(
  value: unknown
): value is SketchShapeCenterTarget {
  return (
    isRecord(value) &&
    value.kind === 'shape-center' &&
    typeof value.objectId === 'string' &&
    value.objectId.length > 0 &&
    Object.keys(value).length === 2
  );
}

export function isSketchShapeTarget(
  value: unknown
): value is SketchShapeTarget {
  return (
    isSketchShapeCornerTarget(value) ||
    isSketchShapeSideTarget(value) ||
    isSketchShapeCenterTarget(value)
  );
}

type Resolve = (value: ParamValue) => number | undefined;

type ShapeResolution =
  | {
      status: 'resolved';
      corners: SketchShapePoint[];
      center: SketchShapePoint;
    }
  | { status: 'unresolved'; reason: string };

function finite(resolve: Resolve, value: ParamValue): number | undefined {
  try {
    const result = resolve(value);
    return typeof result === 'number' && Number.isFinite(result)
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

/** The side count a legacy shape has now, or a reason it has none. */
export function sketchShapeSideCount(
  data: SketchObjectData,
  resolve: Resolve
): number | string {
  if (data.objectKind === 'rectangle') return 4;
  if (data.objectKind !== 'polygon')
    return `a ${data.objectKind} is not a rectangle or regular polygon.`;
  const sides = finite(resolve, data.sides);
  return sides !== undefined &&
    Number.isInteger(sides) &&
    sides >= 3 &&
    sides <= MAX_SKETCH_POLYGON_SIDES
    ? sides
    : `the polygon needs an integer side count from 3 to ${MAX_SKETCH_POLYGON_SIDES}.`;
}

/** Corners in the region builder's order, from the shape's own parameters. */
function resolveShape(
  data: SketchObjectData,
  resolve: Resolve
): ShapeResolution {
  const count = sketchShapeSideCount(data, resolve);
  if (typeof count === 'string') return { status: 'unresolved', reason: count };
  if (data.objectKind !== 'rectangle' && data.objectKind !== 'polygon')
    return { status: 'unresolved', reason: 'it is not a legacy shape.' };
  const cx = finite(resolve, data.centerX);
  const cy = finite(resolve, data.centerY);
  if (cx === undefined || cy === undefined)
    return {
      status: 'unresolved',
      reason: 'its centre expression could not be resolved.'
    };
  const center = { x: cx, y: cy };
  if (data.objectKind === 'rectangle') {
    const width = finite(resolve, data.width);
    const height = finite(resolve, data.height);
    if (width === undefined || height === undefined)
      return {
        status: 'unresolved',
        reason: 'its width or height expression could not be resolved.'
      };
    const x = width / 2;
    const y = height / 2;
    return {
      status: 'resolved',
      center,
      corners: [
        { x: cx - x, y: cy - y },
        { x: cx + x, y: cy - y },
        { x: cx + x, y: cy + y },
        { x: cx - x, y: cy + y }
      ]
    };
  }
  const radius = finite(resolve, data.radius);
  if (radius === undefined)
    return {
      status: 'unresolved',
      reason: 'its radius expression could not be resolved.'
    };
  const corners: SketchShapePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    // Same top-first orientation as the region builder.
    const angle = (i / count) * Math.PI * 2 + Math.PI / 2;
    corners.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    });
  }
  return { status: 'resolved', center, corners };
}

function noun(target: SketchShapeTarget): string {
  return target.kind === 'shape-center'
    ? 'centre'
    : `${target.kind === 'shape-corner' ? 'corner' : 'side'} ${target.index + 1}`;
}

/** Structural qualification: the object exists, is a legacy shape and keeps its count. */
export function qualifySketchShapeTarget(
  target: SketchShapeTarget,
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve?: Resolve
): { status: 'resolved' } | { status: 'unresolved'; reason: string } {
  const fail = (detail: string) => ({
    status: 'unresolved' as const,
    reason: `Shape "${isRecord(target) && typeof target.objectId === 'string' ? target.objectId : 'unknown'}" ${isSketchShapeTarget(target) ? noun(target) : 'target'}: ${detail}`
  });
  if (!isSketchShapeTarget(target))
    return fail('the saved target descriptor is malformed.');
  const data = objects.get(target.objectId);
  if (!data) return fail('it is not part of this sketch.');
  if (data.objectKind !== 'rectangle' && data.objectKind !== 'polygon')
    return fail(
      `a ${data.objectKind} is not a legacy rectangle or regular polygon.`
    );
  if (target.kind === 'shape-center') return { status: 'resolved' };
  if (data.objectKind === 'rectangle') {
    return target.count === 4
      ? { status: 'resolved' }
      : fail('a rectangle has 4 sides; the saved side count differs.');
  }
  if (!resolve) return { status: 'resolved' };
  const count = sketchShapeSideCount(data, resolve);
  if (typeof count === 'string') return fail(count);
  return count === target.count
    ? { status: 'resolved' }
    : fail(
        `the polygon now has ${count} sides, not ${target.count}. Re-create the reference explicitly.`
      );
}

export type SketchShapePointResolution =
  | { status: 'resolved'; point: SketchShapePoint }
  | { status: 'unresolved'; reason: string };

export type SketchShapeSideResolution =
  | { status: 'resolved'; start: SketchShapePoint; end: SketchShapePoint }
  | { status: 'unresolved'; reason: string };

/** A legacy shape's corner or centre, measured from its current parameters. */
export function resolveSketchShapePointTarget(
  target: SketchShapeCornerTarget | SketchShapeCenterTarget,
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: Resolve
): SketchShapePointResolution {
  const qualified = qualifySketchShapeTarget(target, objects, resolve);
  if (qualified.status === 'unresolved') return qualified;
  const shape = resolveShape(objects.get(target.objectId)!, resolve);
  if (shape.status === 'unresolved')
    return {
      status: 'unresolved',
      reason: `Shape "${target.objectId}" ${noun(target)}: ${shape.reason}`
    };
  return {
    status: 'resolved',
    point:
      target.kind === 'shape-center'
        ? shape.center
        : shape.corners[target.index]!
  };
}

/** A legacy shape's side, from corner `index` to corner `index + 1`. */
export function resolveSketchShapeSideTarget(
  target: SketchShapeSideTarget,
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: Resolve
): SketchShapeSideResolution {
  const qualified = qualifySketchShapeTarget(target, objects, resolve);
  if (qualified.status === 'unresolved') return qualified;
  const shape = resolveShape(objects.get(target.objectId)!, resolve);
  if (shape.status === 'unresolved')
    return {
      status: 'unresolved',
      reason: `Shape "${target.objectId}" ${noun(target)}: ${shape.reason}`
    };
  return {
    status: 'resolved',
    start: shape.corners[target.index]!,
    end: shape.corners[(target.index + 1) % shape.corners.length]!
  };
}

/** Every target a legacy shape offers now, in corner/side order. */
export function sketchShapeTargets(
  objectId: EntityId,
  data: SketchObjectData,
  resolve: Resolve
): {
  corners: SketchShapeCornerTarget[];
  sides: SketchShapeSideTarget[];
  center: SketchShapeCenterTarget;
} | null {
  const count = sketchShapeSideCount(data, resolve);
  if (typeof count === 'string') return null;
  const indices = Array.from({ length: count }, (_, index) => index);
  return {
    corners: indices.map((index) => ({
      kind: 'shape-corner',
      objectId,
      index,
      count
    })),
    sides: indices.map((index) => ({
      kind: 'shape-side',
      objectId,
      index,
      count
    })),
    center: { kind: 'shape-center', objectId }
  };
}
