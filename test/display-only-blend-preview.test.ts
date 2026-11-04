import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type EdgeTopology } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * A fillet drag's frames build their blends display-only (the kernel skips
 * its measuring postconditions); the rest check and the commit rebuild them
 * checked. The history cache must never hand a checked sync the blend a
 * frame built, or a drag would commit geometry nothing ever checked.
 */

const kernelSwitch = RemusKernel.prototype as unknown as {
  setDisplayOnlyBlends?: (enabled: boolean) => void;
  displayOnlyBlendsEnabled?: () => boolean;
};
const supported = typeof kernelSwitch.setDisplayOnlyBlends === 'function';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

type Blend = (this: RemusKernel, ...args: unknown[]) => unknown;
const prototype = RemusKernel.prototype as unknown as Record<string, Blend>;
const originals = new Map<string, Blend>();
afterEach(() => {
  for (const [name, original] of originals) prototype[name] = original;
  originals.clear();
});

/** Records, for every kernel fillet, whether it ran display-only. */
function recordFillets(): boolean[] {
  const seen: boolean[] = [];
  for (const name of ['filletWithEvolution', 'filletDetailed', 'fillet']) {
    const original = prototype[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    prototype[name] = function (this: RemusKernel, ...args: unknown[]) {
      seen.push(
        Boolean(
          (this as unknown as typeof kernelSwitch).displayOnlyBlendsEnabled?.()
        )
      );
      return original.apply(this, args);
    };
  }
  return seen;
}

const along = (edge: EdgeTopology, offset: number) =>
  edge.points.filter((_, index) => index % 3 === offset);

describe.skipIf(!supported)('display-only blend previews', () => {
  it('builds drag frames display-only and the next complete sync checked', async () => {
    const manager = new CommandManager(
      createProjectDocument('Block', toUserId('user_display_only'), 'mm')
    );
    const block = createBodyFeatureIds();
    manager.runTransaction('Block', [
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 18 },
        ids: block
      })
    ]);
    const base = attachDerivedState(
      manager.document,
      await adapter.syncDocument(manager.document)
    );
    // The box's top front edge.
    const edge = base.derived.bodyRepresentations[
      block.bodyId
    ]!.topology!.edges.find((candidate) => {
      const xs = along(candidate, 0);
      return (
        along(candidate, 1).every((y) => Math.abs(y) < 1e-6) &&
        along(candidate, 2).every((z) => Math.abs(z - 18) < 1e-6) &&
        Math.max(...xs) - Math.min(...xs) > 29
      );
    })!;
    const ids = createBodyFeatureIds();
    const at = (size: number) =>
      commandFactories
        .filletEdges({
          name: 'Fillet edges 1',
          targetBodyId: block.bodyId,
          edgeHashes: [edge.hash],
          edgeReferences: [edge.reference!],
          size,
          ids
        })
        .apply(base);

    const fillets = recordFillets();
    const frame = await adapter.previewGeometry(at(2));
    expect(frame.bodyRepresentations[ids.bodyId]).toBeDefined();
    expect(fillets.length).toBeGreaterThan(0);
    expect(fillets.every((displayOnly) => displayOnly)).toBe(true);

    // The rest check at the very size the frame showed.
    fillets.length = 0;
    const checked = await adapter.syncDocument(at(2));
    expect(checked.bodyRepresentations[ids.bodyId]).toBeDefined();
    expect(fillets.length).toBeGreaterThan(0);
    expect(fillets.every((displayOnly) => !displayOnly)).toBe(true);
    expect(
      (kernelSwitch.displayOnlyBlendsEnabled as () => boolean).call(
        new RemusKernel()
      )
    ).toBe(false);
  });
});
