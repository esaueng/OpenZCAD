import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import { chamferRoundedEdgeFixture } from './fixtures/chamfer-rounded-edge';

describe('a chamfer ending on an existing round', { timeout: 120_000 }, () => {
  it('commits 2.1 mm, preserves its volume through undo/redo, and replays cold', async () => {
    const adapter = await createExactKernelAdapter();
    const cold = await createExactKernelAdapter();
    try {
      const fixture = await chamferRoundedEdgeFixture(adapter);
      const manager = new CommandManager(fixture.document);
      manager.execute(
        commandFactories.chamferEdges({
          name: 'Bottom chamfer',
          targetBodyId: fixture.bodyId,
          edgeHashes: [fixture.edge.hash],
          edgeReferences: [fixture.edge.reference!],
          size: 2.1
        })
      );
      const result = await adapter.syncDocument(manager.document);
      expect(result.warnings).toEqual([]);
      const body =
        result.bodyRepresentations[manager.document.bodyOrder.at(-1)!]!;
      // Integrate (2.1-y)*(35+sqrt(2y-y²)) from 0 to 1, then
      // (2.1-y)*36 from 1 to 2.1. The two original rounds remove
      // 2*(1-pi/4)*11.5 from the original box.
      const removed = 35 * 1.6 + (1.1 * Math.PI) / 4 + 1 / 3 + 18 * 1.1 ** 2;
      const expected = 36 * 41 * 11.5 - 2 * (1 - Math.PI / 4) * 11.5 - removed;
      expect(Math.abs(body.volume - expected)).toBeLessThan(0.002);
      manager.undo();
      const undone = await adapter.syncDocument(manager.document);
      expect(undone.warnings).toEqual([]);
      expect(undone.bodyRepresentations[fixture.bodyId]!.volume).toBeCloseTo(
        fixture.body.volume,
        5
      );
      manager.redo();
      const redone = await adapter.syncDocument(manager.document);
      expect(redone.warnings).toEqual([]);
      expect(redone.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
        body.volume,
        5
      );
      const replay = await cold.syncDocument(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      expect(replay.warnings).toEqual([]);
      expect(replay.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
        body.volume,
        5
      );
      const step = await cold.exportStep(manager.document, [body.bodyId]);
      expect(step).toContain('CYLINDRICAL_SURFACE');
      expect(step).toContain('ELLIPSE');
    } finally {
      adapter.dispose();
      cold.dispose();
    }
  });
});
