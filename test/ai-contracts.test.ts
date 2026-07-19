import { describe, expect, it } from 'vitest';
import {
  CAD_PATCH_JSON_SCHEMA,
  createCadDocumentDigest,
  groundCadPatchProposalToSelection,
  parseCadPatchProposal
} from '@openzcad/ai-contracts';
import {
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { toBodyId, toFeatureId, toUserId } from '@openzcad/shared';

describe('AI patch contracts', () => {
  it('declares a type for every strict-schema constant', () => {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return;
      }
      const candidate = value as Record<string, unknown>;
      if ('const' in candidate) {
        expect(candidate.type).toBe(typeof candidate.const);
      }
      for (const child of Object.values(candidate)) {
        if (Array.isArray(child)) {
          child.forEach(visit);
        } else {
          visit(child);
        }
      }
    };

    visit(CAD_PATCH_JSON_SCHEMA);
  });

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

  it('accepts a local alias declared before it is referenced', () => {
    expect(
      parseCadPatchProposal({
        proposalId: 'proposal_alias',
        summary: 'Hollow a block.',
        assumptions: [],
        operations: [
          {
            kind: 'add_primitive',
            name: 'Shell',
            localId: 'shell',
            primitiveKind: 'box',
            dimensions: {
              width: 40,
              height: 40,
              depth: 40,
              radius: null,
              bottomRadius: null,
              topRadius: null,
              majorRadius: null,
              minorRadius: null
            }
          },
          {
            kind: 'add_primitive',
            name: 'Cavity',
            localId: 'cavity',
            primitiveKind: 'box',
            dimensions: {
              width: 36,
              height: 36,
              depth: 36,
              radius: null,
              bottomRadius: null,
              topRadius: null,
              majorRadius: null,
              minorRadius: null
            }
          },
          {
            kind: 'add_boolean',
            name: 'Shelled',
            localId: 'shelled',
            operation: 'subtract',
            targetBodyIds: ['$shell', '$cavity']
          }
        ]
      }).operations
    ).toHaveLength(3);
  });

  it('rejects a reference to an alias no operation declares', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_dangling',
        summary: 'Move a body that is never created.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move ghost',
            targetBodyId: '$ghost',
            translation: { x: 1, y: 2, z: 3 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/before any operation declares that localId/);
  });

  it('rejects an alias referenced before it is declared', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_forward',
        summary: 'Reference a later body.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move too early',
            targetBodyId: '$late',
            translation: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          },
          {
            kind: 'add_primitive',
            name: 'Late',
            localId: 'late',
            primitiveKind: 'sphere',
            dimensions: {
              width: null,
              height: null,
              depth: null,
              radius: 5,
              bottomRadius: null,
              topRadius: null,
              majorRadius: null,
              minorRadius: null
            }
          }
        ]
      })
    ).toThrow(/before any operation declares that localId/);
  });

  it('rejects a duplicate local alias', () => {
    const sphere = (localId: string) => ({
      kind: 'add_primitive',
      name: 'Ball',
      localId,
      primitiveKind: 'sphere',
      dimensions: {
        width: null,
        height: null,
        depth: null,
        radius: 5,
        bottomRadius: null,
        topRadius: null,
        majorRadius: null,
        minorRadius: null
      }
    });
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_duplicate',
        summary: 'Declare the same alias twice.',
        assumptions: [],
        operations: [sphere('ball'), sphere('ball')]
      })
    ).toThrow(/Duplicate localId/);
  });

  it('rejects an operation that references its own result', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_self',
        summary: 'Subtract a body from itself.',
        assumptions: [],
        operations: [
          {
            kind: 'add_boolean',
            name: 'Self',
            localId: 'self',
            operation: 'subtract',
            targetBodyIds: ['$self', 'body_1']
          }
        ]
      })
    ).toThrow(/before any operation declares that localId/);
  });

  it('rejects filleting a body created in the same proposal', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_local_fillet',
        summary: 'Fillet a brand new body.',
        assumptions: [],
        operations: [
          {
            kind: 'add_primitive',
            name: 'Block',
            localId: 'block',
            primitiveKind: 'box',
            dimensions: {
              width: 10,
              height: 10,
              depth: 10,
              radius: null,
              bottomRadius: null,
              topRadius: null,
              majorRadius: null,
              minorRadius: null
            }
          },
          {
            kind: 'add_edge_modifier',
            name: 'Round it',
            localId: null,
            modifier: 'fillet',
            targetBodyId: '$block',
            edgeHashes: [1],
            size: 2
          }
        ]
      })
    ).toThrow(/cannot target a body created in the same proposal/);
  });

  it('rejects a boolean that lists the same body twice', () => {
    expect(() =>
      parseCadPatchProposal({
        proposalId: 'proposal_self_subtract',
        summary: 'Subtract a body from itself.',
        assumptions: [],
        operations: [
          {
            kind: 'add_boolean',
            name: 'Degenerate',
            localId: null,
            operation: 'subtract',
            targetBodyIds: ['body_1', 'body_1']
          }
        ]
      })
    ).toThrow(/same body more than once/);
  });

  it('reports which bodies are live and where they sit', () => {
    const document = createProjectDocument('Bodies', toUserId('user_ai'));
    const digest = createCadDocumentDigest(document);
    expect(digest.bodies).toEqual([]);
    // Meshes must never reach model context, only identity and placement.
    expect(JSON.stringify(digest)).not.toContain('vertices');
  });

  it('captures the complete feature, body, and topology selection in pick order', () => {
    const document = createProjectDocument('Selected edges', toUserId('user_ai'));
    const bodyId = toBodyId('body_selected');
    const digest = createCadDocumentDigest(document, {
      featureIds: [toFeatureId('feature_selected')],
      bodyIds: [bodyId],
      topologies: [
        { bodyId, kind: 'edge', topologyId: 'edge:9', hash: 109 },
        { bodyId, kind: 'edge', topologyId: 'edge:12', hash: 212 }
      ]
    });

    expect(digest.selection).toEqual({
      featureIds: ['feature_selected'],
      bodyIds: ['body_selected'],
      topologies: [
        {
          bodyId: 'body_selected',
          kind: 'edge',
          topologyId: 'edge:9',
          hash: 109
        },
        {
          bodyId: 'body_selected',
          kind: 'edge',
          topologyId: 'edge:12',
          hash: 212
        }
      ]
    });
  });

  it('grounds a selected-edge proposal onto every picked edge', () => {
    const document = createProjectDocument('Selected edges', toUserId('user_ai'));
    const bodyId = toBodyId('body_selected');
    const digest = createCadDocumentDigest(document, {
      featureIds: [],
      bodyIds: [bodyId],
      topologies: [
        { bodyId, kind: 'edge', topologyId: 'edge:9', hash: 109 },
        { bodyId, kind: 'edge', topologyId: 'edge:12', hash: 212 }
      ]
    });
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_selected_edges',
      summary: 'Fillet the selected edges.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'Selected edge fillets',
          localId: null,
          modifier: 'fillet',
          targetBodyId: 'body_hallucinated',
          edgeHashes: [999],
          size: 5
        }
      ]
    });

    expect(
      groundCadPatchProposalToSelection(
        'Add fillets of 5 mm on the selected edges',
        digest,
        proposal
      ).operations[0]
    ).toMatchObject({
      targetBodyId: 'body_selected',
      edgeHashes: [109, 212],
      size: 5
    });
  });

  it('does not retarget an edge modifier without an explicit selection reference', () => {
    const document = createProjectDocument('Selected edges', toUserId('user_ai'));
    const bodyId = toBodyId('body_selected');
    const digest = createCadDocumentDigest(document, {
      featureIds: [],
      bodyIds: [bodyId],
      topologies: [
        { bodyId, kind: 'edge', topologyId: 'edge:9', hash: 109 }
      ]
    });
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_named_edge',
      summary: 'Fillet edge 3.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'Named edge fillet',
          localId: null,
          modifier: 'fillet',
          targetBodyId: 'body_named',
          edgeHashes: [303],
          size: 2
        }
      ]
    });

    expect(
      groundCadPatchProposalToSelection('Fillet edge 3', digest, proposal)
    ).toBe(proposal);
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
