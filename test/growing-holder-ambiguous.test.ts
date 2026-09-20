import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  growingHolderProposalTarget,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { assistantSuggestions } from '../apps/web/src/lib/assistant/suggestions';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderSolid } from './support/synthetic-holder';

/**
 * H01 "ambiguous drawings": when a part's geometry does not single out the
 * opening a drawing could be asking about — an E-shaped bracket has two equal
 * ones — nothing may guess. The digest publishes the ambiguity with its
 * reason and the candidate pairs, no verified suggestion is offered, and a
 * proposal that names the body anyway is refused before it reaches exact
 * preflight. A guided face selection is the only way through, and that path
 * is proved on the recognizer itself in `opening-recognition.test.ts`.
 */

const selection = { featureIds: [], bodyIds: [], topologies: [] };

/** Two 18 mm openings side by side: the drilled holder's profile with a middle arm. */
function eShapedBracket(kernel: RemusKernel): number {
  const profile = kernel.makePolygon(
    new Float64Array([
      0, 0, 0, 60, 0, 0, 60, 32, 0, 52, 32, 0, 52, 8, 0, 34, 8, 0, 34, 32, 0,
      26, 32, 0, 26, 8, 0, 8, 8, 0, 8, 32, 0, 0, 32, 0
    ])
  );
  return kernel.extrude(profile, 0, 0, 1, 20);
}

describe(
  'growing-holder recipe on ambiguous geometry',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let ambiguous: ProjectDocument;
    let holder: ProjectDocument;

    async function importBracket(name: string, stepText: string) {
      const manager = new CommandManager(
        createProjectDocument(name, toUserId('user_ambiguous'))
      );
      manager.execute(
        commandFactories.importStep({
          name,
          artifactId: name.toLowerCase(),
          sourceName: `${name.toLowerCase()}.step`,
          stepText
        })
      );
      const derived = await adapter.syncDocument(manager.document);
      return { ...manager.document, derived } as ProjectDocument;
    }

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        const step = (solid: number) =>
          new TextDecoder().decode(
            remusTranslators().exportStep(
              kernel.serializeSolids(Uint32Array.of(solid))
            )
          );
        ambiguous = await importBracket('Eshape', step(eShapedBracket(kernel)));
        holder = await importBracket(
          'Holder',
          step(syntheticHolderSolid(kernel))
        );
      } finally {
        kernel.free();
      }
    }, 300_000);
    afterAll(() => adapter.dispose());

    it('publishes the ambiguity with its candidates instead of choosing an opening', () => {
      const bodyId = ambiguous.bodyOrder[0]!;
      const recognition =
        ambiguous.derived.bodyRepresentations[bodyId]!.topology
          ?.recognizedOpening;
      expect(recognition?.status).toBe('ambiguous');
      if (recognition?.status !== 'ambiguous') return;
      expect(recognition.reason).toMatch(
        /select the intended pair of inner faces/
      );
      expect(recognition.candidates.length).toBeGreaterThanOrEqual(2);
      expect(recognition.candidates.slice(0, 2).map((c) => c.opening)).toEqual([
        18, 18
      ]);
      // The digest the assistant reads carries the same verdict, verbatim.
      const digest = createCadDocumentDigest(ambiguous, selection);
      expect(
        digest.bodies?.find((body) => body.bodyId === bodyId)?.topology
          ?.recognizedOpening
      ).toEqual(recognition);
    });

    it('offers no verified suggestion and refuses a proposal that names the body anyway', () => {
      expect(growingHolderProposalTarget(ambiguous, selection)).toBeNull();
      expect(createGrowingHolderProposal(ambiguous, selection)).toBeNull();
      const suggestions = assistantSuggestions({
        bodyCount: 1,
        topologyKind: null,
        selectedBodyCount: 0,
        growingHolderProposal: createGrowingHolderProposal(ambiguous, selection)
      });
      expect(
        suggestions.find((s) => s.id === 'verified-growing-holder')
      ).toBeUndefined();

      // A proposal shaped like a verified one, retargeted at the ambiguous body:
      // the digest has measured nothing there, so it is refused by name.
      const template = createGrowingHolderProposal(holder, selection)!;
      const operation = template.operations[0]!;
      if (operation.kind !== 'add_growing_holder_recipe')
        throw new Error('kind');
      const forged = {
        ...template,
        operations: [{ ...operation, targetBodyId: ambiguous.bodyOrder[0]! }]
      };
      const digest = createCadDocumentDigest(ambiguous, selection);
      expect(() =>
        validateCadPatchProposalAgainstDigest(
          parseCadPatchProposal(forged, digest),
          digest
        )
      ).toThrow(
        /not a recognized measurement \(More than one opening has a comparable facing area/
      );
    });
  }
);
