import { readFile } from 'node:fs/promises';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { readFacePlaneFrame } from './exact-face-plane-frame';
import {
  proveChangedFaceDistance,
  queryOpposingPlanarFacePairs,
  rebuildFaceDistance
} from './exact-face-distance';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from './remus-runtime';

function stubKernel(overrides: Partial<RemusKernel> = {}): RemusKernel {
  return {
    getSurfaceType: vi.fn(() => 'plane'),
    getFaceVertices: vi.fn(() => new Uint32Array([10, 11, 12, 13])),
    getVertexPosition: vi.fn((vertex: number) => {
      const positions: Record<number, Float64Array> = {
        10: new Float64Array([2, 4, 6]),
        11: new Float64Array([4, 4, 6]),
        12: new Float64Array([4, 8, 6]),
        13: new Float64Array([2, 8, 6])
      };
      return positions[vertex]!;
    }),
    getFaceNormal: vi.fn(() => new Float64Array([0, 0, 1])),
    ...overrides
  } as unknown as RemusKernel;
}

describe('readFacePlaneFrame', () => {
  it('returns only the vertex-mean plane frame and does not query full measurements', () => {
    const faceArea = vi.fn(() => {
      throw new Error('unused area is unavailable');
    });
    const getFaceEdges = vi.fn(() => {
      throw new Error('unused provenance is unavailable');
    });
    const getAnalyticSurfaceParams = vi.fn(() => {
      throw new Error('unused curved metadata is unavailable');
    });
    const kernel = stubKernel({
      faceArea,
      getFaceEdges,
      getAnalyticSurfaceParams
    });

    expect(readFacePlaneFrame(kernel, 7)).toEqual({
      surfaceType: 'plane',
      center: { x: 3, y: 6, z: 6 },
      normal: { x: 0, y: 0, z: 1 },
      planeOffset: 6
    });
    expect(faceArea).not.toHaveBeenCalled();
    expect(getFaceEdges).not.toHaveBeenCalled();
    expect(getAnalyticSurfaceParams).not.toHaveBeenCalled();
  });

  it('keeps unsupported surfaces out of planar eligibility', () => {
    const getFaceNormal = vi.fn(() => new Float64Array([0, 0, 1]));
    const kernel = stubKernel({
      getSurfaceType: vi.fn(() => 'cylinder'),
      getFaceNormal
    });

    expect(readFacePlaneFrame(kernel, 7)).toEqual({
      surfaceType: 'cylinder',
      center: { x: 3, y: 6, z: 6 }
    });
    expect(getFaceNormal).not.toHaveBeenCalled();
  });

  it('fails closed when an analytic plane normal is unavailable', () => {
    const kernel = stubKernel({
      getFaceNormal: vi.fn(() => {
        throw new Error('analytic normal unavailable');
      })
    });

    expect(readFacePlaneFrame(kernel, 7)).toEqual({
      surfaceType: 'plane',
      center: { x: 3, y: 6, z: 6 }
    });
  });

  it('preserves the zero-center fallback for a face without vertices', () => {
    const kernel = stubKernel({
      getFaceVertices: vi.fn(() => new Uint32Array())
    });

    expect(readFacePlaneFrame(kernel, 7)).toMatchObject({
      center: { x: 0, y: 0, z: 0 },
      planeOffset: 0
    });
  });

  it('still propagates failures from required frame inputs', () => {
    const kernel = stubKernel({
      getVertexPosition: vi.fn(() => {
        throw new Error('vertex read failed');
      })
    });

    expect(() => readFacePlaneFrame(kernel, 7)).toThrow('vertex read failed');
  });
});

