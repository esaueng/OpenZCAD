import { beforeAll, describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  duplicateFeatureCommands,
  duplicateFeatureRefusal,
  replayCommands
} from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * U06 (ZC-104): Duplicate repeats a Move, Mirror or Pattern step. The copy
 * reads the source's references, takes new identities, lands right after the
 * source and is one undoable transaction; other kinds refuse explicitly.
 */
describe('duplicate history step (ZC-104)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  const blank = () =>
    createProjectDocument('Duplicate step', toUserId('user_zc104'));

  function manager() {
    const commands = new CommandManager(blank());
    const block = commandFactories.addPrimitive({
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    commands.execute(block);
    return { commands, blockId: block.payload.ids!.bodyId };
  }

  const order = (document: ProjectDocument) =>
    listFeaturesInOrder(document).map((feature) => feature.name);

  function duplicate(commands: CommandManager, featureId: FeatureId) {
    const {
      commands: steps,
      featureId: copyId,
      label
    } = duplicateFeatureCommands(commands.document, featureId);
    commands.runTransaction(label, steps);
    return copyId;
  }

  async function bbox(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const { min, max } = derived.bodyRepresentations[bodyId]!.bbox;
    const r = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
    return [r(min.x), r(min.y), r(min.z), r(max.x), r(max.y), r(max.z)];
  }

  it('repeats a Move right after it, and one undo takes the copy away', async () => {
    const { commands, blockId } = manager();
    const move = commandFactories.transformBody({
      name: 'Move',
      targetBodyId: blockId,
      translation: { x: 10, y: 0, z: 0 }
    });
    commands.execute(move);
    commands.execute(
      commandFactories.addPrimitive({
        name: 'Later',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const before = commands.document;
    expect(await bbox(before, blockId)).toEqual([10, 0, 0, 20, 10, 10]);

    const copyId = duplicate(commands, move.payload.ids!.featureId);
    expect(copyId).not.toBe(move.payload.ids!.featureId);
    expect(order(commands.document)).toEqual([
      'Block',
      'Move',
      'Move 2',
      'Later'
    ]);
    expect(await bbox(commands.document, blockId)).toEqual([
      20, 0, 0, 30, 10, 10
    ]);

    // The command log replays to the same history.
    expect(
      order(replayCommands(blank(), commands.document.commandLog))
    ).toEqual(order(commands.document));

    commands.undo();
    expect(order(commands.document)).toEqual(order(before));
    expect(await bbox(commands.document, blockId)).toEqual([
      10, 0, 0, 20, 10, 10
    ]);
  });

  it('duplicates a transform copy without moving its source or reusing its result', async () => {
    const { commands, blockId } = manager();
    const move = commandFactories.transformBody({
      name: 'Copy',
      targetBodyId: blockId,
      copy: true,
      translation: { x: 20, y: 0, z: 0 }
    });
    commands.execute(move);
    const originalCopy = listFeaturesInOrder(commands.document).at(-1)!;
    const before = commands.document;
    const duplicateId = duplicate(commands, originalCopy.featureId);
    const result = listFeaturesInOrder(commands.document).find(
      (feature) => feature.featureId === duplicateId
    )!;
    expect(result.data).toMatchObject({
      featureKind: 'transform',
      copy: true,
      targetBodyId: blockId
    });
    expect(result.bodyId).toBeDefined();
    expect(result.bodyId).not.toBe(originalCopy.bodyId);
    expect(commands.document.bodyOrder).toHaveLength(3);
    const verifyBodies = async (document: ProjectDocument) => {
      expect(await bbox(document, blockId)).toEqual([0, 0, 0, 10, 10, 10]);
      expect(await bbox(document, originalCopy.bodyId!)).toEqual([
        20, 0, 0, 30, 10, 10
      ]);
      expect(await bbox(document, result.bodyId!)).toEqual([
        20, 0, 0, 30, 10, 10
      ]);
    };
    await verifyBodies(commands.document);
    commands.undo();
    expect(commands.document.bodyOrder).toEqual(before.bodyOrder);
    commands.redo();
    await verifyBodies(commands.document);
    const replayed = replayCommands(blank(), commands.document.commandLog);
    expect(replayed.bodyOrder).toEqual(commands.document.bodyOrder);
    await verifyBodies(replayed);
  });

  it('copies a Mirror as a new body reading the same body and plane', async () => {
    const { commands, blockId } = manager();
    const mirror = commandFactories.mirrorBody({
      name: 'Mirror',
      targetBodyId: blockId,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    commands.execute(mirror);
    const copyId = duplicate(commands, mirror.payload.ids!.featureId);
    const copy = listFeaturesInOrder(commands.document).find(
      (feature) => feature.featureId === copyId
    )!;
    expect(copy.bodyId).toBeDefined();
    expect(copy.bodyId).not.toBe(mirror.payload.ids!.bodyId);
    expect(copy.data).toEqual(
      expect.objectContaining({ targetBodyId: blockId })
    );
    const mirrored = await bbox(commands.document, mirror.payload.ids!.bodyId);
    expect(await bbox(commands.document, copy.bodyId!)).toEqual(mirrored);
    expect(await bbox(commands.document, blockId)).toEqual([
      0, 0, 0, 10, 10, 10
    ]);
  });

  it('copies a Pattern mid-history with its own body', async () => {
    const { commands, blockId } = manager();
    const pattern = commandFactories.patternBody({
      name: 'Row',
      targetBodyId: blockId,
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 20
    });
    commands.execute(pattern);
    commands.execute(
      commandFactories.addPrimitive({
        name: 'Later',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const copyId = duplicate(commands, pattern.payload.ids!.featureId);
    expect(order(commands.document)).toEqual([
      'Block',
      'Row',
      'Row 2',
      'Later'
    ]);
    const copy = listFeaturesInOrder(commands.document).find(
      (feature) => feature.featureId === copyId
    )!;
    expect(copy.bodyId).not.toBe(pattern.payload.ids!.bodyId);
    expect(await bbox(commands.document, copy.bodyId!)).toEqual(
      await bbox(commands.document, pattern.payload.ids!.bodyId)
    );
  });

  it('refuses a step past the end of history', () => {
    const { commands, blockId } = manager();
    const move = commandFactories.transformBody({
      name: 'Move',
      targetBodyId: blockId,
      translation: { x: 10, y: 0, z: 0 }
    });
    commands.execute(move);
    const node = listFeaturesInOrder(commands.document).find(
      (feature) => feature.featureId === move.payload.ids!.featureId
    )!;
    commands.execute(
      commandFactories.setNodeMetadata({
        nodeId: node.id,
        metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    expect(
      duplicateFeatureRefusal(commands.document, move.payload.ids!.featureId)
    ).toMatch(/past the end of history/);
  });

  it('refuses other kinds with a reason', () => {
    const { commands } = manager();
    const block = listFeaturesInOrder(commands.document)[0]!;
    expect(duplicateFeatureRefusal(commands.document, block.featureId)).toBe(
      'Duplicate covers Move, Mirror and Pattern steps only.'
    );
    expect(() =>
      duplicateFeatureCommands(commands.document, block.featureId)
    ).toThrow(/Move, Mirror and Pattern/);
  });
});
