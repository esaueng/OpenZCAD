import {
  boundedArcSweepDegrees,
  boundedPolygonSides,
  textDisplayLoops
} from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import type { SketchPoint } from './sketch/session';

const CIRCLE_SEGMENTS = 96;

export interface SketchObjectPolyline {
  points: SketchPoint[];
  closed: boolean;
}

/**
 * Plane-local display polylines for one sketch object.
 *
 * Most objects are a single open or closed run. Text is not: a string is many
 * disconnected regions, each an outer boundary plus counters, so the plural
 * shape is the general one. An empty array means "nothing to draw" — an
 * unsupported object, or text whose font has not finished loading.
 */
export function objectPolylines(
  data: SketchObjectData,
  resolve: (value: unknown) => number
): SketchObjectPolyline[] {
  switch (data.objectKind) {
    case 'line':
      return [
        {
          points: [
            { x: resolve(data.x1), y: resolve(data.y1) },
            { x: resolve(data.x2), y: resolve(data.y2) }
          ],
          closed: false
        }
      ];
    case 'rectangle': {
      const width = resolve(data.width) / 2;
      const height = resolve(data.height) / 2;
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      return [
        {
          points: [
            { x: cx - width, y: cy - height },
            { x: cx + width, y: cy - height },
            { x: cx + width, y: cy + height },
            { x: cx - width, y: cy + height }
          ],
          closed: true
        }
      ];
    }
    case 'circle':
    case 'polygon': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const sides =
        data.objectKind === 'polygon'
          ? boundedPolygonSides(resolve(data.sides))
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
      return [{ points, closed: true }];
    }
    case 'arc': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const startDegrees = resolve(data.startAngleDeg);
      const endDegrees = resolve(data.endAngleDeg);
      const start = (startDegrees * Math.PI) / 180;
      const sweep =
        (boundedArcSweepDegrees(startDegrees, endDegrees) * Math.PI) / 180;
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
      return [{ points, closed: false }];
    }
    case 'text': {
      // Display only, at a coarser tolerance than the kernel path — the solid
      // is built from the exact beziers, never from these points. The font
      // provider answers from already-parsed faces and never blocks, so a
      // face that has not loaded yet draws nothing this frame rather than
      // stalling the viewport.
      const loops = textDisplayLoops({
        text: data.text,
        fontFamily: data.fontFamily,
        fontStyle: data.fontStyle,
        size: resolve(data.size),
        x: resolve(data.x),
        y: resolve(data.y),
        rotationDeg: data.rotation === undefined ? 0 : resolve(data.rotation),
        align: data.align
      });
      return (loops ?? []).map((loop) => ({
        points: loop.map((point) => ({ x: point.x, y: point.y })),
        closed: true
      }));
    }
  }
}
