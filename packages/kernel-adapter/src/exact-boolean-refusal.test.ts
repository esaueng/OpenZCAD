import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { censusOfSolids } from './boolean-result-validation';

/** Row-major rigid translation, matching `copyAndTransformSolid`. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

/**
 * Remus B21 refuses severing booleans instead of silently approximating them.
 * The e2e STEP export test previously asserted the old faceted-cut warning
 * for an r=14 cylinder severing an 18-deep box; the kernel now declines that
 * cut outright, so the happy-path test uses the clean r=6 tool and this unit
 * pins both sides of the contract.
 */
describe('exact-only severing boolean refusal', () => {
  it('cuts cleanly with the default r=6 tool', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 18, 24);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(6, 28),
      translation(30, 9, 0)
    );
    const cut = kernel.cut(box, tool);
    expect(kernel.validateSolid(cut)).toBe(0);
    expect(censusOfSolids(kernel, [cut]).curvedFaces).toBeGreaterThan(0);
  });

  it('refuses the r=14 severing cut instead of faceting', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 18, 24);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(14, 28),
      translation(30, 9, 0)
    );
    expect(() => kernel.cut(box, tool)).toThrowError(/exact/i);
  });
});
