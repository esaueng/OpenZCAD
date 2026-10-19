import type { ThroughAllSide } from '@openzcad/shared';

type Vec3 = { x: number; y: number; z: number };

export interface ThroughAllSpan {
  readonly forward: number;
  readonly backward: number;
}

/** The eight corners of a kernel AABB `[minX, minY, minZ, maxX, maxY, maxZ]`. */
function corners(bounds: readonly number[]): Vec3[] {
  return [0, 1].flatMap((x) =>
    [0, 1].flatMap((y) =>
      [0, 1].map((z) => ({
        x: bounds[x * 3]!,
        y: bounds[y * 3 + 1]!,
        z: bounds[z * 3 + 2]!
      }))
    )
  );
}

/**
 * F01: a through-all extent is a support-function query, not a guessed depth.
 * The target's world AABB is conservative for transformed solids, and the
 * eight-corner projection bounds every target point along the requested unit
 * sketch normal, so the tool is finite yet provably spans the whole target.
 * See docs/plans/f01-through-all-qualification.md.
 */
export function throughAllSpan(
  bounds: readonly number[],
  planePoint: Vec3,
  direction: Vec3,
  side: ThroughAllSide
): ThroughAllSpan {
  if (side !== 'forward' && side !== 'backward' && side !== 'both') {
    throw new Error(`Unknown through-all side ${JSON.stringify(side)}.`);
  }
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (!(magnitude > 1e-12) || !Number.isFinite(magnitude)) {
    throw new Error('Through-all direction must be finite and non-zero.');
  }
  if (bounds.length !== 6 || !bounds.every(Number.isFinite)) {
    throw new Error('Through-all target has no finite bounds.');
  }
  const unit = {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
    z: direction.z / magnitude
  };
  const projections = corners(bounds).map(
    (point) =>
      (point.x - planePoint.x) * unit.x +
      (point.y - planePoint.y) * unit.y +
      (point.z - planePoint.z) * unit.z
  );
  const forward = Math.max(0, Math.max(...projections));
  const backward = Math.max(0, -Math.min(...projections));
  if (side === 'forward' && !(forward > 1e-9)) {
    throw new Error('Through-all has no target in the selected direction.');
  }
  if (side === 'backward' && !(backward > 1e-9)) {
    throw new Error('Through-all has no target in the selected direction.');
  }
  if (side === 'both' && !(forward > 1e-9 || backward > 1e-9)) {
    throw new Error('Through-all has no target on either side.');
  }
  return {
    forward: side === 'backward' ? 0 : forward,
    backward: side === 'forward' ? 0 : backward
  };
}

/** The union AABB of several kernel AABBs. */
export function unionBounds(boxes: readonly ArrayLike<number>[]): number[] {
  if (boxes.length === 0) {
    throw new Error('Through-all target has no solids.');
  }
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      out[axis] = Math.min(out[axis]!, box[axis]!);
      out[axis + 3] = Math.max(out[axis + 3]!, box[axis + 3]!);
    }
  }
  return out;
}
