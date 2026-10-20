import type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId,
  Vector3
} from '@openzcad/shared';
import { describe, expect, it } from 'vitest';

import {
  resolveDatumAxisEdge,
  resolveDatumAxisFace,
  type EdgeVertexCandidate,
  type ExactRevolutionAxisData,
  type FaceAttachmentCandidate
} from './face-attachment';
import { topologyHashOfWitness } from './topology-lineage';

/**
 * R01 datum axis sources resolve solely through verified lineage: a straight
 * edge gives its two ends in quantized order, a cylinder or cone gives its
 * exact axis, and everything else refuses by name.
 */

const FEATURE_ID = 'feature_block' as FeatureId;

const q = (value: number) => Math.round(value * 1e6);
const point = (p: Vector3): [number, number, number] => [
  q(p.x),
  q(p.y),
  q(p.z)
];

function edgeWitness(curveType: string, a: Vector3, b: Vector3): EdgeWitnessV1 {
  return {
    curveType,
    length: q(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)),
    closed: false,
    // Witnesses store open-edge ends in lexicographic order.
    endpoints: [point(a), point(b)].sort(
      (left, right) =>
        left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
    ) as [[number, number, number], [number, number, number]],
    midpoint: point({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      z: (a.z + b.z) / 2
    })
  };
}

function edgeCandidate(
  witness: EdgeWitnessV1,
  endpoints: readonly [Vector3, Vector3] | null,
  lineageName = 'edge.side'
): EdgeVertexCandidate {
  return {
    kind: 'edge',
    currentHash: topologyHashOfWitness('edge', witness),
    witnessVersion: 1,
    witness,
    endpoints,
    lineage: {
      source: 'semantic',
      identity: { producingFeatureId: FEATURE_ID, lineageName }
    }
  };
}

function edgeReference(witness: EdgeWitnessV1): EdgeTopologyReferenceV5 {
  return {
    kind: 'edge',
    producingFeatureId: FEATURE_ID,
    lineageName: 'edge.side',
    currentHash: topologyHashOfWitness('edge', witness),
    witnessVersion: 1,
    witness
  };
}

const CYLINDER_WITNESS: FaceWitnessV1 = {
  surfaceType: 'cylinder',
  perimeter: q(100),
  centroid: null,
  analytic: {
    kind: 'cylinder',
    axis: [0, 0, 1_000_000_000],
    axisFoot: [q(5), q(5), 0],
    radius: q(5)
  },
  closure: { u: 'closed', v: 'open' }
};

function faceCandidate(
  witness: FaceWitnessV1,
  revolution: ExactRevolutionAxisData | null
): FaceAttachmentCandidate {
  return {
    kind: 'face',
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness,
    plane: null,
    revolution,
    lineage: {
      source: 'semantic',
      identity: { producingFeatureId: FEATURE_ID, lineageName: 'face.side' }
    }
  };
}

const faceReference = (witness: FaceWitnessV1): FaceTopologyReferenceV5 => ({
  kind: 'face',
  producingFeatureId: FEATURE_ID,
  lineageName: 'face.side',
  currentHash: topologyHashOfWitness('face', witness),
  witnessVersion: 1,
  witness
});

describe('datum axis edge source', () => {
  const a = { x: 20, y: 0, z: 20 };
  const b = { x: 20, y: 0, z: 0 };

  it('returns the ends of a straight edge in quantized order', () => {
    const witness = edgeWitness('LINE', a, b);
    const ends = resolveDatumAxisEdge({
      reference: edgeReference(witness),
      // The kernel reports the edge from its top end; end 0 is still z = 0.
      candidates: [edgeCandidate(witness, [a, b])],
      datumName: 'Corner',
      sourceFeatureName: 'Block'
    });
    expect(ends).toEqual([b, a]);
  });

  it('refuses a curved open edge by name', () => {
    const witness = edgeWitness('CIRCLE', a, b);
    expect(() =>
      resolveDatumAxisEdge({
        reference: edgeReference(witness),
        candidates: [edgeCandidate(witness, [a, b])],
        datumName: 'Corner',
        sourceFeatureName: 'Block'
      })
    ).toThrow(
      'Datum axis "Corner" cannot run along an edge of source feature "Block": the edge is a circle, not a straight edge.'
    );
  });

  it('refuses a now-closed edge and a deleted one', () => {
    const witness = edgeWitness('LINE', a, b);
    expect(() =>
      resolveDatumAxisEdge({
        reference: edgeReference(witness),
        candidates: [edgeCandidate(witness, null)],
        datumName: 'Corner',
        sourceFeatureName: 'Block'
      })
    ).toThrow(/the edge is closed/);
    expect(() =>
      resolveDatumAxisEdge({
        reference: edgeReference(witness),
        candidates: [edgeCandidate(witness, [a, b], 'edge.other')],
        datumName: 'Corner',
        sourceFeatureName: 'Block'
      })
    ).toThrow(
      /Datum axis "Corner" cannot run along an edge of source feature "Block": its edge was deleted/
    );
  });
});

describe('datum axis face source', () => {
  it('returns the exact axis of a cylinder', () => {
    const revolution: ExactRevolutionAxisData = {
      kind: 'cylinder',
      point: { x: 5, y: 5, z: 10 },
      direction: { x: 0, y: 0, z: -20 }
    };
    expect(
      resolveDatumAxisFace({
        reference: faceReference(CYLINDER_WITNESS),
        candidates: [faceCandidate(CYLINDER_WITNESS, revolution)],
        datumName: 'Bore axis',
        sourceFeatureName: 'Post'
      })
    ).toBe(revolution);
  });

  it('refuses a face with no exact axis by name', () => {
    const plane: FaceWitnessV1 = {
      ...CYLINDER_WITNESS,
      surfaceType: 'sphere',
      analytic: { kind: 'none' }
    };
    expect(() =>
      resolveDatumAxisFace({
        reference: faceReference(plane),
        candidates: [faceCandidate(plane, null)],
        datumName: 'Bore axis',
        sourceFeatureName: 'Post'
      })
    ).toThrow(
      'Datum axis "Bore axis" cannot follow a face of source feature "Post": the face is a sphere, not an exact cylinder or cone.'
    );
  });

  it('refuses a degenerate axis', () => {
    expect(() =>
      resolveDatumAxisFace({
        reference: faceReference(CYLINDER_WITNESS),
        candidates: [
          faceCandidate(CYLINDER_WITNESS, {
            kind: 'cylinder',
            point: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 0, z: 0 }
          })
        ],
        datumName: 'Bore axis',
        sourceFeatureName: 'Post'
      })
    ).toThrow(/not a finite line/);
  });
});
