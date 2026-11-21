/**
 * S02-D (schema v126): the sketch's own datum as a reference target. The
 * origin and the X/Y axes are fixed in the sketch-local frame (the frame a
 * datum-backed sketch takes from its datum plane), so a reference to them
 * measures in that frame and never depends on an object. They carry no
 * coordinates: identity is the kind and axis alone.
 */
export interface SketchOriginTarget {
  kind: 'sketch-origin';
}

export interface SketchAxisTarget {
  kind: 'sketch-axis';
  axis: 'x' | 'y';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSketchOriginTarget(
  value: unknown
): value is SketchOriginTarget {
  return (
    isRecord(value) &&
    value.kind === 'sketch-origin' &&
    Object.keys(value).length === 1
  );
}

export function isSketchAxisTarget(value: unknown): value is SketchAxisTarget {
  return (
    isRecord(value) &&
    value.kind === 'sketch-axis' &&
    (value.axis === 'x' || value.axis === 'y') &&
    Object.keys(value).length === 2
  );
}

export function isSketchDatumTarget(
  value: unknown
): value is SketchOriginTarget | SketchAxisTarget {
  return isSketchOriginTarget(value) || isSketchAxisTarget(value);
}

/** The axis as a unit segment from the origin, in sketch-local coordinates. */
export function sketchAxisSegment(axis: SketchAxisTarget['axis']): {
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  return {
    start: { x: 0, y: 0 },
    end: axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 }
  };
}
