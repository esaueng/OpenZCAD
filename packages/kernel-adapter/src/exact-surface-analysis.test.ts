import { describe, expect, it } from 'vitest';
import {
  rayThickness,
  subdivideTriangles,
  surfaceCrossings,
  type RayFace
} from './exact-surface-analysis';

describe('closed-form ray crossings (M09 thickness)', () => {
  it('meets a plane, a cylinder and a sphere where they are', () => {
    expect(
      surfaceCrossings(
        { handle: 1, kind: 'plane', normal: [0, 0, 1], offset: 5 },
        [0, 0, 0],
        [0, 0, 1]
      )
    ).toEqual([5]);
    // Parallel to the plane: no crossing.
    expect(
      surfaceCrossings(
        { handle: 1, kind: 'plane', normal: [0, 0, 1], offset: 5 },
        [0, 0, 0],
        [1, 0, 0]
      )
    ).toEqual([]);
    // From the wall of a radius-5 cylinder through its axis: 0 and 10.
    const cylinder = surfaceCrossings(
      {
        handle: 2,
        kind: 'cylinder',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        radius: 5
      },
      [5, 0, 3],
      [-1, 0, 0]
    );
    expect(cylinder.map((t) => Math.round(t * 1e9) / 1e9)).toEqual([0, 10]);
    // Along the axis it never meets the wall.
    expect(
      surfaceCrossings(
        {
          handle: 2,
          kind: 'cylinder',
          origin: [0, 0, 0],
          axis: [0, 0, 1],
          radius: 5
        },
        [0, 0, 0],
        [0, 0, 1]
      )
    ).toEqual([]);
    const sphere = surfaceCrossings(
      { handle: 3, kind: 'sphere', center: [1, 1, 1], radius: 2 },
      [1, 1, 1],
      [0, 1, 0]
    );
    expect(sphere).toEqual([-2, 2]);
    expect(
      surfaceCrossings({ handle: 4, kind: 'traced' }, [0, 0, 0], [1, 0, 0])
    ).toEqual([]);
  });
});

describe('thickness sampling mesh', () => {
  it('bisects slivers into triangles no longer than the limit', () => {
    // A 40 × 2 rectangle as two slivers.
    const positions = [0, 0, 0, 40, 0, 0, 40, 2, 0, 0, 2, 0];
    const triangles = subdivideTriangles(
      positions,
      [0, 1, 2, 0, 2, 3],
      2,
      10_000
    )!;
    let area = 0;
    for (const [a, b, c] of triangles) {
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a]
      ] as const) {
        expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThanOrEqual(2);
      }
      area +=
        Math.abs(
          (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
        ) / 2;
    }
    expect(area).toBeCloseTo(80, 9);
    // Over budget: refused rather than truncated.
    expect(
      subdivideTriangles(positions, [0, 1, 2, 0, 2, 3], 0.01, 100)
    ).toBeNull();
  });
});

/**
 * A stand-in kernel for the ray method: infinite planes at given heights
 * and optional traced faces, each with its own distance, over material the
 * test describes by height along +Z.
 */
function slabKernel(options: {
  inside(z: number): boolean;
  planes: Record<number, number>;
  traced?: Record<number, (z: number) => number>;
}) {
  return {
    classifyPoint: (_solid: number, _x: number, _y: number, z: number) =>
      options.inside(z) ? 'inside' : 'outside',
    pointToFaceDistance: (_x: number, _y: number, z: number, face: number) => {
      const plane = options.planes[face];
      if (plane !== undefined) return Float64Array.from([Math.abs(z - plane)]);
      return Float64Array.from([options.traced![face]!(z)]);
    }
  } as unknown as Parameters<typeof rayThickness>[0];
}

const plane = (handle: number, z: number): RayFace => ({
  handle,
  kind: 'plane',
  normal: [0, 0, 1],
  offset: z
});

