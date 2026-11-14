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
  draftLineage,
  shellLineage,
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

/**
 * A planar face for the shell/draft matchers: its witness, its outward
 * normal and one vertex on it (the vertex mean the matchers read).
 */
interface PlaneFace {
  handle: number;
  normal: [number, number, number];
  point: [number, number, number];
  /** A measurement the kernel fails to give for this face. */
  unmeasured?: 'vertices' | 'normal';
}

const planeWitness = (face: PlaneFace): FaceWitnessV1 => ({
  surfaceType: 'plane',
  perimeter: 40 + face.handle,
  centroid: face.point.map((value) => Math.round(value * 1e6)) as [
    number,
    number,
    number
  ],
  analytic: {
    kind: 'plane',
    normal: face.normal.map((value) => Math.round(value * 1e9)) as [
      number,
      number,
      number
    ],
    offset: Math.round(
      (face.normal[0] * face.point[0] +
        face.normal[1] * face.point[1] +
        face.normal[2] * face.point[2]) *
        1e6
    )
  },
  closure: { u: 'open', v: 'open' }
});

/** Source solid 1 and result solid 2, read through the mocked candidates. */
function planeKernel(
  sourceFaces: readonly PlaneFace[],
  resultFaces: readonly PlaneFace[]
): RemusKernel {
  const all = new Map(
    [...sourceFaces, ...resultFaces].map((face) => [face.handle, face])
  );
  vi.mocked(topologyCandidatesForSolid).mockImplementation((_kernel, solid) =>
    (solid === 1 ? sourceFaces : resultFaces).map((face) =>
      f(face.handle, planeWitness(face))
    )
  );
  return {
    getSolidFaces: (solid: number) =>
      new Uint32Array(
        (solid === 1 ? sourceFaces : resultFaces).map((face) => face.handle)
      ),
    getFaceEdges: () => new Uint32Array([]),
    getFaceNormal: (face: number) =>
      all.get(face)!.unmeasured === 'normal'
        ? Float64Array.from([Number.NaN, 0, 0])
        : Float64Array.from(all.get(face)!.normal),
    getFaceVertices: (face: number) =>
      new Uint32Array(all.get(face)!.unmeasured === 'vertices' ? [] : [face]),
    getVertexPosition: (vertex: number) =>
      Float64Array.from(all.get(vertex)!.point)
  } as unknown as RemusKernel;
}

const named = (faces: readonly PlaneFace[], names: Record<number, string>) =>
  createRemusSemanticLineage(
    feature,
    'primitive',
    faces
      .filter((face) => names[face.handle])
      .map((face) => ({
        ...f(face.handle, planeWitness(face)),
        lineageName: names[face.handle]!
      }))
  );

const constructedNames = (state: ReturnType<typeof shellLineage>) =>
  [...(state?.faceReferences.values() ?? [])]
    .map((reference) => reference.lineageName)
    .filter((name) => /^(shell|draft)\.face\./.test(name));

