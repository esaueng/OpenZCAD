import { describe, expect, it, vi } from 'vitest';
import {
  toFeatureId,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { topologyHashOfWitness } from './topology-lineage';
import { faceSelectionRepairCandidates } from './exact-reference-resolution';

/**
 * The upgrade of a hash-only face pick is exact or nothing (ADR-013): every
 * stored hash must name one face, that face one published name, and the name
 * re-verify against the face's measured witness. Any doubt refuses the whole
 * selection rather than naming part of it or naming a neighbour.
 */

const witnessByHandle = new Map<number, FaceWitnessV1>();
const handlesByHash = new Map<number, number[]>();

vi.mock('./exact-witnesses', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  faceHandlesByFingerprint: () => handlesByHash,
  faceWitnessOf: (_kernel: unknown, handle: number) =>
    witnessByHandle.get(handle)!
}));

const plane = (offset: number): FaceWitnessV1 => ({
  surfaceType: 'plane',
  perimeter: 40 + offset,
  centroid: [offset, 0, 0],
  analytic: { kind: 'plane', normal: [1000000000, 0, 0], offset },
  closure: { u: 'open', v: 'open' }
});
const producer = toFeatureId('feature_box');
const kernel = {} as RemusKernel;

function reference(
  witness: FaceWitnessV1,
  lineageName: string
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId: producer,
    lineageName,
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness
  };
}

/** Faces 1..n on one solid, measured as `measured`, named as `named`. */
function body(
  measured: FaceWitnessV1[],
  named: (FaceTopologyReferenceV5 | null)[]
): { shape: ExactShape; hashes: number[] } {
  witnessByHandle.clear();
  handlesByHash.clear();
  const hashes = measured.map((witness, index) => {
    const handle = index + 1;
    const hash = topologyHashOfWitness('face', witness);
    witnessByHandle.set(handle, witness);
    handlesByHash.set(hash, [...(handlesByHash.get(hash) ?? []), handle]);
    return hash;
  });
  return {
    hashes,
    shape: {
      solids: [7],
      lineage: {
        faceReferences: new Map(
          named.flatMap((ref, index) => (ref ? [[index + 1, ref]] : []))
        ),
        edgeReferences: new Map(),
        diagnostics: []
      }
    }
  };
}

describe('faceSelectionRepairCandidates', () => {
  it('names every face of a set whose hashes each name one named face', () => {
    const [a, b] = [plane(1), plane(2)];
    const { shape, hashes } = body(
      [a, b],
      [reference(a, 'box.face.a'), reference(b, 'box.face.b')]
    );
    expect(
      faceSelectionRepairCandidates(kernel, shape, hashes)?.map(
        (ref) => ref.lineageName
      )
    ).toEqual(['box.face.a', 'box.face.b']);
  });

  it('refuses the whole set when one face has no name', () => {
    const [a, b] = [plane(1), plane(2)];
    const { shape, hashes } = body([a, b], [reference(a, 'box.face.a'), null]);
    expect(faceSelectionRepairCandidates(kernel, shape, hashes)).toBeNull();
    expect(
      faceSelectionRepairCandidates(kernel, shape, [hashes[0]!])
    ).toHaveLength(1);
  });

  it('refuses a hash that names two faces', () => {
    const a = plane(1);
    const { shape, hashes } = body(
      [a, a],
      [reference(a, 'box.face.a'), reference(a, 'box.face.b')]
    );
    expect(
      faceSelectionRepairCandidates(kernel, shape, [hashes[0]!])
    ).toBeNull();
  });

  it('refuses a name published on two faces', () => {
    const [a, b] = [plane(1), plane(2)];
    const { shape, hashes } = body(
      [a, b],
      [reference(a, 'box.face.a'), reference(b, 'box.face.a')]
    );
    expect(
      faceSelectionRepairCandidates(kernel, shape, [hashes[0]!])
    ).toBeNull();
  });

  it('refuses a name whose witness the face no longer measures', () => {
    const [a, b] = [plane(1), plane(2)];
    // The published name claims face 1 with a different witness but the
    // same hash: the name cannot vouch for the face the hash found.
    const claimed = {
      ...reference(b, 'box.face.a'),
      currentHash: topologyHashOfWitness('face', a)
    };
    const { shape, hashes } = body([a], [claimed]);
    expect(faceSelectionRepairCandidates(kernel, shape, hashes)).toBeNull();
  });

  it('refuses a body of several solids and a body with no lineage', () => {
    const a = plane(1);
    const { shape, hashes } = body([a], [reference(a, 'box.face.a')]);
    expect(
      faceSelectionRepairCandidates(
        kernel,
        { ...shape, solids: [7, 8] },
        hashes
      )
    ).toBeNull();
    expect(
      faceSelectionRepairCandidates(kernel, { solids: [7] }, hashes)
    ).toBeNull();
  });
});
