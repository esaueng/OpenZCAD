import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toFeatureId,
  toUserId,
  type EdgeTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';
import { preflightCadPatch } from './aiPatchPreflight';

const proposal = {
  proposalId: 'proposal_exact_box',
  summary: 'Add one box',
  assumptions: [],
  operations: [
    {
      kind: 'add_primitive' as const,
      name: 'Exact box',
      primitiveKind: 'box' as const,
      dimensions: {
        width: 10,
        height: 20,
        depth: 30,
        radius: null,
        bottomRadius: null,
        topRadius: null,
        majorRadius: null,
        minorRadius: null
      },
      localId: 'box'
    }
  ]
};

function exactDerived(candidate: ProjectDocument): ProjectDocument['derived'] {
  const bodyId = candidate.bodyOrder[0]!;
  return {
    bodyRepresentations: {
      [bodyId]: {
        bodyId,
        name: 'Exact box',
        source: 'primitive',
        color: '#fff',
        consumed: false,
        exportableStep: true,
        mesh: { kind: 'mesh', vertices: [], indices: [] },
        faceCount: 6,
        volume: 6000,
        bbox: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 10, y: 20, z: 30 }
        }
      }
    },
    exportableBodyIds: [bodyId],
    warnings: [],
    updatedAt: candidate.derived.updatedAt
  };
}

