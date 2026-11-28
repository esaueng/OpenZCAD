import { expect, it, vi } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import type * as ResultAcceptance from '../packages/kernel-adapter/src/result-acceptance';
import {
  SUBTRACT_RECIPES,
  commitSubtract,
  importSubtractRecipe
} from './support/subtract-curved';

/**
 * Issue #1242: the kernel's point classifier misplaced the overlap of all
 * four recipes, so a cut-acceptance gate built on it alone accepted the
 * unchanged target. Reproduce the obsolete kernel's unchanged result and
 * blind the classifier. Subtract must still refuse from the tessellated
 * witness when the intersection cannot provide a volume measurement, for
 * each of the four.
 */
vi.mock(
  '../packages/kernel-adapter/src/result-acceptance',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ResultAcceptance>()),
    cutRetainedToolMaterialWitness: () => null
  })
);

it.each(Object.keys(SUBTRACT_RECIPES))(
  'refuses a kept %s overlap the point classifier cannot see',
  async (name) => {
    const adapter = await createExactKernelAdapter();
    try {
      const intersect = vi.spyOn(RemusKernel.prototype, 'intersectDetailed');
      intersect.mockReturnValue({
        status: 'error',
        category: 'nonconvergence',
        code: 'overlap_not_measured',
        details: {},
        value: null
      });
      const cut = vi.spyOn(RemusKernel.prototype, 'booleanWithCancellation');
      cut.mockImplementation(function (this: RemusKernel, _operation, target) {
        return {
          status: 'completed',
          result: { solid: this.copySolid(target), quality: 'exact' }
        };
      });
      const { manager, target, tool } = importSubtractRecipe(name);
      const result = commitSubtract(manager, target, tool);
      const derived = await adapter.syncDocument(manager.document);
      expect(intersect).toHaveBeenCalled();
      expect(cut).toHaveBeenCalledWith(
        'cut',
        expect.any(Number),
        expect.any(Number),
        expect.anything(),
        true
      );
      const failures = (derived.featureWarnings ?? []).filter(
        (warning) => warning.featureName === 'Subtract'
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.kernelRefusal).toEqual({
        family: 'validation',
        category: 'internal',
        code: 'cut_kept_tool_material'
      });
      expect(failures[0]!.message).toMatch(
        /tessellated target, tool and result/
      );
      expect([...derived.exportableBodyIds].sort()).toEqual(
        [result, tool].sort()
      );
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  },
  120_000
);
