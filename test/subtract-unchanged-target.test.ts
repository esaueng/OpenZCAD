// @vitest-environment happy-dom

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
  reimportedStepSolids,
  subtractCommand
} from './support/subtract-curved';
import { validatedCreate } from './support/validated-commit';

/**
 * Issue #1242, the defect itself rather than the kernel that showed it: the
 * exact cut reports success and hands the target back unchanged, for every
 * recipe the issue names. `subtract-curved-operands.test.ts` pins what the
 * installed Remus build does with those operands; this pins what the app
 * does when a kernel build regresses to the reported behaviour, so the
 * guard does not depend on the pin staying right.
 *
 * Whatever the kernel returns, a Subtract must not publish the unchanged
 * target as its result and consume the tool:
 * - the workspace's Create refuses it with the reason and commits nothing:
 *   no Subtract in history and no Undo entry for it;
 * - a document that already holds the Subtract (saved while the kernel cut
 *   correctly) refuses it on rebuild and again on reload, keeps the tool
 *   visible, exports both sources as they were, and Undo restores them.
 *
 * Two gates stand behind that, and each recipe is driven through each one:
 * - `measured`: the intersect measures the overlap, and the removed volume
 *   falls short of it. The installed kernel cannot intersect every recipe
 *   (trimmed NURBS and loft refuse), and where it cannot, this case would
 *   fall through to the second gate unseen. So the intersect answers with a
 *   stand-in of OCCT's shared volume: the gate reads only that volume.
 * - `unmeasured`: the intersect cannot measure it, and the kernel's point
 *   classifier finds a point inside the target, the tool and the result.
 * `subtract-classifier-blind.test.ts` blinds that classifier as well, which
 * leaves the tessellated witness.
 */

/** The message of the gate that compares removed volume to the overlap. */
const REMOVED_TOO_LITTLE =
  /^Feature "Subtract": Subtract refused: the tool overlaps the target by ([\d.]+) mm³, but the kernel removed 0 mm³; .* The target and tools were left unchanged\.$/;
/**
 * The gate that finds a kept point, when the kernel's own point classifier
 * found it: the headline, then the classifier's detail. The tessellated
 * witness writes "the tessellated target, tool and result all enclose
 * point …" instead.
 */
const KEPT_OVERLAP_BY_CLASSIFIER =
  /^Feature "Subtract": Subtract refused: the exact kernel returned the target without removing the material the tool overlaps\. The target and tools were left unchanged\.\nAcceptance check cut_kept_tool_material: the kernel reported the cut as built, but point \([^)\n]+\) lies inside the target, the tool and the result\.$/;

type Overlap = 'measured' | 'unmeasured';

/**
 * The regressed kernel: every cut reports success with the target
 * unchanged, and the intersect either measures OCCT's overlap or cannot.
 */
function regressKernel(name: string, overlap: Overlap) {
  const cut = vi.spyOn(RemusKernel.prototype, 'booleanWithCancellation');
  cut.mockImplementation(function (this: RemusKernel, _op, target) {
    return {
      status: 'completed',
      result: { solid: this.copySolid(target), quality: 'exact' }
    };
  });
  const intersect = vi.spyOn(RemusKernel.prototype, 'intersectDetailed');
  if (overlap === 'measured') {
    // A cube of OCCT's shared volume (`reference.json`).
    const side = Math.cbrt(SUBTRACT_RECIPES[name]!.sharedVolume);
    intersect.mockImplementation(function (this: RemusKernel) {
      return {
        status: 'ok',
        code: null,
        category: null,
        details: {},
        value: this.makeBox(side, side, side)
      };
    });
  } else {
    intersect.mockReturnValue({
      status: 'error',
      category: 'nonconvergence',
      code: 'overlap_not_measured',
      details: {},
      value: null
    });
  }
  return { cut, intersect };
}

/** The adapter's refusal, by the gate `overlap` selects. */
function expectGate(
  failure: {
    message: string;
    kernelRefusal?: unknown;
  },
  overlap: Overlap,
  sharedVolume: number
): void {
  if (overlap === 'measured') {
    // The removed-volume gate answers, untyped, and the kept-point gates
    // are not consulted.
    expect(failure.kernelRefusal).toBeUndefined();
    const measured = REMOVED_TOO_LITTLE.exec(failure.message);
    expect(measured, failure.message).not.toBeNull();
    // The overlap it names is OCCT's shared volume.
    expectVolume(Number(measured![1]), sharedVolume);
  } else {
    expect(failure.kernelRefusal).toEqual({
      family: 'validation',
      category: 'internal',
      code: 'cut_kept_tool_material'
    });
    expect(failure.message).toMatch(KEPT_OVERLAP_BY_CLASSIFIER);
  }
}

describe('Subtract when the kernel returns the target unchanged (#1242)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const overlap of ['measured', 'unmeasured'] as const) {
    for (const [name, recipe] of Object.entries(SUBTRACT_RECIPES)) {
      it(`${name}, overlap ${overlap}: the Create refuses and commits nothing`, async () => {
        const { cut, intersect } = regressKernel(name, overlap);
        const { manager, target, tool } = importSubtractRecipe(name);
        const before = manager.document;
        const undoLabel = manager.undoLabel;
        expect(undoLabel).not.toBeNull();
        const adapter = await createExactKernelAdapter();
        try {
          const command = subtractCommand(target, tool);
          const resultBodyId = command.payload.ids!.bodyId;
          let derived: ProjectDocument['derived'] | null = null;
          const create = await validatedCreate(
            manager,
            command,
            { featureName: 'Subtract', resultBodyId },
            async (candidate) =>
              (derived = await adapter.syncDocument(candidate))
          );

          // The candidate was rebuilt and the kernel answered the cut with
          // the unchanged target: the refusal is the adapter's verdict.
          expect(cut.mock.calls.map((call) => call[0])).toEqual(['cut']);
          expect(intersect).toHaveBeenCalledTimes(1);
          const failures = (derived!.featureWarnings ?? []).filter(
            (warning) => warning.featureName === 'Subtract'
          );
          expect(failures).toHaveLength(1);
          expectGate(failures[0]!, overlap, recipe.sharedVolume);

          // Refused: nothing reached history, and the card and History
          // both carry the adapter's reason.
          expect(create.outcome).toBe('rejected');
          expect(create.committed).toEqual([]);
          expect(manager.document).toBe(before);
          expect(manager.undoLabel).toBe(undoLabel);
          expect(manager.canRedo).toBe(false);
          expect(create.rejections).toHaveLength(1);
          const rejection = create.rejections[0]!;
          expect(rejection.featureName).toBe('Subtract');
          expect(rejection.message).toMatch(
            overlap === 'measured'
              ? /^Subtract refused: the tool overlaps the target by [\d.]+ mm³, but the kernel removed 0 mm³/
              : /^Subtract refused: the exact kernel returned the target without removing the material the tool overlaps\./
          );
          expect(create.failures).toEqual([rejection.message]);

          // The Undo the refusal left in place is the one before it: the
          // tool's import, not a Subtract.
          manager.undo();
          expect(manager.document.bodyOrder).toEqual([target]);
        } finally {
          adapter.dispose();
        }
      }, 120_000);

      it(`${name}, overlap ${overlap}: a saved Subtract refuses on rebuild and keeps both sources`, async () => {
        const { cut } = regressKernel(name, overlap);
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
          expectGate(failure, overlap, recipe.sharedVolume);
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
          expect(reloaded.message).toBe(committed.message);
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
