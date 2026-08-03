import type { FeatureId } from '@openzcad/shared';
import { describe, expect, it } from 'vitest';

import { fingerprintOfSignature } from './topology-fingerprint';
import {
  inspectTopologyWitness,
  resolveTopologyReference,
  topologyHashOfWitness,
  topologyLineageCapability,
  verifyTopologyEvolution,
  type EdgeTopologyReferenceV5,
  type EdgeTopologyResolutionCandidate,
  type EdgeWitnessV1,
  type FaceTopologyReferenceV5,
  type FaceTopologyResolutionCandidate,
  type FaceWitnessV1,
  type TopologyLineageIdentity
} from './topology-lineage';

const FEATURE_ID = 'feat_source' as FeatureId;
const LINEAGE: TopologyLineageIdentity = {
  producingFeatureId: FEATURE_ID,
  lineageName: 'box.face.top'
};

const OPEN_EDGE: EdgeWitnessV1 = {
  curveType: 'LINE',
  length: 10,
  closed: false,
  endpoints: [
    [0, 0, 0],
    [10, 0, 0]
  ],
  midpoint: [5, 0, 0]
};

const SOURCE_FACE: FaceWitnessV1 = {
  surfaceType: 'plane',
  perimeter: 40,
  centroid: [5, 5, 0],
  analytic: { kind: 'plane', normal: [0, 0, 1_000_000_000], offset: 0 },
  closure: { u: 'open', v: 'open' }
};

const EVOLVED_FACE: FaceWitnessV1 = {
  ...SOURCE_FACE,
  perimeter: 60,
  centroid: [10, 5, 0]
};

function faceReference(
  witness: FaceWitnessV1 = SOURCE_FACE
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    ...LINEAGE,
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness
  };
}

function faceCandidate(
  witness: FaceWitnessV1 = SOURCE_FACE,
  lineage: FaceTopologyResolutionCandidate['lineage'] | null = {
    source: 'semantic',
    identity: LINEAGE
  }
): FaceTopologyResolutionCandidate {
  return {
    kind: 'face',
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness,
    ...(lineage ? { lineage } : {})
  };
}

describe('ADR-013 exact witnesses', () => {
  it('reproduces the frozen ADR-011 edge signature hash from integer inputs', () => {
    expect(topologyHashOfWitness('edge', OPEN_EDGE)).toBe(
      fingerprintOfSignature('LINE:10:0:0:0:10:0:0:5:0:0')
    );
  });

  it('reproduces plane and cylinder face signature hashes', () => {
    expect(topologyHashOfWitness('face', SOURCE_FACE)).toBe(
      fingerprintOfSignature('plane:P:40:pl0,0,1000000000;d0:5,5,0')
    );

    const cylinder: FaceWitnessV1 = {
      surfaceType: 'cylinder',
      perimeter: 123,
      centroid: null,
      analytic: {
        kind: 'cylinder',
        axis: [0, 1_000_000_000, 0],
        axisFoot: [10, 0, 20],
        radius: 50
      },
      closure: { u: 'closed', v: 'open' }
    };
    expect(topologyHashOfWitness('face', cylinder)).toBe(
      fingerprintOfSignature('cylinder:P:123:cy0,1000000000,0;ft10,0,20;r50:nc')
    );
  });

  it('rejects non-canonical endpoints and directions', () => {
    const reversed: EdgeWitnessV1 = {
      ...OPEN_EDGE,
      closed: false,
      endpoints: [
        [10, 0, 0],
        [0, 0, 0]
      ],
      midpoint: [5, 0, 0]
    };
    expect(inspectTopologyWitness('edge', reversed)).toMatchObject({
      status: 'invalid'
    });

    const negativeNormal: FaceWitnessV1 = {
      ...SOURCE_FACE,
      analytic: {
        kind: 'plane',
        normal: [0, 0, -1_000_000_000],
        offset: 0
      }
    };
    expect(inspectTopologyWitness('face', negativeNormal)).toMatchObject({
      status: 'invalid'
    });

    const mismatchedCarrier: FaceWitnessV1 = {
      ...SOURCE_FACE,
      surfaceType: 'bspline'
    };
    expect(inspectTopologyWitness('face', mismatchedCarrier)).toEqual({
      status: 'invalid',
      reason: 'Face analytic witness must match its exact surface class.'
    });
  });

  it('fails closed for closed free-form edges and non-open free-form faces', () => {
    const closedBspline: EdgeWitnessV1 = {
      curveType: 'BSPLINE_CURVE',
      length: 20,
      closed: true,
      center: [0, 0, 0],
      axis: null
    };
    expect(inspectTopologyWitness('edge', closedBspline)).toEqual({
      status: 'unsupported',
      reason: 'Closed B-spline/NURBS edges have no cross-kernel exact witness.'
    });

    const unknownBspline: FaceWitnessV1 = {
      surfaceType: 'bspline',
      perimeter: 100,
      centroid: [0, 0, 0],
      analytic: { kind: 'none' },
      closure: { u: 'unknown', v: 'open' }
    };
    expect(inspectTopologyWitness('face', unknownBspline)).toMatchObject({
      status: 'unsupported'
    });
  });
});

