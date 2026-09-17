import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, setParameter } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderSolid } from './support/synthetic-holder';

/**
 * H01 "equivalent units": the same STEP source, parameterized in an inch
 * document, must measure, grow and export the same metal as it does in a
 * millimetre document. The STEP file itself is in millimetres; the importer
 * scales it into document units, so every measured number below is the
 * millimetre figure divided by 25.4, and the export scales back.
 */

const MM_PER_INCH = 25.4;
const selection = { featureIds: [], bodyIds: [], topologies: [] };

describe(
  'growing-holder recipe in an inch document',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let stepText: string;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        stepText = new TextDecoder().decode(
          remusTranslators().exportStep(
            kernel.serializeSolids(Uint32Array.of(syntheticHolderSolid(kernel)))
          )
        );
      } finally {
        kernel.free();
      }
    }, 300_000);
    afterAll(() => adapter.dispose());

    async function imported(units: UnitSystem, text = stepText) {
      const manager = new CommandManager(
        createProjectDocument('Bracket', toUserId('user_units'), units)
      );
      manager.execute(
        commandFactories.importStep({
          name: 'Bracket',
          artifactId: 'bracket',
          sourceName: 'bracket.step',
          stepText: text
        })
      );
      const derived = await adapter.syncDocument(manager.document);
      return { ...manager.document, derived } as ProjectDocument;
    }

    const holderOf = (document: ProjectDocument) =>
      document.derived.bodyRepresentations[
        document.derived.exportableBodyIds[0]!
      ]!;

    it('measures the opening in inches exactly as the millimetre document does', async () => {
      const inch = await imported('inch');
      const opening = holderOf(inch).topology?.recognizedOpening;
      expect(opening?.status).toBe('recognized');
      if (opening?.status !== 'recognized') return;
      // Every published length is the millimetre document's figure over 25.4,
      // to the recognizer's own rounding of a millionth of a unit.
      const mmOpening = holderOf(await imported('mm')).topology
        ?.recognizedOpening;
      expect(mmOpening?.status).toBe('recognized');
      if (mmOpening?.status !== 'recognized') return;
      const inches = (mm: number) => mm / MM_PER_INCH;
      expect(opening.opening.axis).toBe(mmOpening.opening.axis);
      expect(opening.opening.sourceOpening).toBeCloseTo(
        inches(mmOpening.opening.sourceOpening),
        5
      );
      expect(opening.opening.minimumOpening).toBeCloseTo(
        inches(mmOpening.opening.minimumOpening),
        5
      );
      expect(opening.opening.center).toBeCloseTo(
        inches(mmOpening.opening.center),
        5
      );
      expect(opening.opening.cuts[0]).toBeCloseTo(
        inches(mmOpening.opening.cuts[0]),
        5
      );
      expect(opening.opening.cuts[1]).toBeCloseTo(
        inches(mmOpening.opening.cuts[1]),
        5
      );
      expect(opening.opening.section).toHaveLength(
        mmOpening.opening.section.length
      );
    });

    // Known limit at Remus pin 325c5bc3, tracked under ROADMAP K07 (scale
    // bands): the recipe's bridge union is refused exactly once the holder's
    // coordinates are inch-sized. This pins that the refusal is named and no
    // approximate body ships; when the union succeeds this test fails, and the
    // grow/export acceptance below it is what should then be asserted.
    it('refuses the inch recipe by name at this pin instead of shipping an approximate bridge', async () => {
      const inch = await imported('inch');
      const proposal = createGrowingHolderProposal(inch, selection);
      expect(proposal).not.toBeNull();
      expect(proposal!.summary).toContain('1.73 inch opening of Bracket');
      const digest = createCadDocumentDigest(inch, selection);
      const parsed = validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(structuredClone(proposal!), digest),
        digest
      );
      await expect(
        preflightCadPatch(inch, parsed, (candidate) =>
          adapter.syncDocument(candidate)
        )
      ).rejects.toThrow(/bridge Body" could not be combined exactly/);
    });

    it.skip('grows by an inch expression and exports the same metal as the millimetre document (blocked by the refusal above)', async () => {
      const inch = await imported('inch');
      const proposal = createGrowingHolderProposal(inch, selection);
      const digest = createCadDocumentDigest(inch, selection);
      const parsed = validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(structuredClone(proposal!), digest),
        digest
      );
      const preflight = await preflightCadPatch(inch, parsed, (candidate) =>
        adapter.syncDocument(candidate)
      );
      expect(preflight.candidate.derived.warnings).toEqual([]);
      expect(preflight.candidate.derived.exportableBodyIds).toHaveLength(1);
      const applied = holderOf(preflight.candidate);
      expect(applied.bbox.min.x).toBeCloseTo(-0.5 / MM_PER_INCH, 6);
      expect(applied.bbox.max.x).toBeCloseTo(60.5 / MM_PER_INCH, 6);

      // Two inches is 50.8 mm: the opening grows 6.8 mm, 3.4 mm per side.
      const grown = setParameter(preflight.candidate, {
        name: 'opening_width',
        expression: '2'
      });
      const derived = await adapter.syncDocument(grown);
      expect(derived.warnings).toEqual([]);
      const inchHolder =
        derived.bodyRepresentations[derived.exportableBodyIds[0]!]!;
      expect(inchHolder.bbox.min.x).toBeCloseTo(-3.9 / MM_PER_INCH, 6);
      expect(inchHolder.bbox.max.x).toBeCloseTo(63.9 / MM_PER_INCH, 6);

      // The exported STEP is in millimetres again: reimported into a millimetre
      // document it measures 50.8 across the opening and the same outer span.
      const exported = await adapter.exportStep(
        { ...grown, derived },
        derived.exportableBodyIds
      );
      const reimported = await imported('mm', exported);
      const mmHolder = holderOf(reimported);
      expect(mmHolder.bbox.min.x).toBeCloseTo(-3.9, 4);
      expect(mmHolder.bbox.max.x).toBeCloseTo(63.9, 4);
      const reopening = mmHolder.topology?.recognizedOpening;
      expect(reopening?.status).toBe('recognized');
      if (reopening?.status === 'recognized')
        expect(reopening.opening.sourceOpening).toBeCloseTo(50.8, 4);

      // And it is the same metal the millimetre document produces at 50.8.
      const mm = await imported('mm');
      const mmProposal = createGrowingHolderProposal(mm, selection)!;
      const mmDigest = createCadDocumentDigest(mm, selection);
      const mmPreflight = await preflightCadPatch(
        mm,
        validateCadPatchProposalAgainstDigest(
          parseCadPatchProposal(structuredClone(mmProposal), mmDigest),
          mmDigest
        ),
        (candidate) => adapter.syncDocument(candidate)
      );
      const mmGrown = await adapter.syncDocument(
        setParameter(mmPreflight.candidate, {
          name: 'opening_width',
          expression: '50.8'
        })
      );
      const reference =
        mmGrown.bodyRepresentations[mmGrown.exportableBodyIds[0]!]!;
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(inchHolder.bbox.min[axis] * MM_PER_INCH).toBeCloseTo(
          reference.bbox.min[axis],
          6
        );
        expect(inchHolder.bbox.max[axis] * MM_PER_INCH).toBeCloseTo(
          reference.bbox.max[axis],
          6
        );
      }
    });

    it('offers the arm height control on the hole-free holder in inches', async () => {
      const kernel = new RemusKernel();
      let openText: string;
      try {
        openText = new TextDecoder().decode(
          remusTranslators().exportStep(
            kernel.serializeSolids(
              Uint32Array.of(syntheticHolderSolid(kernel, { holes: false }))
            )
          )
        );
      } finally {
        kernel.free();
      }
      const inch = await imported('inch', openText);
      const mm = await imported('mm', openText);
      const inchOpening = holderOf(inch).topology?.recognizedOpening;
      const mmOpening = holderOf(mm).topology?.recognizedOpening;
      expect(mmOpening?.status).toBe('recognized');
      expect(inchOpening?.status).toBe('recognized');
      if (
        inchOpening?.status !== 'recognized' ||
        mmOpening?.status !== 'recognized'
      )
        return;
      expect(mmOpening.opening.height).toBeDefined();
      expect(inchOpening.opening.height).toBeDefined();
      if (!mmOpening.opening.height || !inchOpening.opening.height) return;
      expect(inchOpening.opening.height.sourceHeight).toBeCloseTo(
        mmOpening.opening.height.sourceHeight / MM_PER_INCH,
        5
      );
      expect(inchOpening.opening.height.minimumHeight).toBeCloseTo(
        mmOpening.opening.height.minimumHeight / MM_PER_INCH,
        5
      );
    });
  }
);