describe('planar-distance proof paths', { timeout: 120_000 }, () => {
  let kernel: RemusKernel;

  beforeAll(async () => {
    await loadRemusTranslators();
  });

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  afterEach(() => {
    kernel.free();
  });

  function translate(solid: number, x: number, y: number, z: number): number {
    kernel.transformSolid(
      solid,
      new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1])
    );
    return solid;
  }

  function firstProvenChange(solid: number): number | null {
    for (const pair of queryOpposingPlanarFacePairs(kernel, solid)) {
      for (const mode of [
        'one-sided-first',
        'one-sided-second',
        'symmetric'
      ] as const) {
        const changed = proveChangedFaceDistance(kernel, solid, pair, mode);
        if (changed !== null) {
          return changed;
        }
      }
    }
    return null;
  }

  it('fails closed and rolls back an ambiguous coplanar patch proof', () => {
    const left = kernel.makeBox(10, 10, 10);
    const right = translate(kernel.makeBox(10, 5, 10), 10, 0, 0);
    const solid = kernel.fuse(left, right);
    const source = queryOpposingPlanarFacePairs(kernel, solid).find(
      (pair) => Math.abs(pair.normal[2]) > 0.99 && pair.distance === 10
    );
    expect(source).toBeDefined();

    const beforeBounds = Array.from(kernel.boundingBox(solid));
    const beforeVolume = kernel.volume(solid, 0.08);
    expect(
      proveChangedFaceDistance(kernel, solid, source!, 'one-sided-first')
    ).toBeNull();
    expect(Array.from(kernel.boundingBox(solid))).toEqual(beforeBounds);
    expect(kernel.volume(solid, 0.08)).toBeCloseTo(beforeVolume, 8);
  });

  it.each([
    [
      'through holes',
      (active: RemusKernel) => {
        let solid = active.makeBox(40, 30, 20);
        for (let index = 0; index < 4; index += 1) {
          const tool = translate(
            active.makeCylinder(1.5, 24),
            5 + index * 5,
            5,
            -2
          );
          solid = active.cut(solid, tool);
        }
        return solid;
      }
    ],
    [
      'an enclosed cavity',
      (active: RemusKernel) => {
        const outer = active.makeBox(40, 30, 20);
        const tool = translate(active.makeBox(20, 10, 10), 10, 10, 5);
        return active.cut(outer, tool);
      }
    ],
    [
      'a blended edge',
      (active: RemusKernel) => {
        const box = active.makeBox(40, 30, 20);
        return active.fillet(
          box,
          new Uint32Array([active.getSolidEdges(box)[0]!]),
          1
        );
      }
    ]
  ] as const)('retains a valid proof through %s', (_name, makeSolid) => {
    expect(firstProvenChange(makeSolid(kernel))).not.toBeNull();
  });

  it('reads imported NURBS-trimmed faces without inventing unsupported metadata', async () => {
    const step = await readFile(
      new URL(
        '../../../test/fixtures/step/nurbs-trimmed-cylinder.step',
        import.meta.url
      )
    );
    const arena = remusTranslators().importStep(
      step,
      step.byteLength,
      2_000_000
    );
    const solid = kernel.deserializeSolids(arena)[0]!;
    const frames = Array.from(kernel.getSolidFaces(solid), (face) =>
      readFacePlaneFrame(kernel, face)
    );

    expect(frames).toHaveLength(5);
    expect(frames.some((frame) => frame.surfaceType === 'cylinder')).toBe(true);
    expect(
      frames.filter((frame) => frame.surfaceType === 'plane')
    ).toHaveLength(4);
    expect(queryOpposingPlanarFacePairs(kernel, solid)).toEqual([]);
  });

  it('re-resolves the measured pair across repeated edits', () => {
    let solid = kernel.makeBox(10, 10, 10);
    for (const desiredDistance of [11, 12, 9, 10]) {
      const source = queryOpposingPlanarFacePairs(kernel, solid).find(
        (pair) => Math.abs(pair.normal[2]) > 0.99
      );
      expect(source).toBeDefined();
      solid = rebuildFaceDistance(
        kernel,
        solid,
        source!,
        'one-sided-first',
        desiredDistance
      );
      const measured = queryOpposingPlanarFacePairs(kernel, solid).find(
        (pair) =>
          Math.abs(pair.normal[2]) > 0.99 &&
          Math.abs(pair.distance - desiredDistance) <= 1e-8
      );
      expect(measured?.distance).toBeCloseTo(desiredDistance, 8);
    }
  });
});
