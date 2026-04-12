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

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);

    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(1);

    const kernel = createMockKernelAdapter();
    const derived = kernel.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
  });
});

