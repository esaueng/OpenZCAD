import type {
  SketchConstraint,
  SketchDimensionIdentity,
  SketchReferenceDimension,
  SketchDimensionLabelPosition,
  SketchObjectData,
  SketchPointRef
} from '@openzcad/shared';
import {
  resolveSketchReferenceDimension,
  toSketchConstraintId,
  type EntityId
} from '@openzcad/shared';
import { formatNumber } from '../model';
import { boundedArcSweepDegrees } from '@openzcad/geometry';

type Point = { x: number; y: number };
type Resolve = (value: number | string) => number | undefined;

export interface SketchDimensionAnnotation {
  id: string;
  identity?: SketchDimensionIdentity;
  kind: 'distance' | 'angle' | 'radius';
  label: string;
  /** Derived placement before the user's persistent decluttering offset. */
  baseAnchor?: Point;
  /** Plane-local offset from `baseAnchor`; absent storage means zero. */
  labelOffset?: Point;
  anchor: Point;
  span?: { start: Point; end: Point };
  lines: Point[][];
}

/**
 * Plane-local position of one constraint-schema point: a line's start or
 * end, a circle's center, an arc's center or sweep end. Null when the object
 * has no such point or a value does not resolve.
 */
export function sketchPointPosition(
  data: SketchObjectData | undefined,
  pointName: SketchPointRef['point'],
  scalar: (value: number | string) => number | undefined
): Point | null {
  if (!data) return null;
  if (data.objectKind === 'line') {
    if (pointName === 'center') return null;
    const x = scalar(pointName === 'start' ? data.x1 : data.x2);
    const y = scalar(pointName === 'start' ? data.y1 : data.y2);
    return x === undefined || y === undefined ? null : { x, y };
  }
  // I01 solver points, as the constraint tools resolve them: an ellipse by
  // its centre, an open spline by its first and last points.
  if (data.objectKind === 'ellipse') {
    if (pointName !== 'center') return null;
    const x = scalar(data.centerX);
    const y = scalar(data.centerY);
    return x === undefined || y === undefined ? null : { x, y };
  }
  if (data.objectKind === 'spline') {
    if (pointName === 'center' || data.closed === true) return null;
    const point =
      pointName === 'start'
        ? data.points[0]
        : data.points[data.points.length - 1];
    const x = point ? scalar(point.x) : undefined;
    const y = point ? scalar(point.y) : undefined;
    return x === undefined || y === undefined ? null : { x, y };
  }
  if (data.objectKind !== 'circle' && data.objectKind !== 'arc') return null;
  const x = scalar(data.centerX);
  const y = scalar(data.centerY);
  if (x === undefined || y === undefined) return null;
  if (pointName === 'center') return { x, y };
  if (data.objectKind !== 'arc') return null;
  const radius = scalar(data.radius);
  const angle = scalar(
    pointName === 'start' ? data.startAngleDeg : data.endAngleDeg
  );
  if (radius === undefined || radius <= 0 || angle === undefined) return null;
  const radians = (angle * Math.PI) / 180;
  return {
    x: x + radius * Math.cos(radians),
    y: y + radius * Math.sin(radians)
  };
}

