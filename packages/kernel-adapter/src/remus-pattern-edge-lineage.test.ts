import { describe, expect, it, vi } from 'vitest';
import { toFeatureId, type EdgeWitnessV1 } from '@openzcad/shared';
import {
  createRemusSemanticLineage,
  deriveRemusPatternInstanceLineage,
  type RemusTopologyCandidate
} from './remus-lineage';
import { topologyHashOfWitness } from './topology-lineage';
import { patternJournalEdgeOutputs } from './exact-lineage-builders';
import type { RemusKernel } from './remus-runtime';

const witness: EdgeWitnessV1 = {
  curveType: 'LINE',
  closed: false,
  length: 10,
  endpoints: [
    [0, 0, 0],
    [10, 0, 0]
  ],
  midpoint: [5, 0, 0]
};
const edge = (handle: number, at = 0): RemusTopologyCandidate => ({
  handle,
  kind: 'edge',
  witness: {
    ...witness,
    endpoints: [
      [0, at, 0],
      [10, at, 0]
    ],
    midpoint: [5, at, 0]
  }
});
function fixture() {
  const sourceCandidates = [edge(1), edge(2, 20)];
  return {
    producingFeatureId: toFeatureId('grid'),
    sourceCandidates,
    sourceLineage: createRemusSemanticLineage(
      toFeatureId('source'),
      'primitive',
      sourceCandidates.map((candidate, index) => ({
        ...candidate,
        lineageName: `source.edge.${index}`
      }))
    ),
    instances: [
      {
        instance: '1-0',
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        candidates: [edge(11), edge(12, 20)],
        journalEdges: new Set([11, 12])
      }
    ]
  };
}

describe('grid edge witness qualification', () => {
  it('refuses an understated event count that would bypass the ordinal scan budget', () => {
    // 150 native producer members: 900F + 1800E + 1200V = 3900 events.
    // The false 1800 event count claims 3,241,800 visits, while the actual
    // 1801 ordinal scans would visit 7,023,900 events. This helper-level
    // adversary does not expand the feature's existing 100-solid cap.
    const outputs = vi.fn((_op: number, _kind: string, index: number) =>
      JSON.stringify(
        index < 1800
          ? {
              status: 'bound',
              provenance: 'construction',
              entities: [{ kind: 'edge', handle: index }]
            }
          : { status: 'noMatch' }
      )
    );
    const kernel = {
      getSolidFaces: (solid: number) =>
        Uint32Array.from({ length: 6 }, (_, index) => solid * 6 + index),
      getSolidEdges: (solid: number) =>
        Uint32Array.from({ length: 12 }, (_, index) => solid * 12 + index),
      getSolidVertices: (solid: number) =>
        Uint32Array.from({ length: 8 }, (_, index) => solid * 8 + index),
      journalSummary: () =>
        JSON.stringify([
          {
            op: 7,
            kind: 'grid_pattern',
            type: 'evolution',
            detail: { origin: 'construction', events: 1800 }
          }
        ]),
      resolveOperationOutput: outputs
    } as unknown as RemusKernel;
    const result = patternJournalEdgeOutputs(
      kernel,
      7,
      Array.from({ length: 150 }, (_, index) => index)
    );
    expect({
      declined: result === null,
      ordinalCalls: outputs.mock.calls.length
    }).toEqual({ declined: true, ordinalCalls: 0 });
  });

  it('publishes only the unique, reverified source-to-transformed-edge roles', () => {
    const result = deriveRemusPatternInstanceLineage(fixture());
    expect(
      [...result.edgeReferences].map(([handle, reference]) => [
        handle,
        reference.lineageName
      ])
    ).toEqual([
      [11, 'pattern.edge.instance.1-0.source.edge.0'],
      [12, 'pattern.edge.instance.1-0.source.edge.1']
    ]);
  });

  it('declines a stale source witness and hash rather than naming its copy', () => {
    const input = fixture();
    input.sourceLineage.edgeReferences.get(1)!.currentHash += 1;
    const result = deriveRemusPatternInstanceLineage(input);
    expect([...result.edgeReferences.keys()]).toEqual([12]);
    const staleWitness = fixture();
    staleWitness.sourceCandidates[0] = edge(1, 50);
    expect([
      ...deriveRemusPatternInstanceLineage(staleWitness).edgeReferences.keys()
    ]).toEqual([12]);
  });

  it('declines both duplicate source identities', () => {
    const input = fixture();
    input.sourceLineage.edgeReferences.get(2)!.lineageName = 'source.edge.0';
    expect(deriveRemusPatternInstanceLineage(input).edgeReferences.size).toBe(
      0
    );
  });

  it('declines conflicting source roles for one result', () => {
    const input = fixture();
    input.sourceCandidates[1] = edge(2);
    const reference = input.sourceLineage.edgeReferences.get(2)!;
    reference.witness = witness;
    reference.currentHash = topologyHashOfWitness('edge', witness);
    expect(deriveRemusPatternInstanceLineage(input).edgeReferences.size).toBe(
      0
    );
  });

  it('declines ambiguous result witnesses, incomplete sets and phantom subjects', () => {
    const duplicate = fixture();
    duplicate.instances[0]!.candidates.push(edge(13));
    duplicate.instances[0]!.journalEdges.add(13);
    expect([
      ...deriveRemusPatternInstanceLineage(duplicate).edgeReferences.keys()
    ]).toEqual([12]);
    const missing = fixture();
    missing.instances[0]!.journalEdges.delete(11);
    expect(deriveRemusPatternInstanceLineage(missing).edgeReferences.size).toBe(
      0
    );
    const phantom = fixture();
    phantom.instances[0]!.journalEdges.add(99);
    expect(deriveRemusPatternInstanceLineage(phantom).edgeReferences.size).toBe(
      0
    );
  });

  it('declines unsupported closed NURBS witnesses even when journal subjects match', () => {
    const input = fixture();
    const unsupported: EdgeWitnessV1 = {
      curveType: 'NURBS',
      closed: true,
      length: 10,
      center: [0, 0, 0],
      axis: [0, 0, 1_000_000_000]
    };
    const reference = input.sourceLineage.edgeReferences.get(1)!;
    input.sourceCandidates[0] = {
      ...input.sourceCandidates[0]!,
      witness: unsupported
    };
    input.instances[0]!.candidates[0] = {
      ...input.instances[0]!.candidates[0]!,
      witness: unsupported
    };
    reference.witness = unsupported;
    // Retain a valid hash so the refusal demonstrates the unsupported class.
    reference.currentHash = topologyHashOfWitness('edge', unsupported);
    input.sourceLineage.edgeReferences.delete(2);
    expect(deriveRemusPatternInstanceLineage(input).edgeReferences.size).toBe(
      0
    );
  });
});
