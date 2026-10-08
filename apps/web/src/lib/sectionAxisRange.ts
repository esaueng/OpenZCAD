import type { GeometryBodyRepresentation } from '@openzcad/shared';
import type { SectionPlaneId } from '@openzcad/viewport';

/** The section slider and initial plane follow the bodies displayed now. */
export function sectionAxisRangeForBodies(
  plane: SectionPlaneId,
  bodies: readonly Pick<GeometryBodyRepresentation, 'bbox' | 'consumed'>[]
): { min: number; max: number } | null {
  const axis = plane === 'XY' ? 'z' : plane === 'XZ' ? 'y' : 'x';
  let min = Infinity;
  let max = -Infinity;
  for (const body of bodies) {
    if (body.consumed) continue;
    min = Math.min(min, body.bbox.min[axis]);
    max = Math.max(max, body.bbox.max[axis]);
  }
  return min < max ? { min, max } : null;
}
