import type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId
} from '@openzcad/shared';
import { describe, expect, it } from 'vitest';

import {
  createBrepKitSemanticLineage,
  decodeVerifiedBrepKitEvolution,
  propagateBrepKitRigidTransformLineage,
  transformBrepKitWitness,
  type BrepKitLineageState
} from './brepkit-lineage';
import { topologyHashOfWitness } from './topology-lineage';

const FEATURE_ID = 'feature_brepkit' as FeatureId;

const FACE: FaceWitnessV1 = {
  surfaceType: 'plane',
  perimeter: 40,
  centroid: [5, 5, 0],
  analytic: {
    kind: 'plane',
    normal: [0, 0, 1_000_000_000],
    offset: 0
  },
  closure: { u: 'open', v: 'open' }
};

const EDGE: EdgeWitnessV1 = {
  curveType: 'LINE',
  length: 10,
  closed: false,
  endpoints: [
    [0, 0, 0],
    [10, 0, 0]
  ],
  midpoint: [5, 0, 0]
};

const TRANSLATION = [
  1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1
] as const;

function faceReference(
  lineageName = 'primitive.box.face.z-min'
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId: FEATURE_ID,
    lineageName,
    currentHash: topologyHashOfWitness('face', FACE),
    witnessVersion: 1,
    witness: FACE
  };
}

function edgeReference(): EdgeTopologyReferenceV5 {
  return {
    kind: 'edge',
    producingFeatureId: FEATURE_ID,
    lineageName: 'primitive.box.edge.x.y-min.z-min',
    currentHash: topologyHashOfWitness('edge', EDGE),
    witnessVersion: 1,
    witness: EDGE
  };
}

describe('BrepKit semantic lineage', () => {
  it('publishes only unique, supported semantic roles', () => {
    const state = createBrepKitSemanticLineage(FEATURE_ID, 'primitive', [
      {
        handle: 11,
        kind: 'face',
        lineageName: 'box.face.bottom',
        witness: FACE
      },
      { handle: 12, kind: 'edge', lineageName: 'box.edge.front', witness: EDGE }
    ]);

    expect(state.faceReferences.get(11)).toMatchObject({
      producingFeatureId: FEATURE_ID,
      lineageName: 'box.face.bottom',
      currentHash: topologyHashOfWitness('face', FACE)
    });
    expect(state.edgeReferences.get(12)).toMatchObject({
      lineageName: 'box.edge.front',
      currentHash: topologyHashOfWitness('edge', EDGE)
    });
    expect(state.diagnostics).toEqual([]);
  });

  it('fails closed when a role or handle is ambiguous', () => {
    const state = createBrepKitSemanticLineage(FEATURE_ID, 'primitive', [
      { handle: 11, kind: 'face', lineageName: 'box.face.side', witness: FACE },
      { handle: 12, kind: 'face', lineageName: 'box.face.side', witness: FACE }
    ]);

    expect(state.faceReferences.size).toBe(0);
    expect(state.diagnostics).toHaveLength(2);
    expect(
      state.diagnostics.every(({ code }) => code === 'ambiguous-semantic-role')
    ).toBe(true);
  });
});

