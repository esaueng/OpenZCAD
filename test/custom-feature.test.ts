import { beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  compileHistoryEdit,
  historyModelOf,
  printHistory,
  publishScript,
  readHistoryText
} from '@openzcad/scripting';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type CustomFeatureScript,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * L15 slice C on the exact kernel: a custom feature runs its script in the
 * build, its picks are exact queries re-evaluated on every build, and any
 * pick that does not find exactly what it declares refuses the feature.
 */
const W = 40;
const D = 30;
const H = 20;

const ROUNDED_TRAY = `script "openzcad.test/rounded-tray" "1.0.0" api 1 {
  input round: length = \`5 mm\`
  input wall: length = \`2 mm\`
  pick corners: edges 4 = edges().type("line").axis("z")
  step fillet { edges: #corners, radius: \`round\` }
  pick top: face = faces().normal("z").max("z")
  step shell { faces: #top, thickness: \`wall\` }
}`;

function published(source: string): CustomFeatureScript {
  const result = publishScript(source);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return result.script!;
}

/** A W×D×H box with its four vertical edges rounded by r and shelled open at the top by t. */
function trayVolume(r: number, t: number): number {
  const outer = (W * D - (4 - Math.PI) * r * r) * H;
  const inner =
    ((W - 2 * t) * (D - 2 * t) - (4 - Math.PI) * (r - t) ** 2) * (H - t);
  return outer - inner;
}

