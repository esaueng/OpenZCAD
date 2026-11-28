import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  SUBTRACT_RECIPES,
  commitSubtract,
  expectVolume,
  importSubtractRecipe,
  meshEncloses,
  reimportedStepSolids
} from './support/subtract-curved';

/**
 * Issue #1242, the defect itself rather than the kernel that showed it: the
 * exact cut reports success and hands the target back unchanged, for every
 * recipe the issue names. `subtract-curved-operands.test.ts` pins what the
 * installed Remus build does with those operands; this pins what the app
 * does when a kernel build regresses to the reported behaviour, so the
 * guard does not depend on the pin staying right.
 *
 * Whatever the kernel returns, a Subtract must not publish the unchanged
 * target as its result and consume the tool. It refuses with the reason,
 * the tool stays visible, both sources export as they were, and Undo
 * restores them, on commit and again on reload.
 *
 * Two gates stand behind that, and each recipe is driven through both:
 * - the kernel's own intersect measures the overlap, and the removed
 *   volume falls short of it;
 * - the intersect cannot measure it, and a point inside the target, the
 *   tool and the result proves the overlap was kept.
 * `subtract-classifier-blind.test.ts` repeats the second with the kernel's
 * point classifier blinded as well.
 */

/** The message of the gate that compares removed volume to the overlap. */
const REMOVED_TOO_LITTLE =
  /^Feature "Subtract": Subtract refused: the tool overlaps the target by [\d.]+ mm³, but the kernel removed 0 mm³; .* The target and tools were left unchanged\.$/;
/** The headline of the gate that finds a kept point. */
const KEPT_OVERLAP =
  /^Feature "Subtract": Subtract refused: the exact kernel returned the target without removing the material the tool overlaps\. The target and tools were left unchanged\.\n/;

describe('Subtract when the kernel returns the target unchanged (#1242)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const overlap of ['measured', 'unmeasured'] as const) {
    for (const [name, recipe] of Object.entries(SUBTRACT_RECIPES)) {
      it(`${name}, overlap ${overlap}: refuses and keeps both sources`, async () => {
        const cut = vi.spyOn(RemusKernel.prototype, 'booleanWithCancellation');
        cut.mockImplementation(function (this: RemusKernel, _op, target) {
          return {
            status: 'completed',
            result: { solid: this.copySolid(target), quality: 'exact' }
          };
        });
        if (overlap === 'unmeasured') {
          vi.spyOn(RemusKernel.prototype, 'intersectDetailed').mockReturnValue({
            status: 'error',
            category: 'nonconvergence',
            code: 'overlap_not_measured',
            details: {},
            value: null
          });
        }

        const { manager, target, tool } = importSubtractRecipe(name);
        const result = commitSubtract(manager, target, tool);

        const check = async (
          adapter: ExactKernelAdapter,
          doc: ProjectDocument
        ) => {
          const calls = cut.mock.calls.length;
          const derived = await adapter.syncDocument(doc);
          // The kernel was asked, and answered with the unchanged target:
          // the refusal below is the adapter's, not a kernel precondition.
          expect(cut.mock.calls.slice(calls).map((call) => call[0])).toEqual([
            'cut'
          ]);
          const failures = (derived.featureWarnings ?? []).filter(
            (warning) => warning.featureName === 'Subtract'
          );
          expect(failures).toHaveLength(1);
          const failure = failures[0]!;
          expect(failure.kind).toBe('build-failed');
          if (failure.kernelRefusal) {
            expect(failure.kernelRefusal).toEqual({
              family: 'validation',
              category: 'internal',
              code: 'cut_kept_tool_material'
            });
            expect(failure.message).toMatch(KEPT_OVERLAP);
          } else {
            // Only a measured overlap reaches the removed-volume gate.
            expect(overlap).toBe('measured');
            expect(failure.message).toMatch(REMOVED_TOO_LITTLE);
          }
          // Nothing consumed: the tool is still a visible, exportable body
          // and the failed step passes the target through where its result
          // would stand (ADR-017), reported as failed rather than as a cut.
          expect([...derived.exportableBodyIds].sort()).toEqual(
            [result, tool].sort()
          );
          const passedThrough = derived.bodyRepresentations[result]!;
          expectVolume(passedThrough.volume, recipe.targetVolume);
          expect(meshEncloses(passedThrough, recipe.witness)).toBe(true);
          const keptTool = derived.bodyRepresentations[tool]!;
          expectVolume(keptTool.volume, recipe.toolVolume);
          expect(meshEncloses(keptTool, recipe.witness)).toBe(true);
          return failure;
        };

        const adapter = await createExactKernelAdapter();
        const fresh = await createExactKernelAdapter();
        try {
          const committed = await check(adapter, manager.document);

          // Reload: the persisted document rebuilt by a fresh adapter
          // refuses the same way, and exports the two sources.
          const reloadedDocument = JSON.parse(
            JSON.stringify(manager.document)
          ) as ProjectDocument;
          const reloaded = await check(fresh, reloadedDocument);
          expect(reloaded.kernelRefusal).toEqual(committed.kernelRefusal);
          const solids = await reimportedStepSolids(
            await fresh.exportStep(
              reloadedDocument,
              reloadedDocument.bodyOrder
            ),
            recipe.witness
          );
          expect(solids).toHaveLength(2);
          const [smaller, larger] = [
            recipe.targetVolume,
            recipe.toolVolume
          ].sort((a, b) => a - b) as [number, number];
          solids.sort((a, b) => a.volume - b.volume);
          expectVolume(solids[0]!.volume, smaller);
          expectVolume(solids[1]!.volume, larger);
          expect(solids.map((solid) => solid.enclosesPoint)).toEqual([
            true,
            true
          ]);

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
          expectVolume(
            undone.bodyRepresentations[tool]!.volume,
            recipe.toolVolume
          );
        } finally {
          fresh.dispose();
          adapter.dispose();
        }
      }, 120_000);
    }
  }
});