describe('BrepKit rigid-transform lineage', () => {
  it('preserves semantic identity only through exact transformed witnesses', () => {
    const transformedFace = transformBrepKitWitness('face', FACE, TRANSLATION)!;
    const transformedEdge = transformBrepKitWitness('edge', EDGE, TRANSLATION)!;
    const source: BrepKitLineageState = {
      faceReferences: new Map([[1, faceReference()]]),
      edgeReferences: new Map([[2, edgeReference()]]),
      diagnostics: []
    };

    const result = propagateBrepKitRigidTransformLineage(
      source,
      [
        { handle: 101, kind: 'face', witness: transformedFace },
        { handle: 102, kind: 'edge', witness: transformedEdge }
      ],
      TRANSLATION
    );

    expect(result.faceReferences.get(101)).toMatchObject({
      producingFeatureId: FEATURE_ID,
      lineageName: 'primitive.box.face.z-min',
      witness: transformedFace,
      currentHash: topologyHashOfWitness(
        'face',
        transformedFace as FaceWitnessV1
      )
    });
    expect(result.edgeReferences.get(102)).toMatchObject({
      lineageName: 'primitive.box.edge.x.y-min.z-min',
      witness: transformedEdge
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('diagnoses deletion, split, and merge instead of guessing', () => {
    const transformed = transformBrepKitWitness('face', FACE, TRANSLATION)!;
    const deleted = propagateBrepKitRigidTransformLineage(
      {
        faceReferences: new Map([[1, faceReference()]]),
        edgeReferences: new Map(),
        diagnostics: []
      },
      [],
      TRANSLATION
    );
    expect(deleted.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'transform-deleted' })
    );

    const split = propagateBrepKitRigidTransformLineage(
      {
        faceReferences: new Map([[1, faceReference()]]),
        edgeReferences: new Map(),
        diagnostics: []
      },
      [
        { handle: 101, kind: 'face', witness: transformed },
        { handle: 102, kind: 'face', witness: transformed }
      ],
      TRANSLATION
    );
    expect(split.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'transform-split' })
    );

    const merged = propagateBrepKitRigidTransformLineage(
      {
        faceReferences: new Map([
          [1, faceReference('box.face.a')],
          [2, faceReference('box.face.b')]
        ]),
        edgeReferences: new Map(),
        diagnostics: []
      },
      [{ handle: 101, kind: 'face', witness: transformed }],
      TRANSLATION
    );
    expect(merged.faceReferences.size).toBe(0);
    expect(merged.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'transform-merge' })
    );
  });

  it('rejects a non-rigid transform without publishing references', () => {
    const result = propagateBrepKitRigidTransformLineage(
      {
        faceReferences: new Map([[1, faceReference()]]),
        edgeReferences: new Map(),
        diagnostics: []
      },
      [],
      [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    );
    expect(result.faceReferences.size).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-transform' })
    );
  });
});

describe('BrepKit evolution bridge decoder', () => {
  it('accepts only complete source and result partitions for the production solid', () => {
    const decoded = decodeVerifiedBrepKitEvolution(
      JSON.stringify({
        solid: 77,
        evolution: {
          modified: { 1: [10], 2: [11] },
          generated: { 1: [12] },
          deleted: [3]
        }
      }),
      { resultSolid: 77, sourceFaces: [1, 2, 3], resultFaces: [10, 11, 12] }
    );
    expect(decoded.solid).toBe(77);
    expect(decoded.evolution.deleted).toEqual([3]);
    expect(decoded.evolution.modified.get(1)).toEqual([10]);
  });

  it('rejects missing deletion data, the wrong result, and duplicate outputs', () => {
    const expected = {
      resultSolid: 77,
      sourceFaces: [1, 2],
      resultFaces: [10, 11]
    };
    expect(() =>
      decodeVerifiedBrepKitEvolution(
        JSON.stringify({
          solid: 77,
          evolution: { modified: { 1: [10], 2: [11] }, generated: {} }
        }),
        expected
      )
    ).toThrow(/BrepKit evolution rejected/);
    expect(() =>
      decodeVerifiedBrepKitEvolution(
        JSON.stringify({
          solid: 78,
          evolution: {
            modified: { 1: [10], 2: [11] },
            generated: {},
            deleted: []
          }
        }),
        expected
      )
    ).toThrow(/production result/);
    expect(() =>
      decodeVerifiedBrepKitEvolution(
        JSON.stringify({
          solid: 77,
          evolution: {
            modified: { 1: [10], 2: [11] },
            generated: { 1: [11] },
            deleted: []
          }
        }),
        expected
      )
    ).toThrow(/do not partition results/);
  });
});
