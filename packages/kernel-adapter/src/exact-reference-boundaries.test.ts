import { describe, expect, it, vi } from 'vitest';
import type {
  EdgeTopologyReferenceV5,
  FaceTopologyReferenceV5,
  FeatureId
} from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import { resolveDirectEditFace } from './exact-direct-edit-ops';
import { resolveEdgeModifierEdges } from './exact-reference-resolution';
import { edgeWitnessOf, faceWitnessOf } from './exact-witnesses';
import { topologyHashOfWitness } from './topology-lineage';

const identity = {
  producingFeatureId: 'feature_source' as FeatureId,
  lineageName: 'source.selection',
  witnessVersion: 1 as const
};

function fixture() {
  const kernel = new RemusKernel();
  const solid = kernel.makeBox(10, 8, 6);
  const face = kernel.getSolidFaces(solid)[0]!;
  const edge = kernel.getSolidEdges(solid)[0]!;
  const faceWitness = faceWitnessOf(kernel, face);
  const edgeWitness = edgeWitnessOf(kernel, edge);
  const faceReference: FaceTopologyReferenceV5 = {
    ...identity,
    kind: 'face',
    currentHash: topologyHashOfWitness('face', faceWitness),
    witness: faceWitness
  };
  const edgeReference: EdgeTopologyReferenceV5 = {
    ...identity,
    kind: 'edge',
    currentHash: topologyHashOfWitness('edge', edgeWitness),
    witness: edgeWitness
  };
  // The collapsed result has new handles and cannot inherit either operand's
  // handle-bound lineage. Only the measured result can vouch for the pick.
  const multi = { solids: [solid, kernel.makeBox(2, 3, 4)] };
  const pickFace = (reference = faceReference) =>
    resolveDirectEditFace(kernel, { solids: [solid] }, solid, {
      faceHash: reference.currentHash,
      faceReference: reference
    });
  const pickEdge = (references = [edgeReference]) =>
    resolveEdgeModifierEdges(
      kernel,
      multi,
      solid,
      [edgeReference.currentHash],
      references
    );
  return {
    kernel,
    solid,
    face,
    edge,
    faceReference,
    edgeReference,
    pickFace,
    pickEdge
  };
}

describe('v5 references at unsupported lineage boundaries', () => {
  it('resolves unique exact witnesses without claiming lineage', () => {
    const { face, edge, pickFace, pickEdge } = fixture();
    expect(pickFace()).toEqual({ face, viaLineage: false });
    expect(pickEdge()).toEqual({ handles: [edge], repairedReferences: null });
  });

  it('rejects a face witness mismatch even when its hash still matches', () => {
    const { faceReference, pickFace } = fixture();
    // Closure is part of the complete witness, but not the legacy face hash.
    const reference: FaceTopologyReferenceV5 = {
      ...faceReference,
      witness: { ...faceReference.witness, closure: { u: 'closed', v: 'open' } }
    };
    expect(topologyHashOfWitness('face', reference.witness)).toBe(
      reference.currentHash
    );
    expect(() => pickFace(reference)).toThrow(/unique exact hash match/);
  });

  it('rejects an inconsistent face reference instead of using the saved hash', () => {
    const { faceReference, pickFace } = fixture();
    expect(() =>
      pickFace({ ...faceReference, currentHash: faceReference.currentHash + 1 })
    ).toThrow(/hash does not match its exact witness/);
  });

  it('rejects an inconsistent edge reference instead of using the saved hash', () => {
    const { edgeReference, pickEdge } = fixture();
    expect(() =>
      pickEdge([
        {
          ...edgeReference,
          witness: {
            ...edgeReference.witness,
            length: edgeReference.witness.length + 1
          }
        }
      ])
    ).toThrow(/hash does not match its exact witness/);
  });

  it('refuses repeated exact face and edge candidates', () => {
    const { kernel, face, edge, pickFace, pickEdge } = fixture();
    const faces = vi
      .spyOn(kernel, 'getSolidFaces')
      .mockReturnValue(Uint32Array.of(face, face));
    expect(() => pickFace()).toThrow(/ambiguous|multiple exact candidates/);
    faces.mockRestore();
    const edges = vi
      .spyOn(kernel, 'getSolidEdges')
      .mockReturnValue(Uint32Array.of(edge, edge));
    expect(() => pickEdge()).toThrow(/ambiguous|multiple exact candidates/);
    edges.mockRestore();
  });

  it('refuses missing witnesses despite nearby geometry', () => {
    const { kernel, solid, faceReference, edgeReference, pickFace } = fixture();
    const far = kernel.makeBox(11, 9, 7);
    const faceWitness = faceWitnessOf(kernel, kernel.getSolidFaces(far)[0]!);
    const edgeWitness = edgeWitnessOf(kernel, kernel.getSolidEdges(far)[0]!);
    expect(() =>
      pickFace({
        ...faceReference,
        currentHash: topologyHashOfWitness('face', faceWitness),
        witness: faceWitness
      })
    ).toThrow(/unique exact hash match/);
    // Hold the selected hash consistent with the stale witness for this call.
    const reference = {
      ...edgeReference,
      currentHash: topologyHashOfWitness('edge', edgeWitness),
      witness: edgeWitness
    };
    expect(() =>
      resolveEdgeModifierEdges(
        kernel,
        { solids: [solid, far] },
        solid,
        [reference.currentHash],
        [reference]
      )
    ).toThrow(/unique exact hash match/);
  });
});
