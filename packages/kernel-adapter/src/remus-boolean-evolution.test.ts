import { describe, expect, it } from 'vitest';
import type { FaceWitnessV1, FeatureId } from '@openzcad/shared';

import { RemusKernel } from './remus-runtime';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import {
  createRemusSemanticLineage,
  decodeRemusBooleanEntityEvolution,
  deriveRemusBooleanCarrierLineage,
  deriveRemusBooleanEvolutionLineage,
  reconcileRemusBooleanLineage,
  type RemusBooleanOperand,
  type RemusLineageState,
  type RemusTopologyCandidate
} from './remus-lineage';

const FEATURE_ID = 'feature_boolean_evolution' as FeatureId;

function rowMajor(tx: number, ty: number, tz: number): Float64Array {
  return new Float64Array([1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]);
}

/** Names every face and edge of an operand, so the carry has something to carry. */
function nameEverything(
  candidates: readonly RemusTopologyCandidate[],
  prefix: string
): RemusLineageState {
  return createRemusSemanticLineage(
    FEATURE_ID,
    'primitive',
    candidates.map((candidate, index) => ({
      ...candidate,
      lineageName: `${prefix}.${candidate.kind}.${index}`
    }))
  );
}

function planeKey(candidate: RemusTopologyCandidate): string {
  const analytic = (candidate.witness as FaceWitnessV1).analytic;
  return analytic.kind === 'plane'
    ? `plane:${analytic.normal.join(',')}:${analytic.offset}`
    : analytic.kind;
}

describe('decodeRemusBooleanEntityEvolution', () => {
  const good = JSON.stringify({
    solid: 2,
    evolution: {
      faces: [
        { face: 9, source: 0 },
        { face: 10, source: 2 }
      ],
      edges: [
        { edge: 15, event: 'modified', from: 0 },
        { edge: 16, event: 'unresolved' },
        { edge: 18, event: 'preserved', from: 2 },
        { edge: 22, event: 'generated', faceA: 2, faceB: 6 }
      ],
      vertices: [{ vertex: 4, event: 'created' }]
    }
  });

  it('decodes the measured payload shape, keeping the four edge events apart', () => {
    const decoded = decodeRemusBooleanEntityEvolution(good);
    expect(decoded.solid).toBe(2);
    expect([...decoded.faces]).toEqual([
      [9, 0],
      [10, 2]
    ]);
    expect([...decoded.edges.preserved]).toEqual([[18, 2]]);
    expect([...decoded.edges.modified]).toEqual([[15, 0]]);
    expect([...decoded.edges.generated]).toEqual([[22, [2, 6]]]);
    expect([...decoded.edges.unresolved]).toEqual([16]);
  });

  it('refuses every malformed payload rather than returning an empty record', () => {
    const rejected = [
      '{}',
      'not json',
      JSON.stringify({ evolution: { faces: [], edges: [] } }),
      JSON.stringify({ solid: -1, evolution: { faces: [], edges: [] } }),
      JSON.stringify({ solid: 1, evolution: { faces: [] } }),
      JSON.stringify({
        solid: 1,
        evolution: { faces: [{ face: 1 }], edges: [] }
      }),
      JSON.stringify({
        solid: 1,
        evolution: {
          faces: [
            { face: 1, source: 0 },
            { face: 1, source: 2 }
          ],
          edges: []
        }
      }),
      JSON.stringify({
        solid: 1,
        evolution: { faces: [], edges: [{ edge: 1, event: 'preserved' }] }
      }),
      // A fifth event the pin does not publish must decline the whole
      // payload, never be dropped as if the kernel had said nothing.
      JSON.stringify({
        solid: 1,
        evolution: { faces: [], edges: [{ edge: 1, event: 'reversed' }] }
      })
    ];
    for (const payload of rejected) {
      expect(() => decodeRemusBooleanEntityEvolution(payload)).toThrow(
        /Remus boolean evolution rejected/
      );
    }
  });
});

