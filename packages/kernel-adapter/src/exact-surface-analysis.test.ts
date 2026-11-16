import { describe, expect, it } from 'vitest';
import { subdivideTriangles, surfaceCrossings } from './exact-surface-analysis';

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
