import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { meshWindingNumber } from '../packages/kernel-adapter/src/result-acceptance';

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
 */

interface Recipe {
  target: string;
  tool: string;
  targetVolume: number;
  toolVolume: number;
  cutVolume: number;
  sharedVolume: number;
  witness: [number, number, number];
  witnessClearance: number;
}

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/step/subtract-curved/${name}`, import.meta.url),
    'utf8'
  );
const REFERENCE = JSON.parse(fixture('reference.json')) as Record<
  string,
  Recipe
>;

type Outcome =
  { kind: 'cut' } | { kind: 'refused'; family: string; code: string };

/**
 * What each recipe does on the pinned Remus build, and whether its visible
 * bodies export to STEP. An export regex pins a kernel STEP defect the
 * export reports by name (see the PR for #1242): it fails loudly and never
 * writes a wrong body, and the day it passes this table must say so.
 */
const EXPECTED: Record<string, { outcome: Outcome; exportFailure?: RegExp }> = {
  // The issue's primary recipe. Remus 2026.1.135 cuts it correctly; the
  // cut's fitted intersection edges miss their vertices by up to 4.9e-7
  // under a 1e-7 edge tolerance, which the STEP writer's arena check
  // refuses.
  'revolve-sweep': {
    outcome: { kind: 'cut' },
    exportFailure:
      /arena edge \d+: start residual .* exceeds effective tolerance/
  },
  'revolve-trimmed-nurbs': {
    outcome: {
      kind: 'refused',
      family: 'boolean',
      code: 'exact_only_unattainable'
    }
  },
  // The kernel reports this cut as built and returns an open body with no
  // tool faces; the result-acceptance gate refuses it. The swept target
  // itself cannot be re-exported: its cap circles import with a
  // zero-length (π, π) NURBS pcurve.
  'sweep-sweep': {
    outcome: {
      kind: 'refused',
      family: 'validation',
      code: 'cut_kept_tool_material'
    },
    exportFailure: /pcurve has invalid parameter range/
  },
  'sweep-loft': {
    outcome: {
      kind: 'refused',
      family: 'boolean',
      code: 'exact_only_unattainable'
    },
    exportFailure: /pcurve has invalid parameter range/
  }
};

/** Volumes agree with OCCT's to a part in a thousand (tessellated measure). */
function expectVolume(actual: number | undefined, expected: number): void {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected)).toBeLessThan(expected * 1e-3);
}

/**
 * Whether a body's display mesh encloses the witness. Independent of the
 * kernel's point classifier, which the issue found misplacing the overlap.
 */
function meshEncloses(
  body: { mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> } },
  point: readonly number[]
): boolean {
  return (
    meshWindingNumber(
      {
        positions: Float64Array.from(body.mesh.vertices),
        indices: Uint32Array.from(body.mesh.indices)
      },
      point
    ) > 0.5
  );
}

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
      const manager = new CommandManager(
        createProjectDocument(`Subtract ${name}`, toUserId('user_1242'))
      );
      for (const [label, file] of [
        ['Target', recipe.target],
        ['Tool', recipe.tool]
      ] as const) {
        manager.execute(
          commandFactories.importStep({
            name: label,
            artifactId: `artifact_${label.toLowerCase()}`,
            sourceName: file,
            stepText: fixture(file)
          })
        );
      }
      const [target, tool] = manager.document.bodyOrder as [BodyId, BodyId];

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

      manager.execute(
        commandFactories.booleanBodies({
          name: 'Subtract',
          operation: 'subtract',
          targetBodyIds: [target, tool]
        })
      );
      const result = manager.document.bodyOrder.at(-1)!;

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

        const exporting = fresh.exportStep(
          reloadedDocument,
          reloadedDocument.bodyOrder
        );
        if (expected.exportFailure) {
          await expect(exporting).rejects.toThrow(expected.exportFailure);
        } else {
          // Independent STEP check: the export re-imported into a fresh
          // kernel holds the reference volumes, and the witness lies in the
          // target only when the Subtract was refused.
          const step = await exporting;
          const io = await loadRemusTranslators();
          const kernel = new RemusKernel();
          try {
            const solids = [
              ...kernel.deserializeSolids(
                io.importStep(new TextEncoder().encode(step))
              )
            ];
            const volumes = solids
              .map((solid) => kernel.volume(solid, 0.01))
              .sort((a, b) => a - b);
            const expectedVolumes = (
              expected.outcome.kind === 'cut'
                ? [recipe.cutVolume]
                : [recipe.targetVolume, recipe.toolVolume]
            ).sort((a, b) => a - b);
            expect(volumes).toHaveLength(expectedVolumes.length);
            volumes.forEach((volume, index) =>
              expectVolume(volume, expectedVolumes[index]!)
            );
            const inside = solids.filter((solid) => {
              const mesh = kernel.tessellateSolid(solid, 0.01);
              try {
                return (
                  meshWindingNumber(
                    {
                      positions: mesh.positions.slice(),
                      indices: mesh.indices.slice()
                    },
                    recipe.witness
                  ) > 0.5
                );
              } finally {
                mesh.free();
              }
            });
            expect(inside).toHaveLength(
              expected.outcome.kind === 'cut' ? 0 : 2
            );
          } finally {
            kernel.free();
          }
        }
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
});