describe('boolean entity evolution against the pinned kernel', () => {
  /** A plate carrying two equal-height bosses, fused one at a time. */
  function twoBossPlate() {
    const kernel = new RemusKernel();
    const plate = kernel.makeBox(40, 24, 10);
    const first = kernel.makeCylinder(4, 8);
    kernel.transformSolid(first, rowMajor(10, 12, 10));
    const second = kernel.makeCylinder(4, 8);
    kernel.transformSolid(second, rowMajor(30, 12, 10));
    return { kernel, plate, first, second };
  }

  it('names both caps of two equal-height bosses, which share one carrier', () => {
    const { kernel, plate, first, second } = twoBossPlate();
    const plateCandidates = topologyCandidatesForSolid(kernel, plate);
    const firstCandidates = topologyCandidatesForSolid(kernel, first);
    const step = JSON.parse(kernel.fuseWithEntityEvolution(plate, first)) as {
      solid: number;
    };
    const intermediate = topologyCandidatesForSolid(kernel, step.solid);
    const secondCandidates = topologyCandidatesForSolid(kernel, second);
    const payload = kernel.fuseWithEntityEvolution(step.solid, second);
    const evolution = decodeRemusBooleanEntityEvolution(payload);
    const resultCandidates = topologyCandidatesForSolid(
      kernel,
      evolution.solid
    );

    // Both boss caps land on the same quantized plane, z = 18. One carrier
    // holding two result faces from two different sources is precisely the
    // condition the analytic-carrier rule has to decline on both counts.
    const carrierCounts = new Map<string, number>();
    for (const candidate of resultCandidates) {
      if (candidate.kind !== 'face') continue;
      const key = planeKey(candidate);
      carrierCounts.set(key, (carrierCounts.get(key) ?? 0) + 1);
    }
    expect(
      [...carrierCounts.values()].filter((count) => count > 1)
    ).not.toEqual([]);

    const operands: RemusBooleanOperand[] = [
      {
        lineage: nameEverything(intermediate, 'stack'),
        candidates: intermediate
      },
      {
        lineage: nameEverything(secondCandidates, 'boss'),
        candidates: secondCandidates
      }
    ];
    const carrier = deriveRemusBooleanCarrierLineage({
      producingFeatureId: FEATURE_ID,
      operands,
      resultCandidates
    });
    const derived = deriveRemusBooleanEvolutionLineage({
      producingFeatureId: FEATURE_ID,
      evolution,
      resultSolid: evolution.solid,
      operands,
      resultCandidates
    });

    // The whole point of the row: the kernel reaches faces the geometry
    // alone cannot separate.
    expect(derived.faceReferences.size).toBeGreaterThan(
      carrier.faceReferences.size
    );
    // Every result face that had a named source is named.
    expect(derived.faceReferences.size).toBe(
      resultCandidates.filter((candidate) => candidate.kind === 'face').length
    );

    // And the two derivations never contradict each other.
    const reconciled = reconcileRemusBooleanLineage(carrier, derived);
    expect(
      reconciled.diagnostics.filter(
        (entry) => entry.code === 'boolean-evolution-disagreement'
      )
    ).toEqual([]);
    for (const [handle, reference] of carrier.faceReferences) {
      expect(reconciled.faceReferences.get(handle)?.lineageName).toBe(
        reference.lineageName
      );
    }
    // The first fuse's own operands are measured only to prove the fixture
    // built the body the second fuse consumes.
    expect(plateCandidates.length).toBeGreaterThan(0);
    expect(firstCandidates.length).toBeGreaterThan(0);
  });

  it('publishes nothing for a source the boolean genuinely split', () => {
    const kernel = new RemusKernel();
    const plate = kernel.makeBox(40, 24, 10);
    const slot = kernel.makeBox(6, 40, 6);
    kernel.transformSolid(slot, rowMajor(17, -8, 6));
    const plateCandidates = topologyCandidatesForSolid(kernel, plate);
    const slotCandidates = topologyCandidatesForSolid(kernel, slot);
    const evolution = decodeRemusBooleanEntityEvolution(
      kernel.cutWithEntityEvolution(plate, slot)
    );
    const resultCandidates = topologyCandidatesForSolid(
      kernel,
      evolution.solid
    );
    const derived = deriveRemusBooleanEvolutionLineage({
      producingFeatureId: FEATURE_ID,
      evolution,
      resultSolid: evolution.solid,
      operands: [
        {
          lineage: nameEverything(plateCandidates, 'plate'),
          candidates: plateCandidates,
          role: 'target'
        },
        {
          lineage: nameEverything(slotCandidates, 'slot'),
          candidates: slotCandidates,
          role: 'tool'
        }
      ],
      resultCandidates
    });
    const splits = derived.diagnostics.filter(
      (entry) => entry.code === 'boolean-split-source'
    );
    expect(splits.length).toBeGreaterThan(0);
    for (const split of splits) {
      for (const handle of split.resultHandles ?? []) {
        expect(derived.faceReferences.has(handle)).toBe(false);
      }
    }
  });

  it('refuses the whole payload when it does not name the production result', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(20, 20, 10);
    const tool = kernel.makeBox(6, 6, 6);
    kernel.transformSolid(tool, rowMajor(7, 7, 6));
    const boxCandidates = topologyCandidatesForSolid(kernel, box);
    const toolCandidates = topologyCandidatesForSolid(kernel, tool);
    const evolution = decodeRemusBooleanEntityEvolution(
      kernel.cutWithEntityEvolution(box, tool)
    );
    const resultCandidates = topologyCandidatesForSolid(
      kernel,
      evolution.solid
    );
    const operands: RemusBooleanOperand[] = [
      {
        lineage: nameEverything(boxCandidates, 'box'),
        candidates: boxCandidates,
        role: 'target'
      },
      {
        lineage: nameEverything(toolCandidates, 'tool'),
        candidates: toolCandidates,
        role: 'tool'
      }
    ];
    const wrongResult = deriveRemusBooleanEvolutionLineage({
      producingFeatureId: FEATURE_ID,
      evolution,
      resultSolid: evolution.solid + 1,
      operands,
      resultCandidates
    });
    expect(wrongResult.faceReferences.size).toBe(0);
    expect(wrongResult.diagnostics[0]?.code).toBe('hash-only');

    // A result domain the payload does not cover is refused whole, never
    // consumed in part.
    const truncated = deriveRemusBooleanEvolutionLineage({
      producingFeatureId: FEATURE_ID,
      evolution,
      resultSolid: evolution.solid,
      operands,
      resultCandidates: resultCandidates.slice(1)
    });
    expect(truncated.faceReferences.size).toBe(0);
    expect(truncated.diagnostics[0]?.code).toBe('hash-only');
  });

  it('leaves every unresolved edge hash-only and says how many', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(20, 20, 10);
    const bore = kernel.makeCylinder(3, 30);
    kernel.transformSolid(bore, rowMajor(10, 10, -5));
    const boxCandidates = topologyCandidatesForSolid(kernel, box);
    const boreCandidates = topologyCandidatesForSolid(kernel, bore);
    const evolution = decodeRemusBooleanEntityEvolution(
      kernel.cutWithEntityEvolution(box, bore)
    );
    expect(evolution.edges.unresolved.size).toBeGreaterThan(0);
    const resultCandidates = topologyCandidatesForSolid(
      kernel,
      evolution.solid
    );
    const derived = deriveRemusBooleanEvolutionLineage({
      producingFeatureId: FEATURE_ID,
      evolution,
      resultSolid: evolution.solid,
      operands: [
        {
          lineage: nameEverything(boxCandidates, 'box'),
          candidates: boxCandidates,
          role: 'target'
        },
        {
          lineage: nameEverything(boreCandidates, 'bore'),
          candidates: boreCandidates,
          role: 'tool'
        }
      ],
      resultCandidates
    });
    for (const handle of evolution.edges.unresolved) {
      expect(derived.edgeReferences.has(handle)).toBe(false);
    }
    expect(
      derived.diagnostics.some(
        (entry) => entry.code === 'boolean-edge-unresolved'
      )
    ).toBe(true);
    // Neither are the edges the boolean modified or generated: only the
    // `preserved` event has an exact witness relation to verify against.
    for (const handle of evolution.edges.modified.keys()) {
      expect(derived.edgeReferences.has(handle)).toBe(false);
    }
    for (const handle of evolution.edges.generated.keys()) {
      expect(derived.edgeReferences.has(handle)).toBe(false);
    }
    expect(derived.edgeReferences.size).toBe(evolution.edges.preserved.size);
  });
});
