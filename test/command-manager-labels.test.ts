import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/**
 * The status line and the undo toast name what an undo or redo would revert
 * ("Undo Delete Boss"), so the manager exposes the label at each end of its
 * stacks without popping anything.
 */
describe('CommandManager undo and redo labels', () => {
  it('reports the label at the top of each stack, or null when empty', () => {
    const manager = new CommandManager(
      createProjectDocument('Labels', toUserId('user_test'))
    );
    expect(manager.undoLabel).toBeNull();
    expect(manager.redoLabel).toBeNull();

    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    expect(manager.undoLabel).toBe('Add box');
    expect(manager.redoLabel).toBeNull();

    manager.undo();
    expect(manager.undoLabel).toBeNull();
    expect(manager.redoLabel).toBe('Add box');

    manager.redo();
    expect(manager.undoLabel).toBe('Add box');
    expect(manager.redoLabel).toBeNull();
  });
});
