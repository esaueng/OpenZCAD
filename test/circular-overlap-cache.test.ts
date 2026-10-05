import { describe, expect, it, vi } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { sharedSolidVolume } from '../packages/kernel-adapter/src/exact-boolean-helpers';

describe('rigidly equivalent circular overlap measurements', () => {
  it.each([360, -360])(
    'preserves the full exact pair sum at %s degrees with multiple source solids',
    (angle) => {
      const kernel = new RemusKernel();
      try {
        const count = 6,
          width = 2;
        const sources = [kernel.makeBox(20, 20, 10), kernel.makeBox(8, 6, 5)];
        kernel.transformSolid(
          sources[1]!,
          transformMatrix({ x: 3, y: 2, z: 2 }, { x: 0, y: 0, z: 0 })
        );
        const solids = Array.from({ length: count }, (_, index) =>
          sources.map((solid) =>
            kernel.copyAndTransformSolid(
              solid,
              transformMatrix(
                { x: 0, y: 0, z: 0 },
                { x: 0, y: 0, z: (angle * index) / count }
              )
            )
          )
        ).flat();
        const queries = vi.spyOn(kernel, 'booleanWithQuality');
        const reference = sharedSolidVolume(kernel, solids);
        const uncachedQueries = queries.mock.calls.length;
        queries.mockClear();
        const cached = sharedSolidVolume(kernel, solids, (left, right) => {
          const delta = Math.floor(right / width) - Math.floor(left / width);
          return [
            `${left % width}:${right % width}:${delta}`,
            `${right % width}:${left % width}:${count - delta}`
          ].sort()[0]!;
        });
        expect(reference).toBeGreaterThan(0);
        expect(Math.abs(cached - reference) / reference).toBeLessThan(1e-9);
        expect(queries.mock.calls.length).toBeLessThan(uncachedQueries / 2);
        // The measurements cannot consume or change their source geometry.
        for (const solid of solids) expect(kernel.validateSolid(solid)).toBe(0);
        queries.mockRestore();
      } finally {
        kernel.free();
      }
    },
    30_000
  );

  it('does not reuse a refused exact query as evidence for a later pair', () => {
    const boxes = [
      [0, 0, 0, 10, 10, 10],
      [1, 0, 0, 11, 10, 10],
      [2, 0, 0, 12, 10, 10]
    ];
    const booleanWithQuality = vi.fn(() => {
      throw new Error('exact-only refusal');
    });
    const kernel = {
      boundingBox: (solid: number) => Float64Array.from(boxes[solid]!),
      booleanWithQuality
    } as unknown as RemusKernel;
    expect(
      sharedSolidVolume(kernel, [0, 1, 2], () => 'equivalent')
    ).toBeCloseTo(2600, 8);
    // Both intersection and inclusion-exclusion are tried for every refused pair.
    expect(booleanWithQuality).toHaveBeenCalledTimes(6);
  });
});