describe('the ray method (M09 thickness)', () => {
  // From z = 0 along +Z: the outward normal at the start points down.
  const start: [number, number, number] = [0, 0, 0];
  const down = [0, 0, -1];

  it('measures a plate to its far plane', () => {
    const kernel = slabKernel({
      inside: (z) => z > 0 && z < 2,
      planes: { 1: 0, 2: 2 }
    });
    const ray = rayThickness(
      kernel,
      0,
      [plane(1, 0), plane(2, 2)],
      1,
      start,
      down,
      0.001,
      20
    );
    expect(ray.thickness).toBeCloseTo(2, 12);
  });

  it('refuses a wall thinner than the opening probe rather than step over it', () => {
    // Material at [0, 0.0005] and [0.001, 10]: the probe at 0.002 is inside
    // the second slab, so only the crossings tell the first wall is there.
    const kernel = slabKernel({
      inside: (z) => (z > 0 && z < 0.0005) || (z > 0.001 && z < 10),
      planes: { 1: 0, 2: 0.0005, 3: 0.001, 4: 10 }
    });
    expect(() =>
      rayThickness(
        kernel,
        0,
        [plane(1, 0), plane(2, 0.0005), plane(3, 0.001), plane(4, 10)],
        1,
        start,
        down,
        0.001,
        20
      )
    ).toThrow(/thinner here than the resolution/);
  });

  it('refuses a ray that only runs close to a traced wall', () => {
    // A frustum's cone 0.00052 from the ray all the way up: near it, never
    // through it. The top cap at 10 is the real wall; no guess is given.
    const kernel = slabKernel({
      inside: (z) => z > 0 && z < 10,
      planes: { 1: 0, 4: 10 },
      traced: { 5: () => 0.00052 }
    });
    expect(() =>
      rayThickness(
        kernel,
        0,
        [plane(1, 0), plane(4, 10), { handle: 5, kind: 'traced' }],
        1,
        start,
        down,
        0.001,
        20
      )
    ).toThrow();
    // Starting from the cone itself, the same grazing is caught by the
    // crossing test instead of the opening probe.
    const fromCone = slabKernel({
      inside: (z) => z > 0 && z < 10,
      planes: { 4: 10 },
      traced: { 5: (z) => (z < 0.01 ? z : 0.0005) }
    });
    expect(() =>
      rayThickness(
        fromCone,
        0,
        [plane(4, 10), { handle: 5, kind: 'traced' }],
        5,
        start,
        down,
        0.001,
        20
      )
    ).toThrow(/runs alongside a curved wall/);
  });

  it('measures through a traced wall it really crosses, to the resolution', () => {
    const kernel = slabKernel({
      inside: (z) => z > 0 && z < 7,
      planes: { 1: 0 },
      traced: { 6: (z) => Math.abs(7 - z) }
    });
    const ray = rayThickness(
      kernel,
      0,
      [plane(1, 0), { handle: 6, kind: 'traced' }],
      1,
      start,
      down,
      0.001,
      20
    );
    expect(Math.abs(ray.thickness - 7)).toBeLessThanOrEqual(0.001 + 1e-12);
  });

  it('refuses a first wall closer to the start than the self-crossing allowance', () => {
    // Resolution 1: material at (0, 0.0005) and (0.0008, 10). Both early
    // planes are other faces than the start, so neither is skipped.
    const kernel = slabKernel({
      inside: (z) => (z > 0 && z < 0.0005) || (z > 0.0008 && z < 10),
      planes: { 1: 0, 2: 0.0005, 3: 0.0008, 4: 10 }
    });
    expect(() =>
      rayThickness(
        kernel,
        0,
        [plane(1, 0), plane(2, 0.0005), plane(3, 0.0008), plane(4, 10)],
        1,
        start,
        down,
        1,
        40
      )
    ).toThrow(/thinner here than the resolution/);
  });

  it('refuses where the traced start face curls back across the opening segment', () => {
    // A tiny torus tube: the face the ray starts on lies 0.2 resolutions
    // from the probe, not the 2 a flat start would put it at.
    const kernel = slabKernel({
      inside: (z) => z > 1.8 && z < 3,
      planes: {},
      traced: { 7: (z) => (z >= 1.9 ? 0.2 : Math.abs(z - 0.8)) }
    });
    expect(() =>
      rayThickness(
        kernel,
        0,
        [{ handle: 7, kind: 'traced' }],
        7,
        start,
        down,
        1,
        40
      )
    ).toThrow(/thinner here than the resolution/);
  });
});