describe('AI exact patch preflight', () => {
  it('returns the exact candidate and deterministic commands used by Apply', async () => {
    const base = createProjectDocument('AI', toUserId('user_ai'));
    const derive = vi.fn(async (candidate: ProjectDocument) =>
      exactDerived(candidate)
    );

    const result = await preflightCadPatch(base, proposal, derive);

    expect(derive).toHaveBeenCalledOnce();
    expect(result.commands).toHaveLength(1);
    expect(result.candidate.derived.warnings).toEqual([]);
    expect(result.targets[0]?.featureName).toBe('Exact box');
  });

  it('rejects an exact warning or missing result without touching the base', async () => {
    const base = createProjectDocument('AI', toUserId('user_ai'));
    const snapshot = structuredClone(base);
    await expect(
      preflightCadPatch(base, proposal, async (candidate) => ({
        ...exactDerived(candidate),
        warnings: ['Feature "Exact box": exact construction failed.']
      }))
    ).rejects.toThrow(/exact construction failed/);
    await expect(
      preflightCadPatch(base, proposal, async (candidate) => ({
        ...exactDerived(candidate),
        bodyRepresentations: {}
      }))
    ).rejects.toThrow(/expected exact result body/);
    expect(base).toEqual(snapshot);
  });

  it('does not reclassify a pre-existing exact warning as a patch failure', async () => {
    const base = createProjectDocument('AI', toUserId('user_ai'));
    base.derived.warnings = ['Existing legacy warning'];

    await expect(
      preflightCadPatch(base, proposal, async (candidate) => ({
        ...exactDerived(candidate),
        warnings: ['Existing legacy warning']
      }))
    ).resolves.toBeTruthy();
  });

  it('requires verified parameterization recipes to preserve exact geometry', async () => {
    const manager = new CommandManager(
      createProjectDocument('AI', toUserId('user_ai'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Exact box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      })
    );
    const featureId = manager.document.featureOrder[0]!;
    const base = manager.document;
    base.derived = exactDerived(base);
    const parameterize = {
      proposalId: 'auto_parameterize_test',
      summary: 'Bind the width without changing the box.',
      assumptions: [],
      preserveGeometry: true as const,
      operations: [
        {
          kind: 'set_parameter' as const,
          name: 'box_width',
          expression: '10'
        },
        {
          kind: 'set_feature_dimension' as const,
          featureId,
          field: 'width',
          value: 'box_width'
        }
      ]
    };

    await expect(
      preflightCadPatch(base, parameterize, async (candidate) =>
        exactDerived(candidate)
      )
    ).resolves.toBeTruthy();
    await expect(
      preflightCadPatch(base, parameterize, async (candidate) => {
        const changed = exactDerived(candidate);
        const bodyId = candidate.bodyOrder[0]!;
        changed.bodyRepresentations[bodyId]!.bbox.max.x = 10.01;
        return changed;
      })
    ).rejects.toThrow(/changed the exact geometry/);
  });

  it('materializes a final same-proposal rim chamfer from exact topology', async () => {
    const base = createProjectDocument('AI', toUserId('user_ai'));
    const stagedProposal = {
      proposalId: 'proposal_staged_chamfer',
      summary: 'Create and chamfer a shaft.',
      assumptions: [],
      operations: [
        {
          kind: 'add_primitive' as const,
          name: 'Shaft',
          localId: 'shaft',
          primitiveKind: 'cylinder' as const,
          dimensions: {
            width: null,
            height: 60,
            depth: null,
            radius: 15,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        },
        {
          kind: 'add_edge_modifier' as const,
          name: 'Chamfered Shaft',
          localId: 'chamfered_shaft',
          modifier: 'chamfer' as const,
          targetBodyId: '$shaft',
          edgeHashes: [],
          edgeSelector: 'circular-rims' as const,
          size: 1
        }
      ]
    };
    const reference = (
      hash: number,
      lineageName: string
    ): EdgeTopologyReferenceV5 => ({
      kind: 'edge',
      producingFeatureId: toFeatureId('feature_shaft'),
      lineageName,
      currentHash: hash,
      witnessVersion: 1,
      witness: {
        curveType: 'CIRCLE',
        length: 2 * Math.PI * 15,
        closed: true,
        center: [0, 0, 0],
        axis: [0, 0, 1]
      }
    });
    const derive = vi.fn(async (candidate: ProjectDocument) => {
      const sourceBodyId = candidate.bodyOrder[0]!;
      const resultBodyId = candidate.bodyOrder[1];
      const source = exactDerived(candidate).bodyRepresentations[sourceBodyId]!;
      const sourceWithTopology = {
        ...source,
        consumed: Boolean(resultBodyId),
        topology: {
          faces: [],
          edges: [
            {
              topologyId: 'edge_bottom',
              hash: 11,
              reference: reference(11, 'primitive.cylinder.edge.bottom'),
              displayRole: 'feature' as const,
              curve: {
                type: 'CIRCLE',
                circle: {
                  center: { x: 0, y: 0, z: 0 },
                  axis: { x: 0, y: 0, z: 1 },
                  radius: 15
                }
              },
              vertexIds: [1, 1] as [number, number],
              points: []
            },
            {
              topologyId: 'edge_top',
              hash: 12,
              reference: reference(12, 'primitive.cylinder.edge.top'),
              displayRole: 'feature' as const,
              curve: {
                type: 'CIRCLE',
                circle: {
                  center: { x: 0, y: 0, z: 60 },
                  axis: { x: 0, y: 0, z: 1 },
                  radius: 15
                }
              },
              vertexIds: [2, 2] as [number, number],
              points: []
            },
            {
              topologyId: 'edge_seam',
              hash: 13,
              displayRole: 'seam' as const,
              curve: { type: 'LINE' },
              vertexIds: [1, 2] as [number, number],
              points: []
            },
            {
              topologyId: 'edge_unbounded_circle',
              hash: 14,
              reference: reference(14, 'primitive.cylinder.edge.unbounded'),
              displayRole: 'feature' as const,
              curve: {
                type: 'CIRCLE',
                circle: {
                  center: { x: 0, y: 0, z: 30 },
                  axis: { x: 0, y: 0, z: 1 },
                  radius: 15
                }
              },
              points: []
            }
          ]
        }
      };
      return {
        ...exactDerived(candidate),
        bodyRepresentations: {
          [sourceBodyId]: sourceWithTopology,
          ...(resultBodyId
            ? {
                [resultBodyId]: {
                  ...sourceWithTopology,
                  bodyId: resultBodyId,
                  name: 'Chamfered Shaft',
                  consumed: false
                }
              }
            : {})
        },
        exportableBodyIds: [resultBodyId ?? sourceBodyId]
      };
    });

    const result = await preflightCadPatch(base, stagedProposal, derive);

    expect(derive).toHaveBeenCalledTimes(2);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[1]?.kind).toBe('feature.chamfer');
    expect(result.commands[1]?.payload).toMatchObject({
      edgeHashes: [11, 12],
      edgeReferences: [
        { currentHash: 11, lineageName: 'primitive.cylinder.edge.bottom' },
        { currentHash: 12, lineageName: 'primitive.cylinder.edge.top' }
      ]
    });
    expect(result.candidate.derived.warnings).toEqual([]);
  });

  it('refuses a staged selector when the prefix already consumed its body', async () => {
    const base = createProjectDocument('AI', toUserId('user_ai'));
    const stagedProposal = {
      ...proposal,
      operations: [
        proposal.operations[0]!,
        {
          kind: 'add_edge_modifier' as const,
          name: 'Edges',
          localId: 'edges',
          modifier: 'fillet' as const,
          targetBodyId: '$box',
          edgeHashes: [],
          edgeSelector: 'all-feature-edges' as const,
          size: 1
        }
      ]
    };

    await expect(
      preflightCadPatch(base, stagedProposal, async (candidate) => {
        const derived = exactDerived(candidate);
        derived.bodyRepresentations[candidate.bodyOrder[0]!]!.consumed = true;
        return derived;
      })
    ).rejects.toThrow(/consumed by the staged prefix/);
  });
});
