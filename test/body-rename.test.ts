import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findBodyNode,
  listFeaturesInOrder,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';

/**
 * ZC-127: a body renamed from Objects keeps everything built on it. Features
 * name their inputs by BodyId, never by name, so the rename is one undoable
 * `node.rename` and a later boolean, an edit of the renamed body's feature,
 * a reload and a replay all keep the new name and the same geometry.
 */
describe('body rename (U06, ZC-127)', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  const owner = toUserId('user_body_rename');

  function twoBoxes() {
    const manager = new CommandManager(createProjectDocument('Rename', owner));
    // Corner-origin boxes: 20×10×10 and 10×10×30 share a 10 mm cube.
    for (const [name, width, depth] of [
      ['Box', 20, 10],
      ['Lug', 10, 30]
    ] as const) {
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions: { width, height: 10, depth }
        })
      );
    }
    const [box, lug] = manager.document.bodyOrder as [BodyId, BodyId];
    return { manager, box, lug };
  }

  const nameOf = (document: ProjectDocument, bodyId: BodyId) =>
    findBodyNode(document, bodyId)?.name;

  it('keeps a boolean on the renamed body through an edit, reload and replay', async () => {
    const { manager, box, lug } = twoBoxes();
    const node = findBodyNode(manager.document, box)!;
    manager.runTransaction('Rename Box 1 to Base', [
      commandFactories.renameNode({ nodeId: node.id, name: 'Base' })
    ]);
    expect(nameOf(manager.document, box)).toBe('Base');

    const union = commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [box, lug]
    });
    manager.execute(union);
    const unionBody = (union.payload.ids as { bodyId: BodyId }).bodyId;
    // Legacy naming: a union with no stored name takes its base body's.
    expect(nameOf(manager.document, unionBody)).toBe('Base');

    // Editing the renamed body's own feature does not re-derive its name.
    const boxFeature = listFeaturesInOrder(manager.document)[0]!;
    manager.execute(
      commandFactories.updateFeature({
        featureId: boxFeature.featureId,
        data: { dimensions: { width: 25 } }
      })
    );
    expect(nameOf(manager.document, box)).toBe('Base');

    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[box]).toMatchObject({
      name: 'Base',
      consumed: true
    });
    // The widened 25×10×10 block and the 10×10×30 lug: 2500 + 3000 − 1000.
    expect(derived.bodyRepresentations[unionBody]!.volume).toBeCloseTo(4500, 3);

    // Reload: the saved JSON normalizes to the same names and references.
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(nameOf(reopened, box)).toBe('Base');
    expect(nameOf(reopened, unionBody)).toBe('Base');
    const reopenedDerived = await adapter.syncDocument(reopened);
    expect(reopenedDerived.bodyRepresentations[unionBody]!.volume).toBeCloseTo(
      4500,
      3
    );

    // Replay from the command log reproduces the rename in order.
    const replayed = replayCommands(
      createProjectDocument('Rename', owner),
      manager.document.commandLog
    );
    expect(nameOf(replayed, box)).toBe('Base');
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
  });

  it('undoes and redoes the rename as one step', () => {
    const { manager, box } = twoBoxes();
    const before = nameOf(manager.document, box);
    const node = findBodyNode(manager.document, box)!;
    manager.runTransaction('Rename', [
      commandFactories.renameNode({ nodeId: node.id, name: 'Base' })
    ]);
    manager.undo();
    expect(nameOf(manager.document, box)).toBe(before);
    manager.redo();
    expect(nameOf(manager.document, box)).toBe('Base');
  });
});