describe('constructed shell and draft names', () => {
  const producer = toFeatureId('feature_constructed');
  // Two coplanar top patches at z = 10; only A is named.
  const topA: PlaneFace = { handle: 1, normal: [0, 0, 1], point: [5, 5, 10] };
  const topB: PlaneFace = { handle: 2, normal: [0, 0, 1], point: [25, 5, 10] };
  // The one inner wall a 2 mm shell leaves under them.
  const inner: PlaneFace = { handle: 10, normal: [0, 0, 1], point: [5, 5, 8] };

  it('names a shell’s inner wall when its source alone lands there', () => {
    const kernel = planeKernel([topA], [inner]);
    expect(
      constructedNames(
        shellLineage(
          kernel,
          1,
          2,
          named([topA], { 1: 'top-a' }),
          producer,
          [],
          2
        )
      )
    ).toEqual([`shell.face.inner.${JSON.stringify([feature, 'top-a'])}`]);
  });

  it('leaves the wall unnamed when an unnamed coplanar patch could own it', () => {
    // An upstream edit can drop A's wall while B's survives; the one
    // result face on the carrier must not take A's name.
    const kernel = planeKernel([topA, topB], [inner]);
    expect(
      constructedNames(
        shellLineage(
          kernel,
          1,
          2,
          named([topA, topB], { 1: 'top-a' }),
          producer,
          [],
          2
        )
      )
    ).toEqual([]);
  });

  it('leaves a rim unnamed when another patch shares its plane', () => {
    const rim: PlaneFace = { handle: 10, normal: [0, 0, 1], point: [1, 1, 10] };
    const alone = planeKernel([topA], [rim]);
    expect(
      constructedNames(
        shellLineage(
          alone,
          1,
          2,
          named([topA], { 1: 'top-a' }),
          producer,
          [1],
          2
        )
      )
    ).toEqual([`shell.face.rim.${JSON.stringify([feature, 'top-a'])}`]);
    // B, opened too or kept, can leave a face on the same plane.
    const kernel = planeKernel([topA, topB], [rim]);
    const source = named([topA, topB], { 1: 'top-a' });
    for (const openings of [[1, 2], [1]]) {
      expect(
        constructedNames(
          shellLineage(kernel, 1, 2, source, producer, openings, 2)
        )
      ).toEqual([]);
    }
  });

  // Two coplanar +x patches drafted 10° about the z = 0 neutral plane.
  const sideA: PlaneFace = { handle: 1, normal: [1, 0, 0], point: [10, 5, 5] };
  const sideB: PlaneFace = { handle: 2, normal: [1, 0, 0], point: [10, 25, 5] };
  const angle = (10 * Math.PI) / 180;
  const turned: PlaneFace = {
    handle: 10,
    normal: [Math.cos(angle), 0, Math.sin(angle)],
    point: [10, 5, 0]
  };
  const pull = { x: 0, y: 0, z: 1 };
  const neutral = { x: 0, y: 0, z: 0 };

  it('names a drafted face when its source alone turns onto the carrier', () => {
    const kernel = planeKernel([sideA], [turned]);
    expect(
      constructedNames(
        draftLineage(
          kernel,
          1,
          2,
          named([sideA], { 1: 'side-a' }),
          producer,
          [1],
          pull,
          neutral,
          10
        )
      )
    ).toEqual([`draft.face.${JSON.stringify([feature, 'side-a'])}`]);
  });

  it('leaves a drafted face unnamed when an unnamed coplanar patch turns there too', () => {
    const kernel = planeKernel([sideA, sideB], [turned]);
    expect(
      constructedNames(
        draftLineage(
          kernel,
          1,
          2,
          named([sideA, sideB], { 1: 'side-a' }),
          producer,
          [1, 2],
          pull,
          neutral,
          10
        )
      )
    ).toEqual([]);
  });

  it('names no drafted face beside one whose carrier it cannot predict', () => {
    const slanted: PlaneFace = {
      handle: 3,
      normal: [0.6, 0, 0.8],
      point: [0, 40, 5]
    };
    const kernel = planeKernel([sideA, slanted], [turned]);
    expect(
      constructedNames(
        draftLineage(
          kernel,
          1,
          2,
          named([sideA, slanted], { 1: 'side-a' }),
          producer,
          [1, 3],
          pull,
          neutral,
          10
        )
      )
    ).toEqual([]);
  });
});

