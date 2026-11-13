import type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId
} from '@openzcad/shared';
import { describe, expect, it } from 'vitest';
import {
  deriveRemusPredictedCarrierDirectEditLineage,
  type RemusLineageState,
  type RemusTopologyCandidate
} from './remus-lineage';
import { topologyHashOfWitness } from './topology-lineage';

const PRIMITIVE = 'feature_box' as FeatureId;
const UNIT = 1_000_000_000;

function plane(
  normal: [number, number, number],
  offset: number,
  perimeter: number,
  centroid: [number, number, number]
): FaceWitnessV1 {
  return {
    surfaceType: 'plane',
    perimeter,
    centroid,
    analytic: { kind: 'plane', normal, offset },
    closure: { u: 'open', v: 'open' }
  };
}

function cylinder(radius: number, perimeter: number): FaceWitnessV1 {
  return {
    surfaceType: 'cylinder',
    perimeter,
    centroid: [0, 0, 5],
    analytic: {
      kind: 'cylinder',
      axis: [0, 0, UNIT],
      axisFoot: [0, 0, 0],
      radius
    },
    closure: { u: 'closed', v: 'open' }
  };
}

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

function reference(
  lineageName: string,
  witness: FaceWitnessV1
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId: PRIMITIVE,
    lineageName,
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness
  };
}

function face(handle: number, witness: FaceWitnessV1): RemusTopologyCandidate {
  return { handle, kind: 'face', witness };
}

/** Source faces, each named after its key unless `unnamed` lists it. */
function sourceOf(
  faces: Record<string, [number, FaceWitnessV1]>,
  unnamed: readonly string[] = []
): { state: RemusLineageState; candidates: RemusTopologyCandidate[] } {
  const state: RemusLineageState = {
    faceReferences: new Map(),
    edgeReferences: new Map(),
    diagnostics: []
  };
  const candidates: RemusTopologyCandidate[] = [];
  for (const [name, [handle, witness]] of Object.entries(faces)) {
    candidates.push(face(handle, witness));
    if (!unnamed.includes(name))
      state.faceReferences.set(handle, reference(name, witness));
  }
  return { state, candidates };
}

function namesOf(state: RemusLineageState | undefined): Map<number, string> {
  return new Map(
    [...(state?.faceReferences ?? [])].map(([handle, ref]) => [
      handle,
      ref.lineageName
    ])
  );
}

const TOP = plane([0, 0, UNIT], 10_000_000, 120_000_000, [0, 0, 10_000_000]);
const SIDE = plane([UNIT, 0, 0], 15_000_000, 80_000_000, [15_000_000, 0, 0]);
const WALL = cylinder(6_000_000, 90_000_000);

