import type { SketchObjectData } from '@openzcad/shared';
import type { SketchPoint } from './sketch/session';

const CIRCLE_SEGMENTS = 96;

/** Sampled plane-local polyline for one sketch object; null for unsupported. */
export function objectPolyline(
  data: SketchObjectData,
  resolve: (value: unknown) => number
): { points: SketchPoint[]; closed: boolean } | null {
  switch (data.objectKind) {
    case 'line':
      return {
        points: [
          { x: resolve(data.x1), y: resolve(data.y1) },
          { x: resolve(data.x2), y: resolve(data.y2) }
        ],
        closed: false
      };
    case 'rectangle': {
      const width = resolve(data.width) / 2;
      const height = resolve(data.height) / 2;
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      return {
        points: [
          { x: cx - width, y: cy - height },
          { x: cx + width, y: cy - height },
          { x: cx + width, y: cy + height },
          { x: cx - width, y: cy + height }
        ],
        closed: true
      };
    }
    case 'circle':
    case 'polygon': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const sides =
        data.objectKind === 'polygon'
          ? Math.max(3, Math.round(resolve(data.sides)))
          : CIRCLE_SEGMENTS;
      const phase = data.objectKind === 'polygon' ? Math.PI / 2 : 0;
      const points: SketchPoint[] = [];
      for (let index = 0; index < sides; index += 1) {
        const angle = (index / sides) * Math.PI * 2 + phase;
        points.push({
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius
        });
      }
      return { points, closed: true };
    }
    case 'arc': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const start = (resolve(data.startAngleDeg) * Math.PI) / 180;
      let sweep =
        ((resolve(data.endAngleDeg) - resolve(data.startAngleDeg)) * Math.PI) /
        180;
      if (sweep <= 0) {
        sweep += Math.PI * 2;
      }
      const steps = Math.max(
        8,
        Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SEGMENTS)
      );
      const points: SketchPoint[] = [];
      for (let index = 0; index <= steps; index += 1) {
        const angle = start + (sweep * index) / steps;
        points.push({
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius
        });
      }
      return { points, closed: false };
    }
    case 'text':
      // One glyph outline is not one polyline, and sampling it needs parsed
      // font data this synchronous helper has no access to. The text object's
      // viewport display comes from its expanded regions instead.
      return null;
  }
}
