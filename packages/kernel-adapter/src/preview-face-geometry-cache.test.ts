import { describe, expect, it } from 'vitest';
import type { FaceGeometry, FaceWitnessV1 } from '@openzcad/shared';
import {
  PreviewFaceGeometryCache,
  type FaceShapeKernel
} from './preview-face-geometry-cache';
import type { RemusKernel } from './remus-runtime';

/**
 * Two touching solids share a square boundary: faces 1 and 2 are coincident
 * planes with opposite oriented normals. Their witnesses are identical
 * because a witness canonicalizes the plane direction.
 */
function touchingFaces(): FaceShapeKernel {
  const corners = [
    [0, 0, 5],
    [10, 0, 5],
    [10, 10, 5],
    [0, 10, 5]
  ];
  const normals: Record<number, number[]> = { 1: [0, 0, 1], 2: [0, 0, -1] };
  return {
    getFaceVertices: () => Uint32Array.from([0, 1, 2, 3]),
    getVertexPosition: (vertex: number) => Float64Array.from(corners[vertex]!),
    getFaceEdges: () => Uint32Array.from([0, 1, 2, 3]),
    getAnalyticSurfaceParams: () => '{"normal":[0,0,1],"d":5}',
    getSurfaceDomain: () => Float64Array.from([0, 10, 0, 10]),
    getFaceNormal: (face: number) => Float64Array.from(normals[face]!)
  };
}

const witness: FaceWitnessV1 = {
  surfaceType: 'plane',
  perimeter: 40_000_000,
  centroid: [5_000_000, 5_000_000, 5_000_000],
  analytic: { kind: 'plane', normal: [0, 0, 1_000_000], offset: 5_000_000 },
  closure: { u: 'open', v: 'open' }
} as unknown as FaceWitnessV1;

describe('preview face geometry cache', () => {
  it('keeps coincident faces of opposite orientation apart', () => {
    const kernel = touchingFaces();
    const measured: number[] = [];
    const cache = new PreviewFaceGeometryCache(16, (k, face) => {
      measured.push(face);
      const [x, y, z] = Array.from(
        (k as unknown as FaceShapeKernel).getFaceNormal(face)
      );
      return {
        surfaceType: 'plane',
        area: 100,
        center: { x: 5, y: 5, z: 5 },
        normal: { x: x!, y: y!, z: z! },
        planeOffset: 5 * z!
      } satisfies FaceGeometry;
    });
    const up = cache.measure(kernel as RemusKernel, 1, witness);
    const down = cache.measure(kernel as RemusKernel, 2, witness);
    expect(up?.normal?.z).toBe(1);
    expect(down?.normal?.z).toBe(-1);
    expect(down?.planeOffset).toBe(-5);
    expect(measured).toEqual([1, 2]);
    // The same oriented face is reused, as its own copy.
    const again = cache.measure(kernel as RemusKernel, 2, witness);
    expect(again).toEqual(down);
    expect(again).not.toBe(down);
    expect(cache.hits).toBe(1);
  });
});
