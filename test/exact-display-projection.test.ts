import { expect, it, vi } from 'vitest';
import { projectShapeMesh } from '../packages/kernel-adapter/src/exact-display-projection';
import type { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

function fixture() {
  const positions = vi.fn(() => Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0));
  const indices = vi.fn(() => Uint32Array.of(0, 1, 2));
  const free = vi.fn();
  const mesh = {
    get positions() {
      return positions();
    },
    get indices() {
      return indices();
    },
    free
  };
  const kernel = {
    boundingBox: () => Float64Array.of(0, 0, 0, 1, 1, 1),
    tessellateSolidGroupedBinary: () => mesh
  } as unknown as RemusKernel;
  return { kernel, positions, indices, free };
}

it('reads each copying WASM accessor once per solid and offsets joined triangles', () => {
  const { kernel, positions, indices, free } = fixture();
  const projection = projectShapeMesh(kernel, { solids: [1, 2] }, 1024);
  expect(positions).toHaveBeenCalledTimes(2);
  expect(indices).toHaveBeenCalledTimes(2);
  expect(free).toHaveBeenCalledTimes(2);
  expect(Array.from(projection.mesh.indices)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(projection.mesh.vertices).toHaveLength(18);
});

it('frees temporary WASM data even when the display budget refuses a projection', () => {
  const { kernel, free } = fixture();
  expect(() => projectShapeMesh(kernel, { solids: [1] }, 1)).toThrow(
    'memory budget'
  );
  expect(free).toHaveBeenCalledOnce();
});
