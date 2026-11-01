import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { mixedSeamFixture } from './fixtures/mixed-seam';

describe('mixed cylinder seam fillet', { timeout: 120_000 }, () => {
  it('builds all three selected edges as one undoable feature in every selection order', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const fixture = await mixedSeamFixture(adapter);
      const count = listFeaturesInOrder(fixture.document).length;
      let expectedVolume: number | undefined;
      for (const order of [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0]
      ]) {
        const manager = new CommandManager(fixture.document);
        const picked = order.map((i) => fixture.edges[i]!);
        manager.execute(
          commandFactories.filletEdges({
            name: 'Three-edge round',
            targetBodyId: fixture.bodyId,
            edgeHashes: picked.map((e) => e.hash),
            edgeReferences: picked.map((e) => e.reference!),
            size: 1
          })
        );
        expect(listFeaturesInOrder(manager.document)).toHaveLength(count + 1);
        const resultId = listFeaturesInOrder(manager.document).at(-1)!.bodyId!;
        const built = await adapter.syncDocument(manager.document);
        expect(built.warnings).toEqual([]);
        const body = built.bodyRepresentations[resultId]!;
        expect(body.volume).toBeGreaterThan(fixture.volume + 1);
        expect(body.volume).toBeLessThan(fixture.volume + 10);
        if (expectedVolume === undefined) expectedVolume = body.volume;
        expect(body.volume).toBeCloseTo(expectedVolume, 6);
        manager.undo();
        expect(listFeaturesInOrder(manager.document)).toHaveLength(count);
        const undone = await adapter.syncDocument(manager.document);
        expect(undone.bodyRepresentations[fixture.bodyId]!.volume).toBeCloseTo(
          fixture.volume,
          6
        );
        manager.redo();
        expect(listFeaturesInOrder(manager.document)).toHaveLength(count + 1);
        const redone = await adapter.syncDocument(manager.document);
        expect(redone.warnings).toEqual([]);
        expect(redone.bodyRepresentations[resultId]!.volume).toBeCloseTo(
          expectedVolume,
          6
        );
      }
    } finally {
      adapter.dispose();
    }
  });
});
