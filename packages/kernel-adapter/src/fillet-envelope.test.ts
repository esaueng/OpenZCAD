import { expect, it, vi } from 'vitest';
import type { RemusKernel } from './remus-runtime';
import { applyEdgeModifier } from './exact-edge-modifiers';

function fixture(maxX = 30) {
  const bounds = [0, 0, 0, 30, 18, 28];
  const free = vi.fn();
  const kernel = {
    boundingBox: (solid: number) =>
      solid === 1 ? bounds : [0, 0, 0, 30.000261736, 18, 28],
    filletWithEvolution: () => ({ result: { solid: 2 } }),
    validateSolidRelaxed: () => 0,
    edgeLength: () => 13,
    volume: (solid: number) => (solid === 1 ? 15205 : 15181),
    getSolidFaces: (solid: number) => Uint32Array.of(solid === 1 ? 10 : 11),
    getSurfaceType: (face: number) => (face === 10 ? 'plane' : 'bspline'),
    checkpoint: vi.fn(() => 5),
    restore: vi.fn(),
    discardCheckpoint: vi.fn(),
    makeSheetBody: vi.fn(() => 7),
    sheetBoundingBox: () => [0, 0, 0, 30.000261736, 18, 28],
    tessellateFace: vi.fn(() => ({
      positions: Float64Array.of(0, 0, 0, maxX, 18, 28, 0, 18, 0),
      free
    }))
  };
  const run = () =>
    applyEdgeModifier(
      kernel as unknown as RemusKernel,
      1,
      [9],
      'fillet',
      1.5,
      undefined,
      () => {}
    );
  return { kernel, run, free };
}

it('accepts a valid trimmed fillet whose control hull crosses the source box', () => {
  const { kernel, run, free } = fixture();
  expect(run()).toBe(2);
  expect(kernel.tessellateFace).toHaveBeenCalled();
  expect(free).toHaveBeenCalledOnce();
  expect(kernel.restore).toHaveBeenCalledWith(5);
  expect(kernel.discardCheckpoint).toHaveBeenCalledWith(5);
});
it('still refuses a surface that really extends beyond the envelope', () => {
  expect(fixture(30.01).run()).toBeNull();
});
it('fails closed and restores temporary sheets when certification exceeds the work limit', () => {
  const { kernel, run } = fixture();
  kernel.tessellateFace.mockImplementation(() => {
    throw Error('work limit');
  });
  expect(run()).toBeNull();
  expect(kernel.restore).toHaveBeenCalledWith(5);
});
it('retains the volume-duplication guard after bounds certification', () => {
  const { kernel, run } = fixture();
  kernel.volume = (solid) => (solid === 1 ? 15205 : 30410);
  expect(run()).toBeNull();
});
it('retains the blend-band guard after bounds certification', () => {
  const { kernel, run } = fixture();
  kernel.getSurfaceType = () => 'plane';
  expect(run()).toBeNull();
});
it('does not certify unavailable older bindings', () => {
  const { kernel, run } = fixture();
  Reflect.deleteProperty(kernel, 'makeSheetBody');
  expect(run()).toBeNull();
});
