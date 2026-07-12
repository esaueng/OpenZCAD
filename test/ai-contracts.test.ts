import { describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  parseCadPatchProposal
} from '@openzcad/ai-contracts';
import {
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

describe('AI patch contracts', () => {
  it('accepts a structured patch proposal', () => {
    expect(
      parseCadPatchProposal({
        proposalId: 'proposal_1',
        summary: 'Increase the bracket width.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter', name: 'width', expression: '100 mm' }
        ]
      }).operations
    ).toHaveLength(1);
  });

  it('rejects unrecognized operations and empty patches', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_1',
        summary: 'Do something unsafe.',
        assumptions: [],
        operations: [{ kind: 'execute_code', source: '...' }]
      })
    ).toThrow(/Unsupported/);
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_2',
        summary: 'No-op.',
        assumptions: [],
        operations: []
      })
    ).toThrow(/required fields/);
  });

  it('accepts exact finishing and pattern operations', () => {
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_finish',
      summary: 'Fillet the selected edge and pattern the result.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'Edge fillet',
          modifier: 'fillet',
          targetBodyId: 'body_1',
          edgeHashes: [3],
          size: 2
        },
        {
          kind: 'add_pattern',
          name: 'Three across',
          targetBodyId: 'body_1',
          patternKind: 'linear',
          count: 3,
          axis: 'x',
          spacing: 40,
          angleDeg: 360
        }
      ]
    });
    expect(proposal.operations.map((operation) => operation.kind)).toEqual([
      'add_edge_modifier',
      'add_pattern'
    ]);
  });

  it('rejects an edge modifier without a valid exact edge ordinal', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_bad_edge',
        summary: 'Guess an edge.',
        assumptions: [],
        operations: [
          {
            kind: 'add_edge_modifier',
            name: 'Bad fillet',
            modifier: 'fillet',
            targetBodyId: 'body_1',
            edgeHashes: [0],
            size: 2
          }
        ]
      })
    ).toThrow(/edge_modifier/);
  });

  it('omits embedded geometry payloads from model context', () => {
    const imported = importStepBody(
      createProjectDocument('Imported', toUserId('user_ai')),
      {
        name: 'Imported STEP',
        artifactId: 'artifact_ai',
        sourceName: 'large.step',
        stepText: 'SECRET_GEOMETRY_PAYLOAD'.repeat(1_000)
      }
    ).document;
    const digest = createCadDocumentDigest(imported);
    const serialized = JSON.stringify(digest);
    expect(serialized).not.toContain('SECRET_GEOMETRY_PAYLOAD');
    expect(digest.features[0]?.data).toMatchObject({
      featureKind: 'imported-step',
      sourceName: 'large.step'
    });
  });
});
