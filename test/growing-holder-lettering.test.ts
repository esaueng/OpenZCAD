import { expect, it } from 'vitest';
import {
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder,
  listParameters,
  moveFeature,
  normalizeDocument,
  setParameter,
  transformBody,
  updateFeature
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
import { toUserId, type BodyTopology } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { letteredHolder } from './support/lettered-holder';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import { growingHolderPreview } from '../apps/web/src/lib/growingHolderPreview';
import { assistantSuggestions } from '../apps/web/src/lib/assistant/suggestions';

function topologyWithoutArenaHandles(topology: BodyTopology | undefined) {
  const copy = structuredClone(topology);
  const recognition = copy?.recognizedOpening;
  if (recognition?.status === 'recognized') {
    // These two diagnostic handles address different kernel arenas. Keep
    // every published witness, lineage reference and recognition proof.
    for (const key of ['faceA', 'faceB'] as const) {
      expect(Number.isSafeInteger(recognition.evidence.candidate[key])).toBe(
        true
      );
      expect(recognition.evidence.candidate[key]).toBeGreaterThanOrEqual(0);
      recognition.evidence.candidate[key] = 0;
    }
  }
  return copy;
}

async function checkLetteredHolder(moved: boolean) {
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
    if (moved) {
      const bodyId = imported.bodyOrder[0]!;
      imported = transformBody(imported, {
        name: 'Move',
        targetBodyId: bodyId,
        translation: { x: 35, y: -17, z: 9 }
      }).document;
      imported = transformBody(imported, {
        name: 'Move again',
        targetBodyId: bodyId,
        translation: { x: -5, y: 2, z: 1 }
      }).document;
    }
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
    expect(history).toBeDefined();
    expect(history.text?.bodyId).toBe(textId);
    const ordered = listFeaturesInOrder(candidate);
    const textImport = ordered.find(
      (feature) =>
        feature.bodyId === textId &&
        feature.data.featureKind === 'imported-step'
    )!;
    expect(ordered.indexOf(textImport)).toBe(
      listFeaturesInOrder(imported).length
    );
    expect(ordered.indexOf(textImport)).toBeLessThan(
      ordered.indexOf(history.sketch)
    );
    const first = candidate.derived.bodyRepresentations[textId]!;
    if (moved) {
      expect(history.source.data.featureKind).toBe('imported-step');
      if (history.source.data.featureKind !== 'imported-step')
        throw new Error('source');
      expect(history.source.data.planarEmboss?.sourcePlacement).toHaveLength(2);
    }
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
    // Reload starts with a cold adapter. Its own rebuild must checkpoint the
    // fixed text import, then the FIRST height edit must restore it while
    // replaying the exact union and the parameter-driven text placement.
    const reloaded = await createExactKernelAdapter();
    const legacy = await createExactKernelAdapter({
      historyCheckpointLimit: 0
    });
    try {
      const reopened = normalizeDocument(
        JSON.parse(JSON.stringify(candidate)) as typeof candidate
      );
      const replayed: string[] = [];
      await reloaded.syncDocument(reopened, (progress) => {
        if (progress.stage === 'feature' && progress.status === 'completed')
          replayed.push(progress.name);
      });
      expect(replayed).toContain('Text');
      replayed.length = 0;
      const firstEdit = await reloaded.syncDocument(grown, (progress) => {
        if (progress.stage === 'feature' && progress.status === 'completed')
          replayed.push(progress.name);
      });
      expect(replayed).not.toContain('Text');
      expect(replayed).toContain('Keep text together');
      expect(replayed).toContain(history.union.name);
      expect(firstEdit.warnings).toEqual([]);
      expect(firstEdit.featureWarnings).toEqual([]);
      // Same IDs and body order, with the old text-import position restored.
      const oldOrder = moveFeature(grown, {
        featureId: textImport.featureId,
        toIndex: ordered.indexOf(history.union)
      });
      expect(oldOrder.bodyOrder).toEqual(grown.bodyOrder);
      const oracle = await legacy.syncDocument(oldOrder);
      expect(firstEdit.warnings).toEqual(oracle.warnings);
      expect(firstEdit.featureWarnings).toEqual(oracle.featureWarnings);
      expect(firstEdit.exportableBodyIds).toEqual(oracle.exportableBodyIds);
      for (const bodyId of grown.bodyOrder) {
        const actual = firstEdit.bodyRepresentations[bodyId]!;
        const expected = oracle.bodyRepresentations[bodyId]!;
        expect(actual.bbox).toEqual(expected.bbox);
        expect(actual.volume).toBe(expected.volume);
        expect(actual.faceCount).toBe(expected.faceCount);
        expect(topologyWithoutArenaHandles(actual.topology)).toEqual(
          topologyWithoutArenaHandles(expected.topology)
        );
        expect(actual.mesh.indices.length).toBe(expected.mesh.indices.length);
        expect(actual.consumed).toBe(expected.consumed);
        expect(actual.exportableStep).toBe(expected.exportableStep);
      }
      if (textImport.data.featureKind !== 'imported-step')
        throw new Error('Expected the fixed text import.');
      const emboss = textImport.data.planarEmboss!;
      const changedSelection = updateFeature(grown, {
        featureId: textImport.featureId,
        data: {
          planarEmboss: {
            ...emboss,
            selection: {
              ...emboss.selection,
              depth: emboss.selection.depth + 0.1
            }
          }
        }
      });
      replayed.length = 0;
      const refused = await reloaded.syncDocument(
        changedSelection,
        (progress) => {
          if (progress.stage === 'feature' && progress.status === 'completed')
            replayed.push(progress.name);
        }
      );
      expect(replayed).toContain('Text');
      expect(
        refused.warnings.some((warning) =>
          warning.includes('raised lettering no longer matches')
        )
      ).toBe(true);
      const refusedOracle = await legacy.syncDocument(changedSelection);
      expect(refused.warnings).toEqual(refusedOracle.warnings);
      expect(refused.featureWarnings).toEqual(refusedOracle.featureWarnings);
    } finally {
      reloaded.dispose();
      legacy.dispose();
    }
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
}

it.each([false, true])(
  'takes a STEP (moved: %s) through an AI proposal, rigid preview, undo, reopen and toggle exports',
  checkLetteredHolder,
  120_000
);

it('keeps a rotated moved holder at its world placement while the height grows, with the text riding along', async () => {
  // Panda-style placement: translate the import, then rotate it about the
  // world X axis before parameterizing. Recognition re-measures in that
  // world frame, the recipe replays both placement moves on every source
  // copy, and a height edit must keep the base where it was while the text
  // rides up rigidly by half the height change.
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const adapter = await createExactKernelAdapter();
  try {
    const step = io.exportStep(
      kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
    );
    let imported = importStepBody(
      createProjectDocument('Rotated holder', toUserId('test')),
      {
        name: 'Holder',
        artifactId: 'holder',
        sourceName: 'holder.step',
        stepText: new TextDecoder().decode(step)
      }
    ).document;
    const bodyId = imported.bodyOrder[0]!;
    imported = transformBody(imported, {
      name: 'Move',
      targetBodyId: bodyId,
      translation: { x: 11, y: -4, z: 6 }
    }).document;
    imported = transformBody(imported, {
      name: 'Rotate',
      targetBodyId: bodyId,
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 90, y: 0, z: 0 }
    }).document;
    imported = { ...imported, derived: await adapter.syncDocument(imported) };
    const recognition =
      imported.derived.bodyRepresentations[bodyId]!.topology!.recognizedOpening;
    expect(recognition?.status).toBe('recognized');
    if (recognition?.status !== 'recognized')
      throw new Error('rotated holder was not recognized');
    expect(recognition.opening.height).toBeDefined();
    expect(recognition.opening.lettering).toBeDefined();
    const selection = { bodyIds: [], featureIds: [], topologies: [] };
    const proposal = createGrowingHolderProposal(imported, selection)!;
    const digest = createCadDocumentDigest(imported, selection);
    const parsed = validateCadPatchProposalAgainstDigest(
      parseCadPatchProposal(proposal, digest),
      digest
    );
    const { candidate } = await preflightCadPatch(imported, parsed, (d) =>
      adapter.syncDocument(d)
    );
    expect(candidate.derived.warnings).toEqual([]);
    const history = growingHolderHistories(candidate)[0]!;
    expect(history).toBeDefined();
    const textId = history.text?.bodyId;
    expect(textId).toBeDefined();
    const sourceBBox = imported.derived.bodyRepresentations[bodyId]!.bbox;
    const holderBBox =
      candidate.derived.bodyRepresentations[history.resultBodyId]!.bbox;
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(holderBBox.min[axis]).toBeCloseTo(sourceBBox.min[axis], 6);
      expect(holderBBox.max[axis]).toBeCloseTo(sourceBBox.max[axis], 6);
    }
    const baseText = candidate.derived.bodyRepresentations[textId!]!.bbox;
    const heightAxis = history.recipe.height!.axis;
    const otherAxes = (['x', 'y', 'z'] as const).filter(
      (axis) => axis !== heightAxis
    );
    for (const delta of [8, -4]) {
      const height = history.recipe.height!.sourceHeight + delta;
      const grown = setParameter(candidate, {
        name: history.recipe.height!.parameter,
        expression: String(height)
      });
      const exact = await adapter.syncDocument(grown);
      expect(exact.warnings).toEqual([]);
      const grownHolder = exact.bodyRepresentations[history.resultBodyId]!;
      const grownText = exact.bodyRepresentations[textId!]!;
      expect(grownHolder.bbox.min[heightAxis]).toBeCloseTo(
        holderBBox.min[heightAxis],
        6
      );
      expect(grownHolder.bbox.max[heightAxis]).toBeCloseTo(
        holderBBox.max[heightAxis] + delta,
        6
      );
      for (const axis of otherAxes) {
        expect(grownHolder.bbox.min[axis]).toBeCloseTo(holderBBox.min[axis], 6);
        expect(grownHolder.bbox.max[axis]).toBeCloseTo(holderBBox.max[axis], 6);
        expect(grownText.bbox.min[axis]).toBeCloseTo(baseText.min[axis], 6);
        expect(grownText.bbox.max[axis]).toBeCloseTo(baseText.max[axis], 6);
      }
      expect(grownText.bbox.min[heightAxis]).toBeCloseTo(
        baseText.min[heightAxis] + delta / 2,
        6
      );
      expect(grownText.bbox.max[heightAxis]).toBeCloseTo(
        baseText.max[heightAxis] + delta / 2,
        6
      );
    }
  } finally {
    adapter.dispose();
    kernel.free();
  }
}, 180_000);
