import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';

/**
 * QA 2026-11-14 #16. An in-place pattern's frame and its Done now commit the
 * same command, ids and name included. The live worker built that frame
 * (a proposing, full-lineage sync), so the rebuild that follows the commit
 * (the live, demand-carrying sync of the committed document) restores the
 * pattern from the frame's checkpoint instead of building it a third time.
 * A frame and a commit with different ids rebuilt the pattern each time.
 */
describe(
  'a pattern committed from its in-place preview',
  { timeout: 120_000 },
  () => {
    function bar() {
      let document = addPrimitiveFeature(
        createProjectDocument('Pattern reuse', toUserId('user_pattern_reuse')),
        {
          name: 'Bar',
          primitiveKind: 'box',
          dimensions: { width: 40, height: 6, depth: 4 }
        }
      );
      const first = document.bodyOrder[0]!;
      document = addPrimitiveFeature(document, {
        name: 'Rib',
        primitiveKind: 'box',
        dimensions: { width: 6, height: 6, depth: 10 }
      });
      const second = document.bodyOrder.at(-1)!;
      document = transformBody(document, {
        name: 'Move rib',
        targetBodyId: second,
        translation: { x: 10, y: 0, z: 0 }
      }).document;
      document = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [first, second]
      }).document;
      return { document, target: document.bodyOrder.at(-1)! };
    }

    it('restores the previewed pattern when the committed document rebuilds', async () => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (event) => events.push(event)
      });
      try {
        const { document: base, target } = bar();
        await adapter.syncDocument(base, undefined, undefined, undefined, {
          lineageDemand: []
        });
        const command = commandFactories.patternBody({
          name: 'Grid pattern',
          targetBodyId: target,
          patternKind: 'grid',
          count: 3,
          count2: 2,
          axis: 'y',
          axis2: 'z',
          spacing: 20,
          spacing2: 30
        });
        // The in-place frame: the candidate, built as a user edit's check is
        // and with the live lineage demand.
        const candidate = command.apply(base);
        const frame = await adapter.syncDocument(
          candidate,
          undefined,
          undefined,
          undefined,
          { proposeCarry: true, lineageDemand: [] }
        );
        const patternBody = candidate.bodyOrder.at(-1)!;
        expect(frame.bodyRepresentations[patternBody]).toBeDefined();
        // Done lands that very command; the live document then rebuilds.
        const manager = new CommandManager(base);
        manager.execute(command);
        events.length = 0;
        const live = await adapter.syncDocument(
          manager.document,
          undefined,
          undefined,
          undefined,
          { lineageDemand: [] }
        );
        expect(events.at(-1)).toMatchObject({
          kind: 'prefix-restore',
          replayed: 0,
          restored: candidate.featureOrder.length
        });
        expect(live.bodyRepresentations[patternBody]?.bbox).toEqual(
          frame.bodyRepresentations[patternBody]?.bbox
        );

        // The same request built under other ids, as Done used to commit it,
        // has to build the pattern again.
        const other = commandFactories.patternBody({
          ...command.payload,
          ids: undefined
        });
        events.length = 0;
        await adapter.syncDocument(
          other.apply(base),
          undefined,
          undefined,
          undefined,
          { lineageDemand: [] }
        );
        expect(events.at(-1)).toMatchObject({ replayed: 1 });
      } finally {
        adapter.dispose();
      }
    });
  }
);
