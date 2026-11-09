import { expect, it } from 'vitest';
import type { RemusKernel } from './remus-runtime';
import { incoherentBlendEdge } from './blend-edge-coherence';

/**
 * Two NURBS patches (10, 11) joined by a straight seam (100), each also
 * bounded by an edge (101, 102) it shares with an exact plane (12). The
 * "surface" of each patch is the unit-radius cylinder x² + z² = 1, so a
 * straight chord across it sags off it and an arc on it does not.
 */
function fixture(options: {
  seam: 'chord' | 'arc';
  planeEdge?: 'chord' | 'arc';
  projectionThrows?: boolean;
}) {
  const chord = Float64Array.of(1, 0, 0, 0, 0, 1);
  const arc = Float64Array.from(
    Array.from({ length: 9 }, (_, index) => {
      const angle = (index / 8) * (Math.PI / 2);
      return [Math.cos(angle), 0, Math.sin(angle)];
    }).flat()
  );
  const edges: Record<number, Float64Array> = {
    100: options.seam === 'chord' ? chord : arc,
    101: options.planeEdge === 'chord' ? chord : arc,
    102: arc
  };
  const kernel = {
    getSolidFaces: () => Uint32Array.of(10, 11, 12),
    getSurfaceType: (face: number) => (face === 12 ? 'plane' : 'bspline'),
    getFaceEdges: (face: number) =>
      face === 10
        ? Uint32Array.of(100, 101)
        : face === 11
          ? Uint32Array.of(100, 102)
          : Uint32Array.of(101, 102),
    edgeToFaceMap: () =>
      JSON.stringify({ 100: [10, 11], 101: [10, 12], 102: [11, 12] }),
    sampleEdge: (edge: number) => edges[edge]!,
    getEdgeCurveType: (edge: number) =>
      edges[edge] === chord ? 'LINE' : 'BSPLINE',
    projectPointOnSurface: (_face: number, x: number, y: number, z: number) => {
      if (options.projectionThrows) throw new Error('no convergence');
      const radius = Math.hypot(x, z);
      return Float64Array.of(
        0,
        0,
        x / radius,
        y,
        z / radius,
        Math.abs(1 - radius)
      );
    }
  };
  return kernel as unknown as RemusKernel;
}

it('refuses a straight seam that leaves both approximate patches it joins', () => {
  const incoherent = incoherentBlendEdge(
    fixture({ seam: 'chord' }),
    1,
    [10, 11],
    0.01
  );
  expect(incoherent).not.toBeNull();
  expect(incoherent!.edge).toBe(100);
  // The chord's midpoint sags 1 - cos 45° off the unit arc.
  expect(incoherent!.deviation).toBeCloseTo(1 - Math.SQRT1_2, 6);
});

it('accepts a seam that lies on both patches', () => {
  expect(
    incoherentBlendEdge(fixture({ seam: 'arc' }), 1, [10, 11], 0.01)
  ).toBeNull();
});

it('does not measure an edge a patch shares with an exact face', () => {
  expect(
    incoherentBlendEdge(
      fixture({ seam: 'arc', planeEdge: 'chord' }),
      1,
      [10, 11],
      0.01
    )
  ).toBeNull();
});

it('treats a projection that cannot be made as no evidence', () => {
  expect(
    incoherentBlendEdge(
      fixture({ seam: 'chord', projectionThrows: true }),
      1,
      [10, 11],
      0.01
    )
  ).toBeNull();
});

it('ignores faces that are not approximate patches of this solid', () => {
  expect(
    incoherentBlendEdge(fixture({ seam: 'chord' }), 1, [10], 0.01)
  ).toBeNull();
  expect(
    incoherentBlendEdge(fixture({ seam: 'chord' }), 1, [], 0.01)
  ).toBeNull();
});
