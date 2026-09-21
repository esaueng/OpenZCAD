import { afterEach, describe, expect, it } from 'vitest';

import { RemusKernel } from './remus-runtime';

type Vec3 = { x: number; y: number; z: number };

type ThroughAllSide = 'forward' | 'backward' | 'both';

interface ThroughAllSpan {
  readonly forward: number;
  readonly backward: number;
}

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
 * A through-all extent is a support-function query, not a guessed depth.
 * The target's world AABB is conservative for transformed solids, and the
 * eight-corner projection bounds every target point along the requested
 * unit sketch normal.
 */
export function throughAllSpan(
  bounds: readonly number[],
  planePoint: Vec3,
  direction: Vec3,
  side: ThroughAllSide
): ThroughAllSpan {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (!(magnitude > 1e-12) || !Number.isFinite(magnitude)) {
    throw new Error('Through-all direction must be finite and non-zero.');
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
  const maximum = Math.max(...projections);
  const minimum = Math.min(...projections);
  const forward = Math.max(0, maximum);
  const backward = Math.max(0, -minimum);
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

function rigidTransform(angle: number, translation: Vec3): Float64Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return Float64Array.of(
    c,
    -s,
    0,
    translation.x,
    s,
    c,
    0,
    translation.y,
    0,
    0,
    1,
    translation.z,
    0,
    0,
    0,
    1
  );
}

/** Row-major Z-Y-X rotation with translation, matching the kernel bridge. */
function tiltedTransform(
  rotation: Vec3,
  translation: Vec3
): Float64Array {
  const cx = Math.cos(rotation.x);
  const sx = Math.sin(rotation.x);
  const cy = Math.cos(rotation.y);
  const sy = Math.sin(rotation.y);
  const cz = Math.cos(rotation.z);
  const sz = Math.sin(rotation.z);
  return Float64Array.of(
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    translation.x,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    translation.y,
    -sy,
    cy * sx,
    cy * cx,
    translation.z,
    0,
    0,
    0,
    1
  );
}

function boxSupport(
  transform: Float64Array,
  dimensions: Vec3,
  planePoint: Vec3,
  direction: Vec3
): { readonly minimum: number; readonly maximum: number } {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  const unit = {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
    z: direction.z / magnitude
  };
  const projectedTranslation =
    (transform[3]! - planePoint.x) * unit.x +
    (transform[7]! - planePoint.y) * unit.y +
    (transform[11]! - planePoint.z) * unit.z;
  let minimum = projectedTranslation;
  let maximum = projectedTranslation;
  for (const [dimension, column] of [
    [dimensions.x, 0],
    [dimensions.y, 1],
    [dimensions.z, 2]
  ] as const) {
    const projection =
      transform[column]! * unit.x +
      transform[4 + column]! * unit.y +
      transform[8 + column]! * unit.z;
    minimum += Math.min(0, projection) * dimension;
    maximum += Math.max(0, projection) * dimension;
  }
  return { minimum, maximum };
}

function translatedBox(
  kernel: RemusKernel,
  width: number,
  height: number,
  depth: number,
  translation: Vec3
): number {
  return kernel.copyAndTransformSolid(
    kernel.makeBox(width, height, depth),
    rigidTransform(0, translation)
  );
}

function cutWithBoundedPrism(
  kernel: RemusKernel,
  target: number,
  profileWidth: number,
  profileHeight: number,
  span: ThroughAllSpan,
  profileOrigin: Vec3
): number {
  const depth = span.forward + span.backward;
  const tool = translatedBox(kernel, profileWidth, profileHeight, depth, {
    x: profileOrigin.x,
    y: profileOrigin.y,
    z: profileOrigin.z - span.backward
  });
  return kernel.cut(target, tool);
}

describe('pinned-kernel through-all qualification', () => {
  let kernel: RemusKernel | undefined;

  afterEach(() => {
    kernel?.free();
    kernel = undefined;
  });

  it('derives a finite bound for a tilted target and oblique direction', () => {
    kernel = new RemusKernel();
    const transform = tiltedTransform(
      { x: Math.PI / 6, y: -Math.PI / 8, z: Math.PI / 10 },
      { x: 30, y: 20, z: 3 }
    );
    const target = kernel.copyAndTransformSolid(
      kernel.makeBox(20, 10, 6),
      transform
    );
    const bounds = Array.from(kernel.boundingBox(target));
    const planePoint = { x: 0, y: 0, z: 0 };
    const direction = { x: 0.35, y: 0.25, z: 0.902 };
    const exactSupport = boxSupport(
      transform,
      { x: 20, y: 10, z: 6 },
      planePoint,
      direction
    );
    const span = throughAllSpan(
      bounds,
      planePoint,
      direction,
      'forward'
    );
    expect(span.backward).toBe(0);
    expect(exactSupport.minimum).toBeGreaterThan(0);
    expect(span.forward).toBeGreaterThanOrEqual(exactSupport.maximum - 1e-9);
    expect(span.forward).toBeLessThan(100);
  });

  it('cuts a transformed target with the derived finite one-sided span', () => {
    kernel = new RemusKernel();
    const target = kernel.copyAndTransformSolid(
      kernel.makeBox(20, 10, 6),
      rigidTransform(Math.PI / 6, { x: 30, y: 20, z: 3 })
    );
    const bounds = Array.from(kernel.boundingBox(target));
    const span = throughAllSpan(
      bounds,
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      'forward'
    );
    const targetVolume = kernel.volume(target, 0.01);
    const cut = cutWithBoundedPrism(kernel, target, 5, 3, span, {
      x: 34,
      y: 27,
      z: 0
    });
    expect(kernel.validateSolid(cut)).toBe(0);
    const residualVolume = kernel.volume(cut, 0.01);
    expect(residualVolume).toBeGreaterThan(0);
    expect(residualVolume).toBeLessThan(targetVolume);
    // The profile is wholly inside the rotated target's XY footprint. Its
    // expected 5 x 3 x 6 removal proves that the finite tool reached the far
    // z face instead of merely producing a shallow sliver.
    expect(targetVolume - residualVolume).toBeCloseTo(5 * 3 * 6, 3);
  });

  it('covers both sides with separate derived spans and refuses a missed side', () => {
    kernel = new RemusKernel();
    const target = translatedBox(kernel, 20, 10, 6, {
      x: 30,
      y: 20,
      z: -2
    });
    const bounds = Array.from(kernel.boundingBox(target));
    const span = throughAllSpan(
      bounds,
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      'both'
    );
    expect(span.forward).toBeCloseTo(4, 12);
    expect(span.backward).toBeCloseTo(2, 12);
    const cut = cutWithBoundedPrism(kernel, target, 5, 3, span, {
      x: 35,
      y: 22,
      z: 0
    });
    expect(kernel.validateSolid(cut)).toBe(0);
    expect(kernel.volume(cut, 0.01)).toBeGreaterThan(0);
    const missedBounds = Array.from(
      kernel.boundingBox(
        translatedBox(kernel, 20, 10, 6, { x: 30, y: 20, z: 3 })
      )
    );
    expect(() =>
      throughAllSpan(
        missedBounds,
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: -1 },
        'forward'
      )
    ).toThrow(/no target in the selected direction/);
  });
});
