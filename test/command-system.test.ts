import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import { toUserId } from '@openzcad/shared';

describe('command-system', () => {
  it('supports execute and undo/redo around replayable commands', () => {
    const manager = new CommandManager(
      createProjectDocument('Command Test', toUserId('user_test'))
    );

    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );

    expect(manager.document.bodyOrder).toHaveLength(1);

    const bodyId = manager.document.bodyOrder[0];
    expect(bodyId).toBeTruthy();
    if (!bodyId) {
      return;
    }

    manager.execute(
      commandFactories.resizeBody({
        targetBodyId: bodyId,
        dimension: 'depth',
        value: 18
      })
    );
    manager.execute(
      commandFactories.filletBody({
        targetBodyId: bodyId,
        edgeIds: [`${bodyId}:m0:e0`],
        radius: 2
      })
    );
    expect(manager.document.commandLog.at(-1)?.kind).toBe('feature.fillet');

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(1);

    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(1);

    const kernel = createMockKernelAdapter();
    const derived = kernel.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
    const representation = derived.bodyRepresentations[bodyId];
    expect(representation?.geometry.kind).toBe('box');
  });
});
