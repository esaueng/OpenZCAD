import type {
  SketchConstraint,
  SketchObjectData,
  SketchPointRef
} from '@openzcad/shared';
import { formatNumber } from '../model';
import { boundedArcSweepDegrees } from '@openzcad/geometry';

type Point = { x: number; y: number };
type Resolve = (value: number | string) => number | undefined;

export interface SketchDimensionAnnotation {
  id: string;
  kind: 'distance' | 'angle' | 'radius';
  label: string;
  anchor: Point;
  span?: { start: Point; end: Point };
  lines: Point[][];
}

/** Layout is derived from document geometry; it never becomes constraint identity. */
export function sketchDimensionAnnotations(
  objects: readonly { id: string; data: SketchObjectData }[],
  constraints: readonly SketchConstraint[],
  resolve: Resolve,
  units: string
): SketchDimensionAnnotation[] {
  const byId = new Map(objects.map((object) => [object.id, object.data]));
  const scalar = (value: number | string): number | undefined => {
    const result = resolve(value);
    return result !== undefined && Number.isFinite(result) ? result : undefined;
  };
  const point = (ref: SketchPointRef): Point | null => {
    const data = byId.get(ref.objectId);
    if (!data) return null;
    if (data.objectKind === 'line') {
      if (ref.point === 'center') return null;
      const x = scalar(ref.point === 'start' ? data.x1 : data.x2);
      const y = scalar(ref.point === 'start' ? data.y1 : data.y2);
      return x === undefined || y === undefined ? null : { x, y };
    }
    if (data.objectKind !== 'circle' && data.objectKind !== 'arc') return null;
    const x = scalar(data.centerX);
    const y = scalar(data.centerY);
    if (x === undefined || y === undefined) return null;
    if (ref.point === 'center') return { x, y };
    if (data.objectKind !== 'arc') return null;
    const radius = scalar(data.radius);
    const angle = scalar(
      ref.point === 'start' ? data.startAngleDeg : data.endAngleDeg
    );
    if (radius === undefined || radius <= 0 || angle === undefined) return null;
    const radians = (angle * Math.PI) / 180;
    return {
      x: x + radius * Math.cos(radians),
      y: y + radius * Math.sin(radians)
    };
  };
  const format = (raw: number | string, value: number, suffix: string) =>
    `${typeof raw === 'string' ? `${raw} = ` : ''}${formatNumber(value)}${suffix}`;
  const result: SketchDimensionAnnotation[] = [];
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
      result.push({
        id: constraint.constraintId,
        kind: 'radius',
        label: `R ${format(data.value, target, ` ${units}`)}`,
        anchor: {
          x: center.x + (end.x - center.x) * 0.6,
          y: center.y + (end.y - center.y) * 0.6
        },
        span: { start: center, end },
        lines: []
      });
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
      result.push({
        id: constraint.constraintId,
        kind: 'distance',
        label: format(data.value, target, ` ${units}`),
        anchor: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        span: { start, end },
        lines: [
          [a, start],
          [b, end]
        ]
      });
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
      result.push({
        id: constraint.constraintId,
        kind: 'angle',
        label: format(data.valueDeg, target, '°'),
        anchor: at(startAngle + sweep / 2),
        lines: [[center, arc[0]!], arc, [center, arc[32]!]]
      });
    }
  }
  return result;
}
