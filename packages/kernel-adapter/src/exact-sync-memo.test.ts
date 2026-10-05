import { describe, expect, it } from 'vitest';
import type { FaceWitnessV1 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import {
  SyncReadMemo,
  TopologyWitnessStore,
  edgeToFaceMapOf,
  surfaceTypeOf,
  withSyncReadMemo
} from './exact-sync-memo';

/** Just the reads the memo makes, counted. */
function fakeKernel(
  solids: Record<number, { faces: number[]; edges: number[] }>
) {
  const reads = { surfaceType: 0, edgeToFaceMap: 0, solidLists: 0 };
  const kernel = {
    getSurfaceType(face: number) {
      reads.surfaceType += 1;
      return face % 2 === 0 ? 'plane' : 'cylinder';
    },
    edgeToFaceMap() {
      reads.edgeToFaceMap += 1;
      return '{"1":[10,11]}';
    },
    getSolidFaces(solid: number) {
      reads.solidLists += 1;
      return Uint32Array.from(solids[solid]!.faces);
    },
    getSolidEdges(solid: number) {
      return Uint32Array.from(solids[solid]!.edges);
    }
  };
  return { kernel: kernel as unknown as RemusKernel, reads, solids };
}

const witness = (surfaceType: string) =>
  ({ surfaceType }) as unknown as FaceWitnessV1;

describe('sync read memo', () => {
  it('reads a surface class once per face inside the scope only', () => {
    const { kernel, reads } = fakeKernel({});
    const memo = new SyncReadMemo(kernel);
    withSyncReadMemo(memo, () => {
      expect(surfaceTypeOf(kernel, 4)).toBe('plane');
      expect(surfaceTypeOf(kernel, 4)).toBe('plane');
      expect(surfaceTypeOf(kernel, 5)).toBe('cylinder');
    });
    expect(reads.surfaceType).toBe(2);
    surfaceTypeOf(kernel, 4);
    expect(reads.surfaceType).toBe(3);
  });

  it('never answers for another kernel and closes on throw', () => {
    const first = fakeKernel({});
    const second = fakeKernel({});
    const memo = new SyncReadMemo(first.kernel);
    expect(() =>
      withSyncReadMemo(memo, () => {
        surfaceTypeOf(second.kernel, 4);
        surfaceTypeOf(second.kernel, 4);
        throw new Error('stop');
      })
    ).toThrow('stop');
    expect(second.reads.surfaceType).toBe(2);
    surfaceTypeOf(first.kernel, 4);
    surfaceTypeOf(first.kernel, 4);
    expect(first.reads.surfaceType).toBe(2);
  });

  it('parses an edge-to-face map once per solid', () => {
    const { kernel, reads } = fakeKernel({});
    withSyncReadMemo(new SyncReadMemo(kernel), () => {
      expect(edgeToFaceMapOf(kernel, 7)).toEqual({ '1': [10, 11] });
      expect(edgeToFaceMapOf(kernel, 7)).toBe(edgeToFaceMapOf(kernel, 7));
    });
    expect(reads.edgeToFaceMap).toBe(1);
  });

  it('does not memoize a face value whose read throws', () => {
    const { kernel } = fakeKernel({});
    const memo = new SyncReadMemo(kernel);
    let attempts = 0;
    const read = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first read fails');
      return attempts;
    };
    expect(() => memo.faceValue('probe', 3, read)).toThrow('first read fails');
    expect(memo.faceValue('probe', 3, read)).toBe(2);
    expect(memo.faceValue('probe', 3, read)).toBe(2);
  });
});

describe('topology witness store', () => {
  it('serves a solid record only while its face and edge lists are unchanged', () => {
    const { kernel, solids } = fakeKernel({
      1: { faces: [10, 11], edges: [20] }
    });
    const store = new TopologyWitnessStore();
    const first = store.record(kernel, 1);
    first.faceWitnesses.set(10, witness('plane'));
    expect(store.record(kernel, 1)).toBe(first);

    solids[1] = { faces: [10, 12], edges: [20] };
    const replaced = store.record(kernel, 1);
    expect(replaced).not.toBe(first);
    expect(replaced.faceWitnesses.size).toBe(0);
  });

  it('forgets everything when the kernel changes', () => {
    const one = fakeKernel({ 1: { faces: [10], edges: [20] } });
    const two = fakeKernel({ 1: { faces: [10], edges: [20] } });
    const store = new TopologyWitnessStore();
    const first = store.record(one.kernel, 1);
    expect(store.record(two.kernel, 1)).not.toBe(first);
    expect(store.size).toBe(1);
  });

  it('evicts the least recently used solids beyond its handle budget', () => {
    const { kernel } = fakeKernel({
      1: { faces: [10, 11], edges: [20] },
      2: { faces: [12, 13], edges: [21] },
      3: { faces: [14, 15], edges: [22] }
    });
    const store = new TopologyWitnessStore(6);
    const one = store.record(kernel, 1);
    store.record(kernel, 2);
    expect(store.record(kernel, 1)).toBe(one);
    store.record(kernel, 3);
    expect(store.size).toBe(2);
    expect(store.record(kernel, 1)).toBe(one);
  });

  it('seeds a sync memo with a stored solid’s witnesses and surface classes', () => {
    const { kernel, reads } = fakeKernel({ 1: { faces: [10], edges: [20] } });
    const store = new TopologyWitnessStore();
    const first = new SyncReadMemo(kernel, store);
    first.registerSolid(1);
    first.recordFaceWitness(10, witness('torus'));

    const next = new SyncReadMemo(kernel, store);
    next.registerSolid(1);
    expect(next.faceWitnesses.get(10)?.surfaceType).toBe('torus');
    withSyncReadMemo(next, () => {
      expect(surfaceTypeOf(kernel, 10)).toBe('torus');
    });
    expect(reads.surfaceType).toBe(0);
  });
});