describe('ADR-013 evolution verification', () => {
  it('accepts an exact unchanged relation and binds the result hash', () => {
    expect(
      verifyTopologyEvolution({
        operation: 'boolean',
        kind: 'face',
        sourceWitness: SOURCE_FACE,
        resultWitness: SOURCE_FACE,
        relation: { kind: 'unchanged' }
      })
    ).toMatchObject({
      status: 'verified',
      operation: 'boolean',
      resultHash: topologyHashOfWitness('face', SOURCE_FACE)
    });
  });

  it('accepts only exact planar or cylindrical analytic carriers', () => {
    expect(
      verifyTopologyEvolution({
        operation: 'fillet',
        kind: 'face',
        sourceWitness: SOURCE_FACE,
        resultWitness: EVOLVED_FACE,
        relation: { kind: 'analytic-carrier' }
      })
    ).toMatchObject({ status: 'verified' });

    const shiftedPlane: FaceWitnessV1 = {
      ...EVOLVED_FACE,
      analytic: {
        kind: 'plane',
        normal: [0, 0, 1_000_000_000],
        offset: 1
      }
    };
    expect(
      verifyTopologyEvolution({
        operation: 'fillet',
        kind: 'face',
        sourceWitness: SOURCE_FACE,
        resultWitness: shiftedPlane,
        relation: { kind: 'analytic-carrier' }
      })
    ).toMatchObject({ status: 'rejected' });

    expect(
      verifyTopologyEvolution({
        operation: 'boolean',
        kind: 'edge',
        sourceWitness: OPEN_EDGE,
        resultWitness: OPEN_EDGE,
        relation: { kind: 'analytic-carrier' }
      })
    ).toMatchObject({ status: 'rejected' });
  });

  it('rejects a known-transform witness mismatch', () => {
    const transformedEdge: EdgeWitnessV1 = {
      ...OPEN_EDGE,
      closed: false,
      endpoints: [
        [10, 0, 0],
        [20, 0, 0]
      ],
      midpoint: [15, 0, 0]
    };
    expect(
      verifyTopologyEvolution({
        operation: 'rigid-transform',
        kind: 'edge',
        sourceWitness: OPEN_EDGE,
        resultWitness: transformedEdge,
        relation: { kind: 'known-transform', expectedResultWitness: OPEN_EDGE }
      })
    ).toEqual({
      status: 'rejected',
      reason: 'The known-transform witness relation does not match exactly.'
    });
  });

  it('reports bridge-gated operations as hash-only without manufacturing lineage', () => {
    expect(topologyLineageCapability('chamfer')).toMatchObject({
      status: 'unsupported',
      fallback: 'hash-only'
    });
    expect(topologyLineageCapability('direct-edit')).toMatchObject({
      status: 'unsupported',
      fallback: 'hash-only'
    });
    expect(
      verifyTopologyEvolution({
        operation: 'chamfer',
        kind: 'face',
        sourceWitness: SOURCE_FACE,
        resultWitness: SOURCE_FACE,
        relation: { kind: 'unchanged' }
      })
    ).toMatchObject({ status: 'unsupported', fallback: 'hash-only' });
  });

  /**
   * The capability table describes the adapter, not the roadmap.
   *
   * `boolean` and `fillet` used to claim `verified-evolution-only` and
   * `pattern` claimed `derived`, while `exact.ts` hash-onlied all three. The
   * claim survived because `verified-evolution-only` was read by no code at
   * all, so nothing could disagree with it — the table was the only artifact
   * asserting the capability, and it asserted it into a vacuum.
   *
   * These pin the three against the shipped behaviour. They are deliberately
   * boring: the point is that a future entry cannot move here without someone
   * changing a test, which is the check the old arrangement lacked.
   */
  it.each(['boolean', 'fillet', 'chamfer', 'pattern'] as const)(
    'reports %s as hash-only, matching what the adapter actually produces',
    (operation) => {
      expect(topologyLineageCapability(operation)).toMatchObject({
        status: 'unsupported',
        fallback: 'hash-only'
      });
    }
  );

  it('still reports the operations that DO carry lineage', () => {
    // The control. Without it, the assertion above would pass just as happily
    // if every entry in the table had been flattened to hash-only, which would
    // be a different and worse kind of dishonesty.
    expect(topologyLineageCapability('primitive')).toEqual({
      status: 'semantic'
    });
    expect(topologyLineageCapability('sweep')).toEqual({ status: 'semantic' });
    expect(topologyLineageCapability('rigid-transform')).toEqual({
      status: 'derived'
    });
    expect(topologyLineageCapability('imported-step')).toEqual({
      status: 'derived'
    });
  });
});

