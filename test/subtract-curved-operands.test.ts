import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import {
  SUBTRACT_RECIPES as REFERENCE,
  commitSubtract,
  expectVolume,
  importSubtractRecipe,
  meshEncloses,
  reimportedStepSolids,
  subtractFixture
} from './support/subtract-curved';

/**
 * Issue #1242: Subtract of overlapping curved STEP bodies committed the
 * target unchanged, kept the overlap, and consumed the tool.
 *
 * The four recipes the issue names, as STEP bodies written by OCCT (the
 * kernel FreeCAD's Part workbench drives) with `generate.py` beside them.
 * `reference.json` holds OCCT's own volumes for each operand, the correct
 * cut, the shared material, and a witness point inside both operands that a
 * correct cut removes. None of those figures comes from Remus.
 *
 * Acceptance: the committed and reloaded result excludes the witness and
 * holds the reference cut volume, or the Subtract refuses by a typed code
 * before consuming either input. Undo restores both sources either way.
 *
 * Each recipe pins its outcome on the current Remus build, so a kernel
 * update that changes one fails here and is re-qualified rather than
 * absorbed. A pinned refusal is the acceptable outcome, never a wrong body.
 *
 * The STEP check below re-imports the export into Remus. For the check by a
 * second kernel, set `OPENZCAD_SUBTRACT_EXPORT_DIR` to a directory: each
 * recipe's reloaded export is written there as `<recipe>.step`, for
 * `check_exports.py` beside the fixtures to measure with OCCT.
 */

const EXPORT_DIR = process.env.OPENZCAD_SUBTRACT_EXPORT_DIR;

type Outcome =
  { kind: 'cut' } | { kind: 'refused'; family: string; code: string };

/** Each cut and refused operand set must survive a STEP round-trip. */
const EXPECTED: Record<string, { outcome: Outcome }> = {
  'revolve-sweep': {
    outcome: { kind: 'cut' }
  },
  'revolve-trimmed-nurbs': {
    outcome: {
      kind: 'refused',
      family: 'boolean',
      code: 'exact_only_unattainable'
    }
  },
  // Remus 2026.1.160 produced an open body that the result-acceptance
  // gate refused with cut_kept_tool_material. Remus #1974 preserves the
  // section lens during shell assembly. The 2026.1.163 cut matches the
  // OCCT volume and excludes the overlap witness after reload and STEP
  // round-trip.
  'sweep-sweep': {
    outcome: { kind: 'cut' }
  },
  'sweep-loft': {
    outcome: {
      kind: 'refused',
      family: 'boolean',
      code: 'exact_only_unattainable'
    }
    // Re-exported since Remus 2026.1.159, like sweep-sweep.
  }
};

