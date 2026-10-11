import { describe, expect, it } from 'vitest';
import { tangentPlanarNeighbours } from './exact-brep';
import { SyncReadMemo, withSyncReadMemo } from './exact-sync-memo';
import { RemusKernel } from './remus-runtime';

function bandFixture() {
  const unrelated = Array.from({ length: 200 }, (_, index) => index + 1000);
  // Preserve traversal order, rather than edge-map or numeric handle order.
  const faces = [40, ...unrelated, 10, 30, 50, 60];
  const edgeReads = new Map<number, number>();
  const edges: Record<number, number[]> = {
    10: [1, 2],
    30: [2, 98],
    40: [1, 99],
    50: [2],
    60: [88]
  };
  const kernel = {
    getSolidFaces: () => Uint32Array.from(faces),
    getSurfaceType: (face: number) =>
      face === 10 ? 'cylinder' : face === 50 ? 'sphere' : 'plane',
    getAnalyticSurfaceParams: () =>
      JSON.stringify({ origin: [0, 0, 0], axis: [0, 0, 1], radius: 1 }),
    getFaceEdges(face: number) {
      edgeReads.set(face, (edgeReads.get(face) ?? 0) + 1);
      return Uint32Array.from(edges[face] ?? [face + 5000]);
    },
    edgeToFaceMap: () =>
      // 60 is an intentionally over-broad candidate; 999 is outside the solid.
      '{"1":[10,60,40,999],"2":[50,30,10,40]}',
    getFaceVertices: (face: number) => Uint32Array.of(face),
    getVertexPosition: (face: number) =>
      Float64Array.from(face === 30 ? [0, 1, 0] : [1, 0, 0]),
    getFaceNormal: (face: number) =>
      Float64Array.from(face === 30 ? [0, 1, 0] : [1, 0, 0])
  } as unknown as RemusKernel;
  return { kernel, unrelated, edgeReads };
}

describe('cylindrical blend adjacency', () => {
  it('preserves the exhaustive tangency proof while skipping unrelated boundaries', () => {
    const { kernel, unrelated, edgeReads } = bandFixture();
    const exhaustive = tangentPlanarNeighbours(kernel, 7, 10);
    expect(exhaustive).toEqual([40, 30]);
    expect(unrelated.every((face) => edgeReads.get(face) === 1)).toBe(true);

    edgeReads.clear();
    const indexed = withSyncReadMemo(new SyncReadMemo(kernel), () =>
      tangentPlanarNeighbours(kernel, 7, 10)
    );
    expect(indexed).toEqual(exhaustive);
    expect(unrelated.every((face) => !edgeReads.has(face))).toBe(true);
    // An incidence-map entry alone never authorizes a tangent neighbour.
    expect(edgeReads.get(60)).toBe(1);
    expect(indexed).not.toContain(60);
    expect(indexed).not.toContain(999);
  });

  it('does not infer missing adjacency or reuse another kernel scope', () => {
    const first = bandFixture();
    first.kernel.edgeToFaceMap = () => '{}';
    const second = bandFixture();
    withSyncReadMemo(new SyncReadMemo(first.kernel), () => {
      expect(tangentPlanarNeighbours(first.kernel, 7, 10)).toEqual([]);
      expect(tangentPlanarNeighbours(second.kernel, 7, 10)).toEqual([40, 30]);
    });
    expect(tangentPlanarNeighbours(first.kernel, 7, 10)).toEqual([40, 30]);
  });

  it('matches exhaustive proofs on real fillet and cylinder boundaries', () => {
    const kernel = new RemusKernel();
    try {
      const box = kernel.makeBox(30, 20, 8);
      const edge = kernel.getSolidEdges(box)[0]!;
      const filleted = kernel.fillet(box, Uint32Array.of(edge), 0.5);
      const cylinder = kernel.makeCylinder(3, 10);
      const filletProofs: number[][] = [];
      for (const solid of [filleted, cylinder]) {
        const faces = Array.from(kernel.getSolidFaces(solid));
        const exhaustive = faces.map((face) =>
          tangentPlanarNeighbours(kernel, solid, face)
        );
        const indexed = withSyncReadMemo(new SyncReadMemo(kernel), () =>
          faces.map((face) => tangentPlanarNeighbours(kernel, solid, face))
        );
        expect(indexed).toEqual(exhaustive);
        if (solid === filleted) filletProofs.push(...indexed);
        else
          expect(indexed.every((neighbours) => neighbours.length === 0)).toBe(
            true
          );
      }
      expect(
        filletProofs.filter((neighbours) => neighbours.length === 2)
      ).toHaveLength(1);
    } finally {
      kernel.free();
    }
  });
});