describe('direct-edit lineage by exact predicted carrier', () => {
  it('carries untouched faces by carrier and the edited face to its predicted carrier', () => {
    const { state, candidates } = sourceOf({
      top: [1, TOP],
      side: [2, SIDE],
      wall: [3, WALL]
    });
    // Every result witness differs from its source: the resize re-trims the
    // planes, and the wall moves to its new radius.
    const top: FaceWitnessV1 = {
      ...TOP,
      perimeter: 118_000_000,
      centroid: [1, 0, 10]
    };
    const side = { ...SIDE, perimeter: 81_000_000 };
    const wall = cylinder(8_000_000, 110_000_000);
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [face(11, top), face(12, side), face(13, wall)],
      predicted: new Map([[3, wall.analytic]])
    });
    expect(namesOf(lineage)).toEqual(
      new Map([
        [11, 'top'],
        [12, 'side'],
        [13, 'wall']
      ])
    );
    // The carried reference records the measured result witness.
    const carried = lineage!.faceReferences.get(13)!;
    expect(carried.witness).toEqual(wall);
    expect(carried.currentHash).toBe(topologyHashOfWitness('face', wall));
    expect(carried.producingFeatureId).toBe(PRIMITIVE);
  });

  it('publishes no name for two coplanar faces sharing a carrier', () => {
    // Two named faces on one plane: a carrier cannot tell them apart, so
    // neither is carried, whether the result keeps both or merges them.
    const left = plane([0, 0, UNIT], 10_000_000, 40_000_000, [-5, 0, 10]);
    const right = plane([0, 0, UNIT], 10_000_000, 40_000_000, [5, 0, 10]);
    const { state, candidates } = sourceOf({
      left: [1, left],
      right: [2, right],
      side: [3, SIDE]
    });
    for (const results of [
      [
        face(11, { ...left, perimeter: 41_000_000 }),
        face(12, { ...right, perimeter: 41_000_000 })
      ],
      [face(11, { ...left, perimeter: 82_000_000, centroid: [0, 0, 10] })]
    ]) {
      const lineage = deriveRemusPredictedCarrierDirectEditLineage({
        source: state,
        sourceCandidates: candidates,
        resultCandidates: [
          ...results,
          face(13, { ...SIDE, perimeter: 79_000_000 })
        ],
        predicted: new Map()
      });
      expect(namesOf(lineage)).toEqual(new Map([[13, 'side']]));
    }
  });

  it('fails closed when an unnamed source face shares the carrier', () => {
    const twin = plane([0, 0, UNIT], 10_000_000, 30_000_000, [9, 9, 10]);
    const { state, candidates } = sourceOf({ top: [1, TOP], twin: [2, twin] }, [
      'twin'
    ]);
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [face(11, { ...TOP, perimeter: 1 })],
      predicted: new Map()
    });
    expect(namesOf(lineage)).toEqual(new Map());
  });

  it('fails closed when the result splits the carrier', () => {
    const { state, candidates } = sourceOf({ top: [1, TOP] });
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [
        face(11, { ...TOP, perimeter: 50_000_000, centroid: [-5, 0, 10] }),
        face(12, { ...TOP, perimeter: 50_000_000, centroid: [5, 0, 10] })
      ],
      predicted: new Map()
    });
    expect(namesOf(lineage)).toEqual(new Map());
  });

  it('refuses both names when the edited face is predicted onto another face’s carrier', () => {
    const lower = plane([0, 0, UNIT], 4_000_000, 60_000_000, [0, 0, 4]);
    const { state, candidates } = sourceOf({
      top: [1, TOP],
      lower: [2, lower]
    });
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [face(11, { ...lower, perimeter: 120_000_000 })],
      predicted: new Map([[1, lower.analytic]])
    });
    expect(namesOf(lineage)).toEqual(new Map());
  });

  it('carries nothing onto a face whose surface the command does not determine', () => {
    const band = cylinder(2_000_000, 30_000_000);
    const { state, candidates } = sourceOf({ band: [1, band], top: [2, TOP] });
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      // The rebuilt band happens to land on the old band's carrier.
      resultCandidates: [
        face(11, { ...band, perimeter: 31_000_000 }),
        face(12, { ...TOP, perimeter: 1 })
      ],
      predicted: new Map([[1, null]])
    });
    expect(namesOf(lineage)).toEqual(new Map([[12, 'top']]));
  });

  it('does not carry a source reference its own body no longer verifies', () => {
    const { state } = sourceOf({ top: [1, TOP] });
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      // The measured source face no longer has the reference's witness.
      sourceCandidates: [face(1, { ...TOP, perimeter: TOP.perimeter + 1 })],
      resultCandidates: [face(11, { ...TOP, perimeter: 5 })],
      predicted: new Map()
    });
    expect(namesOf(lineage)).toEqual(new Map());
  });

  it('carries non-analytic faces and edges only when their exact witness is unchanged', () => {
    const freeform: FaceWitnessV1 = {
      surfaceType: 'torus',
      perimeter: 20_000_000,
      centroid: [0, 0, 12],
      analytic: { kind: 'none' },
      closure: { u: 'closed', v: 'closed' }
    };
    const { state, candidates } = sourceOf({ band: [1, freeform] });
    const edge: EdgeTopologyReferenceV5 = {
      kind: 'edge',
      producingFeatureId: PRIMITIVE,
      lineageName: 'edge.x',
      currentHash: topologyHashOfWitness('edge', EDGE),
      witnessVersion: 1,
      witness: EDGE
    };
    state.edgeReferences.set(5, edge);
    const unchanged = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [
        face(11, freeform),
        { handle: 15, kind: 'edge', witness: EDGE }
      ],
      predicted: new Map()
    });
    expect(namesOf(unchanged)).toEqual(new Map([[11, 'band']]));
    expect(unchanged!.edgeReferences.get(15)?.lineageName).toBe('edge.x');
    const changed = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [
        face(11, { ...freeform, perimeter: 21_000_000 }),
        { handle: 15, kind: 'edge', witness: { ...EDGE, length: 11 } }
      ],
      predicted: new Map()
    });
    expect(namesOf(changed)).toEqual(new Map());
    expect(changed!.edgeReferences.size).toBe(0);
  });

  it('withholds a carrier name the retired positional reader placed elsewhere', () => {
    // A boss resize journaled by inference: the retired reader put "side"
    // on the top and "top" on the side. A document saved then stores those
    // names with the other face's witness, so neither carrier name may be
    // published; an unchanged witness still proves its face.
    const lower = plane([0, 0, UNIT], 0, 120_000_000, [0, 0, 0]);
    const { state, candidates } = sourceOf({
      top: [1, TOP],
      side: [2, SIDE],
      bottom: [3, lower]
    });
    const lineage = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [
        face(11, { ...TOP, perimeter: 1 }),
        face(12, { ...SIDE, perimeter: 2 }),
        face(13, lower)
      ],
      predicted: new Map(),
      retiredPlacements: new Map([
        [1, 12],
        [2, 11],
        [3, 11]
      ])
    });
    expect(namesOf(lineage)).toEqual(new Map([[13, 'bottom']]));
    // Where the retired reading agrees, the carrier name is published.
    const agreeing = deriveRemusPredictedCarrierDirectEditLineage({
      source: state,
      sourceCandidates: candidates,
      resultCandidates: [
        face(11, { ...TOP, perimeter: 1 }),
        face(12, { ...SIDE, perimeter: 2 })
      ],
      predicted: new Map(),
      retiredPlacements: new Map([
        [1, 11],
        [2, 12]
      ])
    });
    expect(namesOf(agreeing)).toEqual(
      new Map([
        [11, 'top'],
        [12, 'side']
      ])
    );
  });

  it('publishes nothing without a source lineage', () => {
    expect(
      deriveRemusPredictedCarrierDirectEditLineage({
        source: undefined,
        sourceCandidates: [face(1, TOP)],
        resultCandidates: [face(11, TOP)],
        predicted: new Map()
      })
    ).toBeUndefined();
  });
});
