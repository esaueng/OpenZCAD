import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  toFeatureId,
  type EdgeWitnessV1,
  type FaceWitnessV1
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import {
  createRemusSemanticLineage,
  type RemusTopologyCandidate
} from './remus-lineage';
import type * as LineageBuilders from './exact-lineage-builders';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import {
  carryAnalyticFaces,
  withBoundaryEdgeLineage
} from './exact-operation-lineage';

vi.mock('./exact-lineage-builders', async (importOriginal) => ({
  ...(await importOriginal<typeof LineageBuilders>()),
  topologyCandidatesForSolid: vi.fn()
}));
const face: FaceWitnessV1 = {
  surfaceType: 'plane',
  perimeter: 40,
  centroid: [5, 5, 0],
  analytic: { kind: 'plane', normal: [0, 0, 1000000000], offset: 0 },
  closure: { u: 'open', v: 'open' }
};
const side: FaceWitnessV1 = {
  ...face,
  analytic: { kind: 'plane', normal: [0, 1000000000, 0], offset: 0 }
};
const edge: EdgeWitnessV1 = {
  curveType: 'LINE',
  length: 10,
  closed: false,
  endpoints: [
    [0, 0, 0],
    [10, 0, 0]
  ],
  midpoint: [5, 0, 0]
};
const feature = toFeatureId('feature_lineage');
const f = (handle: number, witness: FaceWitnessV1): RemusTopologyCandidate => ({
  handle,
  kind: 'face',
  witness
});
const e = (handle: number): RemusTopologyCandidate => ({
  handle,
  kind: 'edge',
  witness: edge
});
const source = () =>
  createRemusSemanticLineage(feature, 'primitive', [
    { ...f(1, face), lineageName: 'cap' },
    { ...f(2, side), lineageName: 'wall' }
  ]);
const kernel = {
  getSolidFaces: () => new Uint32Array([1, 2]),
  getFaceEdges: () => new Uint32Array([3])
} as unknown as RemusKernel;
beforeEach(() => vi.mocked(topologyCandidatesForSolid).mockReset());

describe('verified operation lineage', () => {
  it('carries a uniquely trimmed carrier but rejects source twins and split results', () => {
    const trimmed: FaceWitnessV1 = {
      ...face,
      perimeter: 35,
      centroid: [4, 4, 0]
    };
    const before = [f(1, face), f(2, side)];
    const after = [f(10, trimmed), f(20, side)];
    vi.mocked(topologyCandidatesForSolid).mockImplementation(
      (_kernel, solid) => (solid === 1 ? before : after)
    );
    expect(
      carryAnalyticFaces(kernel, 1, 2, source()).faceReferences.get(10)
        ?.lineageName
    ).toBe('cap');
    after.push(f(11, { ...trimmed, perimeter: 20 }));
    expect(
      carryAnalyticFaces(kernel, 1, 2, source()).faceReferences.has(10)
    ).toBe(false);
    after.pop();
    before.push(f(4, { ...face, perimeter: 20 }));
    expect(
      carryAnalyticFaces(kernel, 1, 2, source()).faceReferences.has(10)
    ).toBe(false);
  });
  it('refuses a forged source witness or duplicate identity', () => {
    vi.mocked(topologyCandidatesForSolid).mockReturnValue([
      f(1, face),
      f(2, side)
    ]);
    const forged = source();
    forged.faceReferences.get(1)!.currentHash = 123;
    expect(carryAnalyticFaces(kernel, 1, 2, forged).faceReferences.has(1)).toBe(
      false
    );
    const duplicate = source();
    duplicate.faceReferences.set(7, duplicate.faceReferences.get(1)!);
    expect(
      carryAnalyticFaces(kernel, 1, 2, duplicate).faceReferences.has(1)
    ).toBe(false);
  });
  it('names one boundary and refuses multiple edges shared by the same face pair', () => {
    vi.mocked(topologyCandidatesForSolid).mockReturnValue([
      f(1, face),
      f(2, side),
      e(3)
    ]);
    expect(
      withBoundaryEdgeLineage(kernel, 1, feature, source()).edgeReferences.has(
        3
      )
    ).toBe(true);
    vi.mocked(topologyCandidatesForSolid).mockReturnValue([
      f(1, face),
      f(2, side),
      e(3),
      e(4)
    ]);
    const split = {
      ...kernel,
      getFaceEdges: () => new Uint32Array([3, 4])
    } as unknown as RemusKernel;
    expect(
      withBoundaryEdgeLineage(split, 1, feature, source()).edgeReferences.size
    ).toBe(0);
  });
  it('does not assign edges through an unnamed face, a seam, or duplicated face identity', () => {
    vi.mocked(topologyCandidatesForSolid).mockReturnValue([
      f(1, face),
      f(2, side),
      e(3)
    ]);
    const missing = source();
    missing.faceReferences.delete(2);
    expect(
      withBoundaryEdgeLineage(kernel, 1, feature, missing).edgeReferences.size
    ).toBe(0);
    const seam = {
      ...kernel,
      getFaceEdges: (handle: number) => new Uint32Array(handle === 1 ? [3] : [])
    } as unknown as RemusKernel;
    expect(
      withBoundaryEdgeLineage(seam, 1, feature, source()).edgeReferences.size
    ).toBe(0);
    const duplicate = source();
    duplicate.faceReferences.set(7, duplicate.faceReferences.get(1)!);
    expect(
      withBoundaryEdgeLineage(kernel, 1, feature, duplicate).edgeReferences.size
    ).toBe(0);
  });
});