describe(
  'L15 custom features on the exact kernel',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    function block(): { manager: CommandManager; bodyId: BodyId } {
      let document = createProjectDocument(
        'Tray',
        toUserId('user_custom_feature')
      );
      expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
      document = setParameter(document, {
        name: 'corner',
        expression: '6 mm',
        quantity: 'length'
      });
      document = addPrimitiveFeature(document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: W, height: D, depth: H }
      });
      return {
        manager: new CommandManager(document),
        bodyId: document.bodyOrder[0]!
      };
    }

    async function built(document: ProjectDocument) {
      const derived = await adapter.syncDocument(document);
      return { ...document, derived };
    }

    function volumeOf(document: ProjectDocument): number {
      const feature = listFeaturesInOrder(document).at(-1)!;
      return document.derived.bodyRepresentations[feature.bodyId!]!.volume;
    }

    it('runs the script in the build and matches the closed form', async () => {
      const { manager, bodyId } = block();
      manager.execute(
        commandFactories.customFeature({
          name: 'Tray',
          targetBodyId: bodyId,
          script: published(ROUNDED_TRAY),
          inputs: {}
        })
      );
      const document = await built(manager.document);
      expect(document.derived.warnings).toEqual([]);
      expect(volumeOf(document)).toBeCloseTo(trayVolume(5, 2), 4);
      // One feature in the history, one body out: the steps leave no bodies.
      expect(
        listFeaturesInOrder(document).map((feature) => feature.featureKind)
      ).toEqual(['primitive', 'custom-feature']);
      expect(Object.keys(document.derived.bodyRepresentations)).toHaveLength(2);
      // One undo removes it.
      manager.undo();
      expect(listFeaturesInOrder(manager.document)).toHaveLength(1);
    });

    it('re-evaluates its inputs and picks when a parameter changes', async () => {
      const { manager, bodyId } = block();
      manager.execute(
        commandFactories.customFeature({
          name: 'Tray',
          targetBodyId: bodyId,
          script: published(ROUNDED_TRAY),
          inputs: { round: 'corner', wall: '1.5 mm' }
        })
      );
      expect(volumeOf(await built(manager.document))).toBeCloseTo(
        trayVolume(6, 1.5),
        4
      );
      manager.execute(
        commandFactories.setParameter({ name: 'corner', expression: '8 mm' })
      );
      expect(volumeOf(await built(manager.document))).toBeCloseTo(
        trayVolume(8, 1.5),
        4
      );
    });

    it('refuses the whole feature when a pick does not find exactly what it declares', async () => {
      const { manager, bodyId } = block();
      const source = ROUNDED_TRAY.replace('edges 4 =', 'edges 3 =');
      manager.execute(
        commandFactories.customFeature({
          name: 'Tray',
          targetBodyId: bodyId,
          script: published(source),
          inputs: {}
        })
      );
      const document = await built(manager.document);
      const instance = listFeaturesInOrder(document).at(-1)!;
      expect(document.derived.featureWarnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            featureId: instance.featureId,
            message: expect.stringMatching(
              /Pick #corners found 4 edges; it needs exactly 3\./
            ) as unknown
          })
        ])
      );
      // Nothing half-built is published: the block passes through unchanged.
      expect(volumeOf(document)).toBeCloseTo(W * D * H, 6);
    });

    it('refuses a script whose source no longer matches its pinned digest', async () => {
      const { manager, bodyId } = block();
      const script = published(ROUNDED_TRAY);
      const tampered = {
        ...script,
        source: script.source.replace('`5 mm`', '`1 mm`')
      };
      expect(() =>
        manager.execute(
          commandFactories.customFeature({
            name: 'Tray',
            targetBodyId: bodyId,
            script: tampered,
            inputs: {}
          })
        )
      ).toThrow(/does not match its pinned digest/);
      // A stored document edited behind the app's back refuses in the build.
      manager.execute(
        commandFactories.customFeature({
          name: 'Tray',
          targetBodyId: bodyId,
          script,
          inputs: {}
        })
      );
      const document = structuredClone(manager.document);
      const instance = listFeaturesInOrder(document).at(-1)!;
      if (instance.data.featureKind !== 'custom-feature')
        throw new Error('fixture');
      instance.data.script.source = tampered.source;
      const rebuilt = await built(document);
      expect(rebuilt.derived.warnings.join('\n')).toMatch(
        /does not match its pinned digest/
      );
    });

    it('refuses unknown inputs, missing values and a republished version with other source', () => {
      const { manager, bodyId } = block();
      const script = published(ROUNDED_TRAY);
      expect(() =>
        manager.execute(
          commandFactories.customFeature({
            name: 'Tray',
            targetBodyId: bodyId,
            script,
            inputs: { radius: 3 }
          })
        )
      ).toThrow(/has no input `radius`/);
      manager.execute(
        commandFactories.customFeature({
          name: 'Tray',
          targetBodyId: bodyId,
          script,
          inputs: {}
        })
      );
      const other = published(ROUNDED_TRAY.replace('`2 mm`', '`3 mm`'));
      const second = listFeaturesInOrder(manager.document).at(-1)!.bodyId!;
      expect(() =>
        manager.execute(
          commandFactories.customFeature({
            name: 'Tray again',
            targetBodyId: second,
            script: other,
            inputs: {}
          })
        )
      ).toThrow(/already published in this project with other source/);
    });

    describe('through the history text', () => {
      async function applyText(document: ProjectDocument, text: string) {
        const compiled = compileHistoryEdit(document, text);
        expect(
          compiled.diagnostics.filter((d) => d.severity === 'error')
        ).toEqual([]);
        const checked = await preflightCadPatch(
          document,
          compiled.proposal!,
          (candidate) => adapter.syncDocument(candidate)
        );
        const manager = new CommandManager(document);
        manager.runTransaction('Edit history text', checked.commands);
        manager.commitDerivedState(checked.candidate.derived);
        return { compiled, after: manager.document };
      }

      function trayStatement(
        bodyId: string,
        source = ROUNDED_TRAY,
        inputs = '{ wall: `1.5 mm` }'
      ) {
        return `custom-feature #feat_new_tray "Tray" {\n  targetBodyId: #${bodyId},\n  script: { id: "openzcad.test/rounded-tray", version: "1.0.0", source: """${source}""" },\n  inputs: ${inputs},\n}\n`;
      }

      it('creates an instance from text, prints it back and reads it back', async () => {
        const { manager, bodyId } = block();
        const document = await built(manager.document);
        const { compiled, after } = await applyText(
          document,
          `${printHistory(document)}\n${trayStatement(bodyId)}`
        );
        expect(compiled.summary).toEqual([
          'Add Tray (openzcad.test/rounded-tray 1.0.0)'
        ]);
        expect(volumeOf(after)).toBeCloseTo(trayVolume(5, 1.5), 4);
        const text = printHistory(after);
        expect(text).toMatch(/custom-feature #feat_\S+ "Tray" -> #body_\S+ \{/);
        expect(text).toContain(
          'source: """script "openzcad.test/rounded-tray" "1.0.0" api 1 {'
        );
        expect(text).toContain('inputs: { wall: `1.5 mm` }');
        const read = readHistoryText(text, after);
        expect(read.diagnostics.filter((d) => d.severity === 'error')).toEqual(
          []
        );
        expect(read.model).toEqual(historyModelOf(after));
        expect(compileHistoryEdit(after, text).proposal).toBeNull();
      });

      it('edits inputs, refuses changing a published version and accepts a new one', async () => {
        const { manager, bodyId } = block();
        const document = await built(manager.document);
        const { after } = await applyText(
          document,
          `${printHistory(document)}\n${trayStatement(bodyId)}`
        );
        const text = printHistory(after);

        const wider = await applyText(
          after,
          text.replace('wall: `1.5 mm`', 'wall: `2.5 mm`')
        );
        expect(volumeOf(wider.after)).toBeCloseTo(trayVolume(5, 2.5), 4);
        // An input the instance did not set before can be set from the text.
        const rounder = await applyText(
          after,
          text.replace(
            'inputs: { wall: `1.5 mm` }',
            'inputs: { wall: `1.5 mm`, round: `corner` }'
          )
        );
        expect(volumeOf(rounder.after)).toBeCloseTo(trayVolume(6, 1.5), 4);
        expect(
          compileHistoryEdit(
            after,
            text.replace('wall: `1.5 mm`', 'wall: true')
          ).diagnostics.map((d) => d.message)
        ).toEqual([
          'Input `wall` takes a number or an expression in backticks.'
        ]);

        const changed = text.replace(
          'input round: length = `5 mm`',
          'input round: length = `7 mm`'
        );
        expect(
          compileHistoryEdit(after, changed).diagnostics.map((d) => d.message)
        ).toEqual([
          expect.stringMatching(
            /openzcad.test\/rounded-tray 1.0.0 is published and cannot change; give the edited script a new version\./
          )
        ]);

        const bumped = changed
          .replace('"1.0.0" api 1', '"1.1.0" api 1')
          .replace('version: "1.0.0"', 'version: "1.1.0"')
          .replace(/,\s*digest: "[0-9a-f]+"/, '');
        const next = await applyText(after, bumped);
        expect(volumeOf(next.after)).toBeCloseTo(trayVolume(7, 1.5), 4);
        const instance = listFeaturesInOrder(next.after).at(-1)!;
        if (instance.data.featureKind !== 'custom-feature')
          throw new Error('fixture');
        expect(instance.data.script.version).toBe('1.1.0');
        expect(instance.data.script.digest).toMatch(/^[0-9a-f]{64}$/);
        // One undo returns to 1.0.0.
        const undone = new CommandManager(next.after).undo();
        const before = listFeaturesInOrder(undone).at(-1)!;
        if (before.data.featureKind !== 'custom-feature')
          throw new Error('fixture');
        expect(before.data.script.version).toBe('1.0.0');
      });

      it('points a script error at its line inside the script', async () => {
        const { manager, bodyId } = block();
        const document = await built(manager.document);
        const broken = ROUNDED_TRAY.replace('step shell', 'step hollow');
        const result = compileHistoryEdit(
          document,
          `${printHistory(document)}\n${trayStatement(bodyId, broken)}`
        );
        expect(result.proposal).toBeNull();
        expect(result.diagnostics.map((d) => d.message)).toEqual([
          expect.stringMatching(
            /^Script line 7, column 8: `hollow` is not a script step; api 1 runs fillet, chamfer and shell\.$/
          )
        ]);
      });
    });
  }
);
