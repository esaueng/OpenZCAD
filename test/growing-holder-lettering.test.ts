import { expect, it } from 'vitest';
import {
  createProjectDocument,
  importStepBody,
  listParameters,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import {
  growingHolderHistories,
  CommandManager,
  commandsForCadPatch
} from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { letteredHolder } from './support/lettered-holder';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import { growingHolderPreview } from '../apps/web/src/lib/growingHolderPreview';
import { assistantSuggestions } from '../apps/web/src/lib/assistant/suggestions';

it('takes a fresh STEP through an AI proposal, rigid preview, undo, reopen and toggle exports', async () => {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const adapter = await createExactKernelAdapter();
  try {
    const step = io.exportStep(
      kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
    );
    let imported = importStepBody(
      createProjectDocument('Lettered bracket', toUserId('test')),
      {
        name: 'Bracket',
        artifactId: 'bracket',
        sourceName: 'bracket.step',
        stepText: new TextDecoder().decode(step)
      }
    ).document;
    imported = { ...imported, derived: await adapter.syncDocument(imported) };
    const selection = { bodyIds: [], featureIds: [], topologies: [] };
    const proposal = createGrowingHolderProposal(imported, selection)!;
    expect(proposal.summary).toContain('show_text');
    expect(
      assistantSuggestions({
        bodyCount: 1,
        topologyKind: null,
        selectedBodyCount: 0,
        growingHolderProposal: proposal
      }).find((suggestion) => suggestion.id === 'verified-growing-holder')
        ?.label
    ).toBe('Parameterize holder and text');
    const digest = createCadDocumentDigest(imported, selection);
    const parsed = validateCadPatchProposalAgainstDigest(
      parseCadPatchProposal(proposal, digest),
      digest
    );
    const { candidate } = await preflightCadPatch(imported, parsed, (d) =>
      adapter.syncDocument(d)
    );
    expect(candidate.derived.warnings).toEqual([]);
    const textId = listParameters(candidate).find(
      (p) => p.name === 'show_text'
    )!.toggle!.bodyIds[0]!;
    const history = growingHolderHistories(candidate)[0]!;
    expect(history.text?.bodyId).toBe(textId);
    const first = candidate.derived.bodyRepresentations[textId]!;
    const grown = setParameter(
      setParameter(candidate, { name: 'opening_width', expression: '60' }),
      { name: 'holder_height', expression: '46' }
    );
    const previews = growingHolderPreview(candidate, grown)!;
    expect(previews).toHaveLength(2);
    const textPreview = previews.find((b) => b.bodyId === textId)!;
    expect(textPreview.exportableStep).toBe(false);
    expect(textPreview.faceCount).toBe(0);
    expect(textPreview.bbox.min.x - first.bbox.min.x).toBeCloseTo(-8, 6);
    expect(textPreview.bbox.min.y - first.bbox.min.y).toBeCloseTo(7, 6);
    const exact = await adapter.syncDocument(grown);
    expect(exact.warnings).toEqual([]);
    expect(exact.bodyRepresentations[textId]!.bbox).toEqual(textPreview.bbox);
    const visible = await adapter.exportStep(grown, exact.exportableBodyIds);
    expect(
      kernel.deserializeSolids(io.importStep(new TextEncoder().encode(visible)))
    ).toHaveLength(3);
    const off = setParameter(grown, { name: 'show_text', expression: '0' });
    const plain = await adapter.exportStep(off, exact.exportableBodyIds);
    const solids = kernel.deserializeSolids(
      io.importStep(new TextEncoder().encode(plain))
    );
    expect(solids).toHaveLength(1);
    expect(kernel.validateSolid(solids[0]!)).toBe(0);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(off)) as typeof off
    );
    expect(
      (await adapter.syncDocument(reopened)).exportableBodyIds
    ).toHaveLength(1);
    const manager = new CommandManager(imported);
    for (const command of commandsForCadPatch(imported, proposal))
      manager.execute(command);
    manager.undo();
    expect(listParameters(manager.document)).toHaveLength(0);
    manager.redo();
    expect(
      listParameters(manager.document).find((p) => p.name === 'show_text')
        ?.toggle?.bodyIds
    ).toHaveLength(1);
    const operation = proposal.operations[0]!;
    if (operation.kind !== 'add_growing_holder_recipe')
      throw new Error('unexpected operation');
    const tampered = {
      ...proposal,
      operations: [
        {
          ...operation,
          opening: {
            ...operation.opening,
            lettering: {
              ...operation.opening.lettering!,
              side: 'positive' as const
            }
          }
        }
      ]
    };
    expect(() =>
      validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(tampered, digest),
        digest
      )
    ).toThrow(/does not exactly match/);
  } finally {
    adapter.dispose();
    kernel.free();
  }
}, 120_000);
