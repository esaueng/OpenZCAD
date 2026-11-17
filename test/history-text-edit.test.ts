import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import { CommandManager } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { compileHistoryEdit, printHistory } from '@openzcad/scripting';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

/**
 * L15 slice B, end to end on the exact kernel: an edited history text
 * compiles into a patch proposal that passes the assistant's own parser,
 * digest check and exact preflight, commits as one undo step, and the
 * document it produces prints back as exactly the text that was applied.
 */
describe(
  'L15 history text edits through exact preflight',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    async function built(): Promise<ProjectDocument> {
      let document = createProjectDocument(
        'Text edit',
        toUserId('user_text_edit')
      );
      document = setParameter(document, {
        name: 'width',
        expression: '40 mm',
        quantity: 'length'
      });
      document = addPrimitiveFeature(document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 20, depth: 10 }
      });
      const sketch = addSketchFeature(document, {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 30 },
        objects: [{ objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }]
      });
      document = extrudeSketch(sketch.document, {
        name: 'Pin',
        sketchId: sketch.sketchId,
        distance: 'width / 4'
      }).document;
      return { ...document, derived: await adapter.syncDocument(document) };
    }

    function volumes(document: ProjectDocument): number[] {
      return document.bodyOrder.map(
        (bodyId) =>
          document.derived.bodyRepresentations[bodyId]?.volume ?? Number.NaN
      );
    }

    async function apply(document: ProjectDocument, text: string) {
      const compiled = compileHistoryEdit(document, text);
      expect(
        compiled.diagnostics.filter(
          (diagnostic) => diagnostic.severity === 'error'
        )
      ).toEqual([]);
      // The proposal is an ordinary patch: the assistant's parser and digest
      // check accept it before exact preflight runs.
      const proposal = validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(structuredClone(compiled.proposal)),
        createCadDocumentDigest(document)
      );
      const checked = await preflightCadPatch(document, proposal, (candidate) =>
        adapter.syncDocument(candidate)
      );
      const manager = new CommandManager(document);
      manager.runTransaction('Edit history text', checked.commands);
      manager.commitDerivedState(checked.candidate.derived);
      return { compiled, after: manager.document };
    }

    it('applies parameter, data, name, sketch and order edits as one undo step', async () => {
      const document = await built();
      expect(volumes(document)[0]).toBeCloseTo(40 * 20 * 10, 6);
      const original = printHistory(document);
      const sections = original.trimEnd().split('\n\n');
      const [header, parameters, block, sketch, pin] = sections;
      const edited = `${[
        header,
        parameters!.replace('`40 mm`', '`60 mm`'),
        sketch!.replace('radius: 5', 'radius: 4'),
        block!.replace('"Block"', '"Base"').replace('height: 20', 'height: 25'),
        pin!.replace('distance: `width / 4`', 'distance: `width / 3`')
      ].join('\n\n')}\n`;

      const { compiled, after } = await apply(document, edited);
      expect(compiled.summary).toEqual(
        expect.arrayContaining([
          'Set parameter width = 60 mm',
          'Rename Block to Base',
          'Edit Base: dimensions',
          'Edit Pin: distance',
          'Move Profile to step 1'
        ])
      );
      expect(printHistory(after)).toBe(edited);
      expect(listFeaturesInOrder(after).map((feature) => feature.name)).toEqual(
        ['Profile', 'Base', 'Pin']
      );
      const [base, pinVolume] = volumes(after);
      expect(base).toBeCloseTo(60 * 25 * 10, 6);
      expect(pinVolume).toBeCloseTo(Math.PI * 4 * 4 * 20, 4);
      // One undo entry, labelled as the text edit, restores the original text.
      expect(after.editHistory!.entries.at(-1)!.label).toBe(
        'Edit history text'
      );
      const undone = new CommandManager(after).undo();
      expect(printHistory(undone)).toBe(original);
    });

    it('adds a primitive and deletes a step, and refuses an edit the kernel refuses', async () => {
      const document = await built();
      const sections = printHistory(document).trimEnd().split('\n\n');
      const edited = `${[
        ...sections.filter((section) => !section.startsWith('extrude ')),
        'primitive #feat_new "Lid" {\n  primitiveKind: "box",\n  dimensions: { width: `width`, height: 2, depth: 10 },\n}'
      ].join('\n\n')}\n`;
      const { after } = await apply(document, edited);
      const names = listFeaturesInOrder(after).map((feature) => feature.name);
      expect(names).toEqual(['Block', 'Profile', 'Lid']);
      expect(volumes(after).filter(Number.isFinite)).toEqual([
        expect.closeTo(8000, 6),
        expect.closeTo(800, 6)
      ]);

      // A zero-height block is valid text but the exact build refuses it, so
      // preflight throws and nothing would commit.
      const refused = compileHistoryEdit(
        document,
        printHistory(document).replace('height: 20', 'height: 0')
      );
      expect(refused.proposal).not.toBeNull();
      await expect(
        preflightCadPatch(document, refused.proposal!, (candidate) =>
          adapter.syncDocument(candidate)
        )
      ).rejects.toThrow();
    });
  }
);
