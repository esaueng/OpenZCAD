import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { checkSketchEdit } from '../apps/web/src/lib/sketch/editing';
import { FeatureBuildError } from '../apps/web/src/lib/featureValidation';
import {
  failedHistoryExportBodies,
  withheldExportMessage
} from '../apps/web/src/lib/failedHistoryExport';
import {
  HOLLOW_DUCT_VOLUME,
  NARROWED_LOFT_VOLUME,
  loftedHollowDuct,
  upperDuctSection,
  upperDuctSectionEdit,
  type LoftedHollowDuct
} from './fixtures/lofted-hollow-duct';

/**
 * Production QA CAD-002 (2026-10-11). Editing the upper section of a shelled
 * loft from History (Width 40 → 30) committed without checking the shell,
 * which could no longer find its top opening: the body fell back to the
 * solid loft, survived reload, and was written to STEP as the design.
 *
 * The edit must now be refused before it reaches history (the same exact
 * branch check every other History edit runs), and a document already in the
 * failed state must not export the stand-in body.
 */
describe(
  'upstream sketch edits under a dependent shell',
  { timeout: 60_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let duct: LoftedHollowDuct;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      duct = await loftedHollowDuct(adapter, { separateBlock: true });
    });

    afterAll(() => adapter.dispose());

    const rebuild = async (document: ProjectDocument) => ({
      ...document,
      derived: await adapter.syncDocument(document)
    });

    it('builds the hollow duct the QA report measured', () => {
      const { document, shellBodyId, loftBodyId } = duct;
      const shell = document.derived.bodyRepresentations[shellBodyId]!;
      expect(document.derived.warnings).toEqual([]);
      expect(shell.volume).toBeCloseTo(HOLLOW_DUCT_VOLUME, 1);
      expect(shell.faceCount).toBe(10);
      expect(document.derived.bodyRepresentations[loftBodyId]?.consumed).toBe(
        true
      );
      expect(failedHistoryExportBodies(document).size).toBe(0);
    });

    it('refuses the section edit that strands the shell, naming the shell', async () => {
      const { document } = duct;
      const refusal = await checkSketchEdit(
        document,
        upperDuctSection(document).sketchId,
        upperDuctSectionEdit(document, 30),
        (candidate) => adapter.syncDocument(candidate)
      ).then(
        () => null,
        (error: unknown) => error
      );
      expect(refusal).toBeInstanceOf(FeatureBuildError);
      expect((refusal as FeatureBuildError).featureName).toBe(
        'Open-ended duct wall'
      );
      expect((refusal as Error).message).toMatch(/no longer exists/);
    });

    it('accepts a re-applied section whose cap is unchanged', async () => {
      // The gate judges the rebuilt branch, not the fact of an edit. (The
      // loft has no verified cap lineage, so the shell holds hash-only
      // openings and any change to a cap's shape does strand it today.)
      const { document, shellBodyId } = duct;
      const derived = await checkSketchEdit(
        document,
        upperDuctSection(document).sketchId,
        upperDuctSectionEdit(document, 40),
        (candidate) => adapter.syncDocument(candidate)
      );
      expect(derived?.bodyRepresentations[shellBodyId]?.volume).toBeCloseTo(
        HOLLOW_DUCT_VOLUME,
        1
      );
    });

    it('keeps a failed shell’s stand-in body out of export, through undo, redo and reload', async () => {
      // A document already in the failed state (saved before this fix, or
      // reached any other way) is what the export guard is for.
      const { document, loftBodyId, shellBodyId, blockBodyId } = duct;
      const manager = new CommandManager(document);
      manager.runTransaction(
        'Edit Upper duct section',
        upperDuctSectionEdit(document, 30)
      );

      const failed = await rebuild(manager.document);
      expect(failed.derived.featureWarnings).toEqual([
        expect.objectContaining({
          featureName: 'Open-ended duct wall',
          kind: 'build-failed'
        })
      ]);
      expect(failed.derived.bodyRepresentations[shellBodyId]).toBeUndefined();
      // The hazard itself: the solid loft is unconsumed and exportable.
      expect(
        failed.derived.bodyRepresentations[loftBodyId]?.volume
      ).toBeCloseTo(NARROWED_LOFT_VOLUME, 1);
      expect(failed.derived.exportableBodyIds).toContain(loftBodyId);

      const withheld = failedHistoryExportBodies(failed);
      expect([...withheld.keys()]).toEqual([loftBodyId]);
      expect(withheld.has(blockBodyId!)).toBe(false);
      expect(
        withheldExportMessage([...withheld.values()], () => 'Duct loft 1')
      ).toBe(
        'Duct loft 1 not exported: “Open-ended duct wall” failed to rebuild, so it does not match the design. Fix or suppress the failed feature in History to export it.'
      );

      // Reload: a JSON round trip and a fresh rebuild reach the same verdict.
      const reloaded = await rebuild(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      expect([...failedHistoryExportBodies(reloaded).keys()]).toEqual([
        loftBodyId
      ]);

      manager.undo();
      const undone = await rebuild(manager.document);
      expect(
        undone.derived.bodyRepresentations[shellBodyId]?.volume
      ).toBeCloseTo(HOLLOW_DUCT_VOLUME, 1);
      expect(failedHistoryExportBodies(undone).size).toBe(0);

      manager.redo();
      const redone = await rebuild(manager.document);
      expect([...failedHistoryExportBodies(redone).keys()]).toEqual([
        loftBodyId
      ]);
    });

    it('exports the hollow duct, not the solid loft, to STEP', async () => {
      const { document, shellBodyId } = duct;
      const step = await adapter.exportStep(document, [shellBodyId]);
      const roundTrip = importStepBody(
        createProjectDocument('Duct STEP', toUserId('user_duct_step')),
        {
          name: 'Duct',
          artifactId: 'artifact_duct',
          sourceName: 'duct.step',
          stepText: step
        }
      ).document;
      const imported = await adapter.syncDocument(roundTrip);
      const body = imported.bodyRepresentations[roundTrip.bodyOrder[0]!]!;
      expect(imported.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(HOLLOW_DUCT_VOLUME, 1);
      expect(body.faceCount).toBe(10);
    });
  }
);
