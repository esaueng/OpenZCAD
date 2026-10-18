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

it('holds display quality across small edits so unchanged faces retain their mesh', () => {
  const { kernel } = fixture();
  const tessellate = vi.spyOn(kernel, 'tessellateSolidGroupedBinary');
  const first = projectShapeMesh(kernel, { solids: [1] }, 1024);
  vi.spyOn(kernel, 'boundingBox').mockReturnValue(
    Float64Array.of(0, 0, 0, 1.1, 1, 1)
  );
  const next = projectShapeMesh(
    kernel,
    { solids: [2] },
    1024,
    first.linearDeflections
  );
  expect(tessellate.mock.calls[1]!.slice(1)).toEqual(
    tessellate.mock.calls[0]!.slice(1)
  );
  expect(next.linearDeflections).toEqual(first.linearDeflections);
  vi.spyOn(kernel, 'boundingBox').mockReturnValue(
    Float64Array.of(0, 0, 0, 2, 1, 1)
  );
  expect(
    projectShapeMesh(kernel, { solids: [3] }, 1024, first.linearDeflections)
      .linearDeflections[0]
  ).toBeGreaterThan(first.linearDeflections[0]!);
});

it('reuses a closure proof only for the matching same-kernel, same-quality union mesh', () => {
  const { kernel } = fixture();
  const tessellate = vi.spyOn(kernel, 'tessellateSolidGroupedBinary');
  const initial = projectShapeMesh(kernel, { solids: [1] }, 1024);
  const payload = () => ({
    kernel,
    solid: 1,
    linearDeflection: initial.linearDeflections[0]!,
    angularDeflection: 0.06,
    positions: initial.mesh.vertices.slice(),
    indices: initial.mesh.indices.slice(),
    faceOffsets: Uint32Array.of(0, 1),
    bytes: 56
  });
  const verdicts = new Map([
    [1, { strictErrors: 0, meshClosed: true, displayMesh: payload() }]
  ]);
  tessellate.mockClear();
  expect(
    projectShapeMesh(
      kernel,
      { solids: [1] },
      1024,
      initial.linearDeflections,
      verdicts
    ).closureValidated
  ).toBe(true);
  expect(tessellate).not.toHaveBeenCalled();
  // The proof is consumed once. Another output has to be checked again.
  expect(
    projectShapeMesh(
      kernel,
      { solids: [1] },
      1024,
      initial.linearDeflections,
      verdicts
    ).closureValidated
  ).toBe(false);
  verdicts.set(1, {
    strictErrors: 0,
    meshClosed: true,
    displayMesh: { ...payload(), solid: 2 }
  });
  expect(
    projectShapeMesh(
      kernel,
      { solids: [1] },
      1024,
      initial.linearDeflections,
      verdicts
    ).closureValidated
  ).toBe(false);
  verdicts.set(1, {
    strictErrors: 0,
    meshClosed: true,
    displayMesh: { ...payload(), angularDeflection: 0.1 }
  });
  expect(
    projectShapeMesh(
      kernel,
      { solids: [1] },
      1024,
      initial.linearDeflections,
      verdicts
    ).closureValidated
  ).toBe(false);
});