describe('ADR-013 resolution order', () => {
  it('resolves a unique semantic lineage', () => {
    expect(
      resolveTopologyReference(faceReference(), [faceCandidate()])
    ).toMatchObject({
      status: 'resolved',
      via: 'lineage'
    });
  });

  it('allows a verified lineage to evolve away from the selection-time witness', () => {
    const verification = verifyTopologyEvolution({
      operation: 'fillet',
      kind: 'face',
      sourceWitness: SOURCE_FACE,
      resultWitness: EVOLVED_FACE,
      relation: { kind: 'analytic-carrier' }
    });
    const candidate = faceCandidate(EVOLVED_FACE, {
      source: 'kernel-evolution',
      identity: LINEAGE,
      verification
    });

    const result = resolveTopologyReference(faceReference(), [candidate]);
    expect(result).toMatchObject({
      status: 'resolved',
      via: 'lineage',
      candidate: { currentHash: topologyHashOfWitness('face', EVOLVED_FACE) }
    });
  });

  it('fails visibly when two compatible entries claim one lineage', () => {
    expect(
      resolveTopologyReference(faceReference(), [
        faceCandidate(),
        faceCandidate()
      ])
    ).toMatchObject({
      status: 'failed',
      reason: 'ambiguous-lineage'
    });
  });

  it('does not consume unverified kernel evolution', () => {
    const candidate = faceCandidate(EVOLVED_FACE, {
      source: 'kernel-evolution',
      identity: LINEAGE,
      verification: {
        status: 'rejected',
        reason: 'kernel claim did not match the exact carrier'
      }
    });
    expect(
      resolveTopologyReference(faceReference(), [candidate])
    ).toMatchObject({
      status: 'failed',
      reason: 'lineage-unverified'
    });
  });

  it('rejects proof replay against a different output witness', () => {
    const verification = verifyTopologyEvolution({
      operation: 'fillet',
      kind: 'face',
      sourceWitness: SOURCE_FACE,
      resultWitness: EVOLVED_FACE,
      relation: { kind: 'analytic-carrier' }
    });
    const differentOutput: FaceWitnessV1 = {
      ...EVOLVED_FACE,
      perimeter: 70
    };
    const candidate = faceCandidate(differentOutput, {
      source: 'kernel-evolution',
      identity: LINEAGE,
      verification
    });
    expect(
      resolveTopologyReference(faceReference(), [candidate])
    ).toMatchObject({
      status: 'failed',
      reason: 'lineage-unverified'
    });
  });

  it('never uses a matching hash as a positional or silent v5 rebind', () => {
    const candidate = faceCandidate(SOURCE_FACE, null);
    expect(resolveTopologyReference(faceReference(), [candidate])).toEqual({
      status: 'failed',
      reason: 'lineage-not-found',
      message: 'The selected face lineage no longer exists.'
    });
  });

  it('uses exact hash fallback only when the operation is explicitly unsupported', () => {
    expect(
      resolveTopologyReference(
        faceReference(),
        [faceCandidate(SOURCE_FACE, null)],
        { status: 'unsupported', operation: 'chamfer' }
      )
    ).toMatchObject({ status: 'resolved', via: 'hash-fallback' });

    expect(
      resolveTopologyReference(
        faceReference(),
        [faceCandidate(SOURCE_FACE, null), faceCandidate(SOURCE_FACE, null)],
        { status: 'unsupported', operation: 'direct-edit' }
      )
    ).toMatchObject({ status: 'failed', reason: 'ambiguous-hash' });
  });

  it('preserves unique ADR-011 legacy hash fallback and fails on collision', () => {
    const candidate: EdgeTopologyResolutionCandidate = {
      kind: 'edge',
      currentHash: topologyHashOfWitness('edge', OPEN_EDGE),
      witnessVersion: 1,
      witness: OPEN_EDGE
    };
    const legacy = {
      kind: 'edge',
      currentHash: candidate.currentHash
    } as const;

    expect(resolveTopologyReference(legacy, [candidate])).toMatchObject({
      status: 'resolved',
      via: 'legacy-hash'
    });
    expect(
      resolveTopologyReference(legacy, [candidate, candidate])
    ).toMatchObject({
      status: 'failed',
      reason: 'ambiguous-hash'
    });
  });

  it('validates reference integrity before lineage or fallback', () => {
    const malformed: FaceTopologyReferenceV5 = {
      ...faceReference(),
      currentHash: topologyHashOfWitness('face', SOURCE_FACE) + 1
    };
    expect(
      resolveTopologyReference(malformed, [faceCandidate()])
    ).toMatchObject({
      status: 'failed',
      reason: 'invalid-reference'
    });

    const edgeReference: EdgeTopologyReferenceV5 = {
      kind: 'edge',
      producingFeatureId: FEATURE_ID,
      lineageName: 'edge.one',
      currentHash: topologyHashOfWitness('edge', OPEN_EDGE),
      witnessVersion: 1,
      witness: OPEN_EDGE
    };
    expect(resolveTopologyReference(edgeReference, [])).toMatchObject({
      status: 'failed',
      reason: 'lineage-not-found'
    });
  });
});
