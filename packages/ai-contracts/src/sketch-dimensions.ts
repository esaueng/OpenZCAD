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
  ellipse: [
    'centerX',
    'centerY',
    'radiusX',
    'radiusY',
    'rotationDeg',
    'startParamDeg',
    'endParamDeg'
  ],
  // Spline points are a list, not named fields; nothing here addresses them.
  spline: [],
  text: ['size', 'x', 'y', 'rotation']
};

export function isSketchDimensionField(
  kind: SketchObjectData['objectKind'],
  field: string
): boolean {
  return SKETCH_DIMENSION_FIELDS[kind].includes(field);
}

/**
 * Whether one stored object exposes `field` as an editable dimension. An
 * elliptical arc's range is a pair that only an existing arc carries:
 * writing one end onto a full ellipse would leave half a pair, which every
 * rebuild refuses, so neither end is editable there.
 */
export function sketchObjectExposesDimension(
  object: { objectKind?: unknown } & Record<string, unknown>,
  field: string
): boolean {
  const kind = object.objectKind;
  if (
    typeof kind !== 'string' ||
    !(kind in SKETCH_DIMENSION_FIELDS) ||
    !isSketchDimensionField(kind as SketchObjectData['objectKind'], field)
  ) {
    return false;
  }
  if (field === 'startParamDeg' || field === 'endParamDeg') {
    return (
      object.startParamDeg !== undefined && object.endParamDeg !== undefined
    );
  }
  return true;
}