/** Layout is derived from document geometry; it never becomes constraint identity. */
export function sketchDimensionAnnotations(
  objects: readonly { id: string; data: SketchObjectData }[],
  constraints: readonly SketchConstraint[],
  resolve: Resolve,
  units: string,
  labelPositions?: Readonly<Record<string, SketchDimensionLabelPosition>>,
  references: readonly SketchReferenceDimension[] = []
): SketchDimensionAnnotation[] {
  const byId = new Map(objects.map((object) => [object.id, object.data]));
  const scalar = (value: number | string): number | undefined => {
    const result = resolve(value);
    return result !== undefined && Number.isFinite(result) ? result : undefined;
  };
  const point = (ref: SketchPointRef): Point | null =>
    sketchPointPosition(byId.get(ref.objectId), ref.point, scalar);
  const format = (raw: number | string, value: number, suffix: string) =>
    `${typeof raw === 'string' ? `${raw} = ` : ''}${formatNumber(value)}${suffix}`;
  const result: SketchDimensionAnnotation[] = [];
  const positioned = (
    annotation: Omit<
      SketchDimensionAnnotation,
      'baseAnchor' | 'labelOffset' | 'anchor'
    > & {
      anchor: Point;
    }
  ): SketchDimensionAnnotation => {
    const baseAnchor = annotation.anchor;
    const stored = labelPositions?.[annotation.id];
    const labelOffset =
      stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
        ? { x: stored.x, y: stored.y }
        : { x: 0, y: 0 };
    return {
      ...annotation,
      identity: annotation.identity ?? {
        kind: 'constraint',
        constraintId: toSketchConstraintId(annotation.id)
      },
      baseAnchor,
      labelOffset,
      anchor: {
        x: baseAnchor.x + labelOffset.x,
        y: baseAnchor.y + labelOffset.y
      }
    };
  };
  for (const constraint of constraints) {
    const data = constraint.data;
    if (data.constraintKind === 'radius') {
      const object = byId.get(data.objectId);
      if (
        !object ||
        (object.objectKind !== 'circle' && object.objectKind !== 'arc')
      )
        continue;
      const center = point({ objectId: data.objectId, point: 'center' });
      const radius = scalar(object.radius);
      const target = scalar(data.value);
      if (
        !center ||
        radius === undefined ||
        radius <= 0 ||
        target === undefined ||
        target <= 0
      )
        continue;
      let angleDeg = 45;
      if (object.objectKind === 'arc') {
        const start = scalar(object.startAngleDeg);
        const end = scalar(object.endAngleDeg);
        if (start === undefined || end === undefined) continue;
        try {
          angleDeg = start + boundedArcSweepDegrees(start, end) / 2;
        } catch {
          continue;
        }
      }
      const angle = (angleDeg * Math.PI) / 180;
      const end = {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      };
      if (!Number.isFinite(end.x) || !Number.isFinite(end.y)) continue;
      result.push(
        positioned({
          id: constraint.constraintId,
          kind: 'radius',
          label: `R ${format(data.value, target, ` ${units}`)}`,
          anchor: {
            x: center.x + (end.x - center.x) * 0.6,
            y: center.y + (end.y - center.y) * 0.6
          },
          span: { start: center, end },
          lines: []
        })
      );
    } else if (data.constraintKind === 'distance') {
      const a = point(data.a);
      const b = point(data.b);
      const target = scalar(data.value);
      if (!a || !b || target === undefined || target <= 0) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length <= 1e-9) continue;
      const offset = length * 0.15;
      const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
      const start = { x: a.x + normal.x * offset, y: a.y + normal.y * offset };
      const end = { x: b.x + normal.x * offset, y: b.y + normal.y * offset };
      result.push(
        positioned({
          id: constraint.constraintId,
          kind: 'distance',
          label: format(data.value, target, ` ${units}`),
          anchor: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
          span: { start, end },
          lines: [
            [a, start],
            [b, end]
          ]
        })
      );
    } else if (data.constraintKind === 'angle') {
      if (
        byId.get(data.a)?.objectKind !== 'line' ||
        byId.get(data.b)?.objectKind !== 'line'
      )
        continue;
      const a = point({ objectId: data.a, point: 'start' });
      const b = point({ objectId: data.a, point: 'end' });
      const c = point({ objectId: data.b, point: 'start' });
      const d = point({ objectId: data.b, point: 'end' });
      const target = scalar(data.valueDeg);
      if (!a || !b || !c || !d || target === undefined) continue;
      const u = { x: b.x - a.x, y: b.y - a.y };
      const v = { x: d.x - c.x, y: d.y - c.y };
      const lengthA = Math.hypot(u.x, u.y);
      const lengthB = Math.hypot(v.x, v.y);
      if (Math.min(lengthA, lengthB) <= 1e-9) continue;
      u.x /= lengthA;
      u.y /= lengthA;
      v.x /= lengthB;
      v.y /= lengthB;
      const cross = u.x * v.y - u.y * v.x;
      const sweep = Math.atan2(cross, u.x * v.x + u.y * v.y);
      // Parallel lines have no finite intersection; use the first line's start.
      const t =
        Math.abs(cross) > 1e-6
          ? ((c.x - a.x) * v.y - (c.y - a.y) * v.x) / cross
          : 0;
      const center = { x: a.x + t * u.x, y: a.y + t * u.y };
      const radius = Math.min(lengthA, lengthB) * 0.3;
      const startAngle = Math.atan2(u.y, u.x);
      const at = (angle: number): Point => ({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      });
      const arc = Array.from({ length: 33 }, (_, index) =>
        at(startAngle + (sweep * index) / 32)
      );
      result.push(
        positioned({
          id: constraint.constraintId,
          kind: 'angle',
          label: format(data.valueDeg, target, '°'),
          anchor: at(startAngle + sweep / 2),
          lines: [[center, arc[0]!], arc, [center, arc[32]!]]
        })
      );
    }
  }
  for (const reference of references) {
    const outcome = resolveSketchReferenceDimension(
      byId as Map<EntityId, SketchObjectData>,
      reference,
      scalar
    );
    if (outcome.status !== 'current') continue; // The palette retains the named unresolved row.
    const base = {
      id: String(reference.annotationId),
      identity: {
        kind: 'reference' as const,
        annotationId: reference.annotationId
      },
      kind: outcome.dimensionKind
    };
    if (outcome.dimensionKind === 'distance') {
      const { a, b, value } = outcome;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const shift = { x: -(b.y - a.y) * 0.15, y: (b.x - a.x) * 0.15 };
      const start = { x: a.x + shift.x, y: a.y + shift.y };
      const end = { x: b.x + shift.x, y: b.y + shift.y };
      result.push(
        positioned({
          ...base,
          label: `(${formatNumber(value)} ${units === 'inch' ? 'in' : units})`,
          anchor: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
          ...(length > 1e-9 ? { span: { start, end } } : {}),
          lines:
            length > 1e-9
              ? [
                  [a, start],
                  [b, end]
                ]
              : []
        })
      );
    } else if (outcome.dimensionKind === 'radius') {
      const { center, radius } = outcome;
      const object =
        reference.data.dimensionKind === 'radius'
          ? byId.get(reference.data.objectId)
          : undefined;
      let angle = Math.PI / 4;
      if (object?.objectKind === 'arc') {
        const start = scalar(object.startAngleDeg);
        const end = scalar(object.endAngleDeg);
        if (start === undefined || end === undefined) continue;
        try {
          angle =
            ((start + boundedArcSweepDegrees(start, end) / 2) * Math.PI) / 180;
        } catch {
          continue;
        }
      }
      const end = {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      };
      result.push(
        positioned({
          ...base,
          label: `(R ${formatNumber(radius)} ${units === 'inch' ? 'in' : units})`,
          anchor: {
            x: center.x + (end.x - center.x) * 0.6,
            y: center.y + (end.y - center.y) * 0.6
          },
          span: { start: center, end },
          lines: []
        })
      );
    } else {
      const { a, b, c, d } = outcome;
      const lengthA = Math.hypot(b.x - a.x, b.y - a.y);
      const lengthB = Math.hypot(d.x - c.x, d.y - c.y);
      const u = { x: (b.x - a.x) / lengthA, y: (b.y - a.y) / lengthA };
      const v = { x: (d.x - c.x) / lengthB, y: (d.y - c.y) / lengthB };
      const cross = u.x * v.y - u.y * v.x;
      const sweep = Math.atan2(cross, u.x * v.x + u.y * v.y);
      const t =
        Math.abs(cross) > 1e-6
          ? ((c.x - a.x) * v.y - (c.y - a.y) * v.x) / cross
          : 0;
      const center = { x: a.x + t * u.x, y: a.y + t * u.y };
      const radius = Math.min(lengthA, lengthB) * 0.3;
      const startAngle = Math.atan2(u.y, u.x);
      const at = (angle: number) => ({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      });
      const arc = Array.from({ length: 33 }, (_, i) =>
        at(startAngle + (sweep * i) / 32)
      );
      result.push(
        positioned({
          ...base,
          label: `(${formatNumber(outcome.valueDeg)}°)`,
          anchor: at(startAngle + sweep / 2),
          lines: [[center, arc[0]!], arc, [center, arc[32]!]]
        })
      );
    }
  }
  return result;
}
