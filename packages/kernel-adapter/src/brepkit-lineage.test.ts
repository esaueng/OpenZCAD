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

  it('survives a non-grid-preserving rotation against independently measured witnesses', () => {
    // Simulates the two real pipelines: the propagated expectation transforms
    // the *quantized* source witness, while the kernel measures the rotated
    // body's *real* coordinates and quantizes those. For a rotation that does
    // not preserve the grid the two round independently, and exact integer
    // equality used to report every such reference as transform-deleted.
    const GRID = 1e-6;
    const DIR = 1_000_000_000;
    const angle = (37 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotation = [
      cos, -sin, 0, 0,
      sin, cos, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ] as const;
    type Real3 = [number, number, number];
    const rotate = (p: Real3): Real3 => [
      cos * p[0] - sin * p[1],
      sin * p[0] + cos * p[1],
      p[2]
    ];
    const quantize = (p: Real3): [number, number, number] => [
      Math.round(p[0] / GRID),
      Math.round(p[1] / GRID),
      Math.round(p[2] / GRID)
    ];
    const quantizeDirection = (p: Real3): [number, number, number] => [
      Math.round(p[0] * DIR),
      Math.round(p[1] * DIR),
      Math.round(p[2] * DIR)
    ];

    const endA: Real3 = [1.2345678901, 2.3456789012, 0.7891234567];
    const endB: Real3 = [11.987654321, 4.5678901234, 2.3456789012];
    const mid: Real3 = [
      (endA[0] + endB[0]) / 2,
      (endA[1] + endB[1]) / 2,
      (endA[2] + endB[2]) / 2
    ];
    const length = Math.hypot(
      endB[0] - endA[0],
      endB[1] - endA[1],
      endB[2] - endA[2]
    );
    const sortPoints = (
      points: [number, number, number][]
    ): [[number, number, number], [number, number, number]] =>
      points.sort((left, right) => {
        for (let index = 0; index < 3; index += 1) {
          if (left[index]! !== right[index]!) {
            return left[index]! - right[index]!;
          }
        }
        return 0;
      }) as [[number, number, number], [number, number, number]];

    const sourceEdge: EdgeWitnessV1 = {
      curveType: 'LINE',
      length: Math.round(length / GRID),
      closed: false,
      endpoints: sortPoints([quantize(endA), quantize(endB)]),
      midpoint: quantize(mid)
    };
    const measuredEdge: EdgeWitnessV1 = {
      curveType: 'LINE',
      length: Math.round(length / GRID),
      closed: false,
      endpoints: sortPoints([quantize(rotate(endA)), quantize(rotate(endB))]),
      midpoint: quantize(rotate(mid))
    };

    const planeNormal: Real3 = [1, 0, 0];
    const planeOffset = 7.6543210987;
    const planeCentroid: Real3 = [planeOffset, 3.2109876543, 1.987654321];
    const perimeter = 23.4567891234;
    const sourceFace: FaceWitnessV1 = {
      surfaceType: 'plane',
      perimeter: Math.round(perimeter / GRID),
      centroid: quantize(planeCentroid),
      analytic: {
        kind: 'plane',
        normal: quantizeDirection(planeNormal),
        offset: Math.round(planeOffset / GRID)
      },
      closure: { u: 'open', v: 'open' }
    };
    const measuredFace: FaceWitnessV1 = {
      surfaceType: 'plane',
      perimeter: Math.round(perimeter / GRID),
      centroid: quantize(rotate(planeCentroid)),
      analytic: {
        kind: 'plane',
        normal: quantizeDirection(rotate(planeNormal)),
        offset: Math.round(planeOffset / GRID)
      },
      closure: { u: 'open', v: 'open' }
    };

    // The regression premise: the derived and measured integers really do
    // disagree for this rotation — otherwise this test proves nothing.
    const expectedEdge = transformBrepKitWitness('edge', sourceEdge, rotation)!;
    expect(
      topologyHashOfWitness('edge', expectedEdge as EdgeWitnessV1)
    ).not.toBe(topologyHashOfWitness('edge', measuredEdge));

    const source: BrepKitLineageState = {
      faceReferences: new Map([
        [
          1,
          {
            kind: 'face',
            producingFeatureId: FEATURE_ID,
            lineageName: 'primitive.box.face.x-max',
            currentHash: topologyHashOfWitness('face', sourceFace),
            witnessVersion: 1,
            witness: sourceFace
          }
        ]
      ]),
      edgeReferences: new Map([
        [
          2,
          {
            kind: 'edge',
            producingFeatureId: FEATURE_ID,
            lineageName: 'primitive.box.edge.x.y-min.z-min',
            currentHash: topologyHashOfWitness('edge', sourceEdge),
            witnessVersion: 1,
            witness: sourceEdge
          }
        ]
      ]),
      diagnostics: []
    };

    const result = propagateBrepKitRigidTransformLineage(
      source,
      [
        { handle: 101, kind: 'face', witness: measuredFace },
        { handle: 102, kind: 'edge', witness: measuredEdge }
      ],
      rotation
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.faceReferences.get(101)).toMatchObject({
      lineageName: 'primitive.box.face.x-max',
      witness: measuredFace,
      currentHash: topologyHashOfWitness('face', measuredFace)
    });
    expect(result.edgeReferences.get(102)).toMatchObject({
      lineageName: 'primitive.box.edge.x.y-min.z-min',
      witness: measuredEdge,
      currentHash: topologyHashOfWitness('edge', measuredEdge)
    });

    // The band stays fail-closed: a second candidate inside the tolerance is
    // ambiguity, reported as a split rather than bound to either.
    const twin: EdgeWitnessV1 = {
      ...measuredEdge,
      midpoint: [
        measuredEdge.midpoint[0] + 1,
        measuredEdge.midpoint[1],
        measuredEdge.midpoint[2]
      ]
    };
    const ambiguous = propagateBrepKitRigidTransformLineage(
      source,
      [
        { handle: 102, kind: 'edge', witness: measuredEdge },
        { handle: 103, kind: 'edge', witness: twin }
      ],
      rotation
    );
    expect(ambiguous.edgeReferences.size).toBe(0);
    expect(
      ambiguous.diagnostics.some(({ code }) => code === 'transform-split')
    ).toBe(true);

    // And genuinely moved geometry is still deleted, not near-matched.
    const far: EdgeWitnessV1 = {
      ...measuredEdge,
      midpoint: [
        measuredEdge.midpoint[0] + 5,
        measuredEdge.midpoint[1],
        measuredEdge.midpoint[2]
      ]
    };
    const deleted = propagateBrepKitRigidTransformLineage(
      source,
      [{ handle: 104, kind: 'edge', witness: far }],
      rotation
    );
    expect(deleted.edgeReferences.size).toBe(0);
    expect(
      deleted.diagnostics.some(({ code }) => code === 'transform-deleted')
    ).toBe(true);
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
