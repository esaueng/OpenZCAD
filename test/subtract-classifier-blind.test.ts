import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import type * as ResultAcceptance from '../packages/kernel-adapter/src/result-acceptance';

/**
 * Issue #1242: the kernel's point classifier misplaced the overlap of all
 * four recipes, so a cut-acceptance gate built on it alone accepted the
 * unchanged target. Reproduce the obsolete kernel's unchanged result and
 * blind the classifier. Subtract must still refuse from the tessellated
 * witness when the intersection cannot provide a volume measurement.
 */
vi.mock(
  '../packages/kernel-adapter/src/result-acceptance',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ResultAcceptance>()),
    cutRetainedToolMaterialWitness: () => null
  })
);

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/step/subtract-curved/${name}`, import.meta.url),
    'utf8'
  );

it('refuses a kept overlap the point classifier cannot see', async () => {
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
    const manager = new CommandManager(
      createProjectDocument('Blind classifier', toUserId('user_1242'))
    );
    for (const [name, file] of [
      ['Target', 'swept-arc-target.step'],
      ['Tool', 'crossing-sweep-tool.step']
    ] as const) {
      manager.execute(
        commandFactories.importStep({
          name,
          artifactId: `artifact_${name.toLowerCase()}`,
          sourceName: file,
          stepText: fixture(file)
        })
      );
    }
    const [target, tool] = manager.document.bodyOrder as [BodyId, BodyId];
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [target, tool]
      })
    );
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
    expect(failures[0]!.message).toMatch(/tessellated target, tool and result/);
    const result = manager.document.bodyOrder.at(-1)!;
    expect([...derived.exportableBodyIds].sort()).toEqual(
      [result, tool].sort()
    );
  } finally {
    vi.restoreAllMocks();
    adapter.dispose();
  }
}, 120_000);
