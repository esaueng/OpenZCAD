import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  growingHolderProposalTarget,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  growingHolderHistories
} from '@openzcad/command-system';
import {
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { assistantSuggestions } from '../apps/web/src/lib/assistant/suggestions';
import { describeOperation } from '../apps/web/src/lib/assistant/describe';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderSolid } from './support/synthetic-holder';

const selectionOf = (bodyIds: string[] = []) => ({
  featureIds: [],
  bodyIds,
  topologies: []
});

describe('growing-holder assistant proposal', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;
  let imported: ProjectDocument;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    await loadRemusTranslators();
    const kernel = new RemusKernel();
    try {
      const stepText = new TextDecoder().decode(
        remusTranslators().exportStep(
          kernel.serializeSolids(Uint32Array.of(syntheticHolderSolid(kernel)))
        )
      );
      const manager = new CommandManager(
        createProjectDocument('Bracket', toUserId('user_bracket'))
      );
      manager.execute(
        commandFactories.importStep({
          name: 'Bracket',
          artifactId: 'bracket',
          sourceName: 'bracket.step',
          stepText
        })
      );
      const derived = await adapter.syncDocument(manager.document);
      imported = { ...manager.document, derived };
    } finally {
      kernel.free();
    }
  });
  afterAll(() => {
    adapter.dispose();
  });

  it('publishes the measured opening with the imported body and in the digest', () => {
    const bodyId = imported.bodyOrder[0]!;
    const recognition =
      imported.derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening;
    expect(recognition).toMatchObject({
      status: 'recognized',
      opening: { axis: 'x', cuts: [8.9, 51.5], center: 30, sourceOpening: 44 }
    });
    const digest = createCadDocumentDigest(imported, selectionOf());
    expect(
      digest.bodies?.find((body) => body.bodyId === bodyId)?.topology
        ?.recognizedOpening
    ).toEqual(recognition);
  });

  it('offers a verified suggestion that binds to the digest and exact-preflights to one holder', async () => {
    const bodyId = imported.bodyOrder[0]!;
    expect(growingHolderProposalTarget(imported, selectionOf())).toMatchObject({
      bodyId,
      name: 'Bracket'
    });
    // A second body without a recognized opening needs a selection to choose.
    const proposal = createGrowingHolderProposal(imported, selectionOf());
    expect(proposal).not.toBeNull();
    expect(proposal!.operations).toHaveLength(1);
    expect(proposal!.summary).toContain('44 mm opening of Bracket');
    const suggestions = assistantSuggestions({
      bodyCount: 1,
      topologyKind: null,
      selectedBodyCount: 0,
      growingHolderProposal: proposal
    });
    expect(
      suggestions.find((suggestion) => suggestion.id === 'verified-growing-holder')
    ).toMatchObject({ label: 'Parameterize the opening', proposal });
    expect(describeOperation(proposal!.operations[0]!)).toContain(
      'grow the measured 44 opening'
    );

    const digest = createCadDocumentDigest(imported, selectionOf());
    const parsed = validateCadPatchProposalAgainstDigest(
      parseCadPatchProposal(structuredClone(proposal), digest),
      digest
    );
    const preflight = await preflightCadPatch(imported, parsed, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preflight.candidate.derived.warnings).toEqual([]);
    expect(preflight.candidate.derived.exportableBodyIds).toHaveLength(1);
    const histories = growingHolderHistories(preflight.candidate);
    expect(histories).toHaveLength(1);
    expect(histories[0]!.recipe.parameter).toBe('opening_width');
    const holder = preflight.candidate.derived.bodyRepresentations[
      preflight.candidate.derived.exportableBodyIds[0]!
    ]!;
    expect(holder.bbox.min.x).toBeCloseTo(-0.5, 6);
    expect(holder.bbox.max.x).toBeCloseTo(60.5, 6);

    // The applied recipe is ordinary history: the opening grows by parameter.
    const grown = setParameter(preflight.candidate, {
      name: 'opening_width',
      expression: '60'
    });
    const derived = await adapter.syncDocument(grown);
    expect(derived.warnings).toEqual([]);
    const grownHolder = derived.bodyRepresentations[derived.exportableBodyIds[0]!]!;
    expect(grownHolder.bbox.min.x).toBeCloseTo(-8.5, 6);
    expect(grownHolder.bbox.max.x).toBeCloseTo(68.5, 6);
  });

  it('refuses an opening the digest did not measure', () => {
    const digest = createCadDocumentDigest(imported, selectionOf());
    const proposal = createGrowingHolderProposal(imported, selectionOf())!;
    const operation = proposal.operations[0]!;
    if (operation.kind !== 'add_growing_holder_recipe') throw new Error('kind');
    const edited = {
      ...proposal,
      operations: [
        {
          ...operation,
          opening: { ...operation.opening, cuts: [9, 51.5] as [number, number] }
        }
      ]
    };
    expect(() =>
      validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(edited, digest),
        digest
      )
    ).toThrow(/does not exactly match the current measured opening/);
    const unmeasured = {
      ...proposal,
      operations: [{ ...operation, targetBodyId: 'body_missing' }]
    };
    expect(() =>
      validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(unmeasured, digest),
        digest
      )
    ).toThrow(/has not been measured/);
    expect(() =>
      commandsForCadPatch(imported, {
        ...proposal,
        operations: [{ ...operation, parameter: 'opening width' }]
      })
    ).toThrow();
  });
});
