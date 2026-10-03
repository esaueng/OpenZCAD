import type { BodyId, BodyRepresentation, BoundingBox } from '@openzcad/shared';

/**
 * One committed change to frame for: the body projections from before the
 * command and the exact ones its rebuild published. Built by the workspace on
 * a local commit, never for a preview, an undo, or someone else's edit.
 */
export interface AutoFrameRequest {
  before: Readonly<Record<string, BodyRepresentation>>;
  after: Readonly<Record<string, BodyRepresentation>>;
}

function contains(
  outer: BoundingBox,
  inner: BoundingBox,
  tolerance: number
): boolean {
  return (['x', 'y', 'z'] as const).every(
    (axis) =>
      inner.min[axis] >= outer.min[axis] - tolerance &&
      inner.max[axis] <= outer.max[axis] + tolerance
  );
}

/**
 * The live bodies a commit put somewhere new: created by it, or reaching past
 * the box they filled before (grown, or moved). Only these are worth moving
 * the camera for. A body that kept or shrank its bounds is still wherever the
 * user had it framed, and a consumed one is not drawn at all.
 *
 * The tolerance is relative to the body's size, so a rebuild's float noise on
 * an unchanged body never reads as growth.
 */
export function bodiesReachingNewSpace(
  before: Readonly<Record<string, BodyRepresentation>>,
  after: Readonly<Record<string, BodyRepresentation>>
): BodyId[] {
  return Object.values(after).flatMap((body) => {
    if (body.consumed) {
      return [];
    }
    const previous = before[body.bodyId];
    if (!previous || previous.consumed) {
      return [body.bodyId];
    }
    const { min, max } = body.bbox;
    const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1e-9);
    return contains(previous.bbox, body.bbox, size * 1e-6) ? [] : [body.bodyId];
  });
}