describe('constructed names beside an unmeasurable result face', () => {
  const producer = toFeatureId('feature_unmeasured');
  const top: PlaneFace = { handle: 1, normal: [0, 0, 1], point: [5, 5, 10] };
  // A second patch on the very carrier the name is proved on, and a face
  // nowhere near it.
  const elsewhere: PlaneFace = {
    handle: 12,
    normal: [1, 0, 0],
    point: [40, 5, 5]
  };
  const modes = ['vertices', 'normal'] as const;

  /**
   * The target alone is named; a second patch on its carrier refuses the
   * name whether or not that patch can be measured; a measurable face
   * elsewhere does not.
   */
  function expectRefusedBeside(
    build: (kernel: RemusKernel) => ReturnType<typeof shellLineage>,
    target: PlaneFace,
    twin: PlaneFace,
    name: string
  ) {
    expect(
      constructedNames(build(planeKernel([top], [target, elsewhere])))
    ).toEqual([name]);
    expect(constructedNames(build(planeKernel([top], [target, twin])))).toEqual(
      []
    );
    for (const unmeasured of modes) {
      expect(
        constructedNames(
          build(planeKernel([top], [target, { ...twin, unmeasured }]))
        ),
        `twin without ${unmeasured}`
      ).toEqual([]);
    }
  }

  it('refuses a shell inner wall beside an unmeasurable patch', () => {
    expectRefusedBeside(
      (kernel) =>
        shellLineage(kernel, 1, 2, named([top], { 1: 'top' }), producer, [], 2),
      { handle: 10, normal: [0, 0, 1], point: [5, 5, 8] },
      { handle: 11, normal: [0, 0, 1], point: [25, 5, 8] },
      `shell.face.inner.${JSON.stringify([feature, 'top'])}`
    );
  });

  it('refuses a shell rim beside an unmeasurable patch', () => {
    expectRefusedBeside(
      (kernel) =>
        shellLineage(
          kernel,
          1,
          2,
          named([top], { 1: 'top' }),
          producer,
          [1],
          2
        ),
      { handle: 10, normal: [0, 0, 1], point: [1, 1, 10] },
      { handle: 11, normal: [0, 0, 1], point: [25, 5, 10] },
      `shell.face.rim.${JSON.stringify([feature, 'top'])}`
    );
  });

  it('refuses a drafted face beside an unmeasurable patch', () => {
    const side: PlaneFace = { handle: 1, normal: [1, 0, 0], point: [10, 5, 5] };
    const angle = (10 * Math.PI) / 180;
    const normal: [number, number, number] = [
      Math.cos(angle),
      0,
      Math.sin(angle)
    ];
    const build = (kernel: RemusKernel) =>
      draftLineage(
        kernel,
        1,
        2,
        named([side], { 1: 'side' }),
        producer,
        [1],
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 0 },
        10
      );
    const target: PlaneFace = { handle: 10, normal, point: [10, 5, 0] };
    const twin: PlaneFace = { handle: 11, normal, point: [10, 25, 0] };
    const name = `draft.face.${JSON.stringify([feature, 'side'])}`;
    expect(
      constructedNames(build(planeKernel([side], [target, elsewhere])))
    ).toEqual([name]);
    expect(
      constructedNames(build(planeKernel([side], [target, twin])))
    ).toEqual([]);
    for (const unmeasured of modes) {
      expect(
        constructedNames(
          build(planeKernel([side], [target, { ...twin, unmeasured }]))
        ),
        `twin without ${unmeasured}`
      ).toEqual([]);
    }
  });

  it('keeps carried names when constructed names are withheld', () => {
    // The kept top carries by exact witness; an unmeasurable result patch
    // withholds only the shell's own names.
    const kept: PlaneFace = { ...top, handle: 20 };
    const broken: PlaneFace = {
      handle: 21,
      normal: [0, 0, 1],
      point: [5, 5, 8],
      unmeasured: 'vertices'
    };
    vi.mocked(topologyCandidatesForSolid).mockReset();
    const kernel = planeKernel([top], [kept, broken]);
    // Same witness as the source top, so it carries.
    vi.mocked(topologyCandidatesForSolid).mockImplementation(
      (_kernel, solid) =>
        solid === 1
          ? [f(1, planeWitness(top))]
          : [f(20, planeWitness(top)), f(21, planeWitness(broken))]
    );
    const state = shellLineage(
      kernel,
      1,
      2,
      named([top], { 1: 'top' }),
      producer,
      [],
      2
    );
    expect(constructedNames(state)).toEqual([]);
    expect(state?.faceReferences.get(20)?.lineageName).toBe('top');
  });
});
