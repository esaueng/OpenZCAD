import type { SketchObjectData } from '@openzcad/shared';

export const SKETCH_DIMENSION_FIELDS: Record<
  SketchObjectData['objectKind'],
  readonly string[]
> = {
  rectangle: ['width', 'height', 'centerX', 'centerY'],
  circle: ['radius', 'centerX', 'centerY'],
  polygon: ['sides', 'radius', 'centerX', 'centerY'],
  line: ['x1', 'y1', 'x2', 'y2'],
  arc: ['centerX', 'centerY', 'radius', 'startAngleDeg', 'endAngleDeg'],
  text: ['size', 'x', 'y', 'rotation']
};

export function isSketchDimensionField(
  kind: SketchObjectData['objectKind'],
  field: string
): boolean {
  return SKETCH_DIMENSION_FIELDS[kind].includes(field);
}