describe('Subtract of overlapping curved STEP bodies (#1242)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  it('pins every recipe in reference.json', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(REFERENCE).sort());
  });

  for (const [name, recipe] of Object.entries(REFERENCE)) {
    it(`${name}: removes the overlap or refuses before consuming the inputs`, async () => {
      const expected = EXPECTED[name]!;
      const { manager, target, tool } = importSubtractRecipe(name);

      const imported = await adapter.syncDocument(manager.document);
      expect(imported.warnings).toEqual([]);
      expect(imported.featureWarnings).toEqual([]);
      const targetBody = imported.bodyRepresentations[target]!;
      const toolBody = imported.bodyRepresentations[tool]!;
      expectVolume(targetBody.volume, recipe.targetVolume);
      expectVolume(toolBody.volume, recipe.toolVolume);
      // The witness is shared material, by OCCT and by both meshes.
      expect(meshEncloses(targetBody, recipe.witness)).toBe(true);
      expect(meshEncloses(toolBody, recipe.witness)).toBe(true);

      const result = commitSubtract(manager, target, tool);

      const check = async (
        derived: Awaited<ReturnType<ExactKernelAdapter['syncDocument']>>
      ) => {
        const failures = (derived.featureWarnings ?? []).filter(
          (warning) => warning.featureName === 'Subtract'
        );
        if (expected.outcome.kind === 'cut') {
          expect(failures).toEqual([]);
          expect(derived.exportableBodyIds).toEqual([result]);
          const body = derived.bodyRepresentations[result]!;
          expectVolume(body.volume, recipe.cutVolume);
          expect(meshEncloses(body, recipe.witness)).toBe(false);
        } else {
          expect(failures).toHaveLength(1);
          expect(failures[0]!.kind).toBe('build-failed');
          expect(failures[0]!.kernelRefusal).toMatchObject({
            family: expected.outcome.family,
            code: expected.outcome.code
          });
          // Refused before consuming anything: the tool stays visible,
          // and the failed step passes the target through unchanged where
          // its result would stand (ADR-017), so both export as they were.
          expect([...derived.exportableBodyIds].sort()).toEqual(
            [result, tool].sort()
          );
          const passedThrough = derived.bodyRepresentations[result]!;
          expectVolume(passedThrough.volume, recipe.targetVolume);
          expect(meshEncloses(passedThrough, recipe.witness)).toBe(true);
          expectVolume(
            derived.bodyRepresentations[tool]!.volume,
            recipe.toolVolume
          );
        }
        return derived;
      };

      const committed = await check(
        await adapter.syncDocument(manager.document)
      );

      // Reload: the persisted document rebuilt by a fresh adapter.
      const reloadedDocument = JSON.parse(
        JSON.stringify(manager.document)
      ) as ProjectDocument;
      const fresh = await createExactKernelAdapter();
      try {
        const reloaded = await check(
          await fresh.syncDocument(reloadedDocument)
        );
        expect(reloaded.exportableBodyIds).toEqual(committed.exportableBodyIds);

        const step = await fresh.exportStep(
          reloadedDocument,
          reloadedDocument.bodyOrder
        );
        if (EXPORT_DIR) {
          mkdirSync(EXPORT_DIR, { recursive: true });
          writeFileSync(`${EXPORT_DIR}/${name}.step`, step);
        }
        // STEP check: the export re-imported into a fresh kernel holds the
        // reference volumes, and the witness lies in the target only when
        // the Subtract was refused.
        const solids = await reimportedStepSolids(step, recipe.witness);
        const expectedVolumes = (
          expected.outcome.kind === 'cut'
            ? [recipe.cutVolume]
            : [recipe.targetVolume, recipe.toolVolume]
        ).sort((a, b) => a - b);
        expect(solids).toHaveLength(expectedVolumes.length);
        solids
          .map((solid) => solid.volume)
          .sort((a, b) => a - b)
          .forEach((volume, index) =>
            expectVolume(volume, expectedVolumes[index]!)
          );
        expect(solids.filter((solid) => solid.enclosesPoint)).toHaveLength(
          expected.outcome.kind === 'cut' ? 0 : 2
        );
      } finally {
        fresh.dispose();
      }

      // Undo restores both sources, unconsumed.
      manager.undo();
      const undone = await adapter.syncDocument(manager.document);
      expect(undone.featureWarnings).toEqual([]);
      expect([...undone.exportableBodyIds].sort()).toEqual(
        [target, tool].sort()
      );
      expectVolume(
        undone.bodyRepresentations[target]!.volume,
        recipe.targetVolume
      );
      expectVolume(undone.bodyRepresentations[tool]!.volume, recipe.toolVolume);
    }, 120_000);
  }

  // The issue's third step: "Remus 122's direct classifier still reports the
  // wrong overlap classification on all four." The adapter's first
  // kept-overlap gate asks this classifier, so a pin that misplaces the
  // witness again leaves only the tessellated gate standing.
  for (const [name, recipe] of Object.entries(REFERENCE)) {
    it(`${name}: the kernel classifies the witness as OCCT does`, async () => {
      const io = await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        const imported = (file: string) =>
          kernel.deserializeSolids(
            io.importStep(new TextEncoder().encode(subtractFixture(file)))
          )[0]!;
        const classify = (solid: number) =>
          (['classifyPoint', 'classifyPointRobust'] as const).map((method) =>
            kernel[method](solid, ...recipe.witness, 1e-9)
          );
        const target = imported(recipe.target);
        const tool = imported(recipe.tool);
        expect(classify(target)).toEqual(['inside', 'inside']);
        expect(classify(tool)).toEqual(['inside', 'inside']);
        if (EXPECTED[name]!.outcome.kind === 'cut') {
          const cut = kernel.cut(
            kernel.copySolid(target),
            kernel.copySolid(tool)
          );
          expect(classify(cut)).toEqual(['outside', 'outside']);
        }
      } finally {
        kernel.free();
      }
    }, 120_000);
  }
});
