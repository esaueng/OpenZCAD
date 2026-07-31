import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
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
});
