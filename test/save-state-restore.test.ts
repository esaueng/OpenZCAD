import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  restoreFromSaveState
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

const user = () => toUserId('user_test');

/**
 * The restore gesture as `App` performs it: checkpoint what is being left,
 * then adopt the save state as one undoable document edit.
 */
function restore(
  manager: CommandManager,
  snapshot: ProjectDocument,
  reason: string
): { guarded: ProjectDocument; restored: ProjectDocument } {
  const guarded = createCheckpoint(
    appendRevision(manager.document, 'Before restore'),
    'Before restore'
  );
  const restored = createCheckpoint(
    restoreFromSaveState(guarded, snapshot, reason),
    reason
  );
  manager.applyDocumentEdit(restored, reason);
  return { guarded, restored };
}

describe('restoring a save state through the command manager', () => {
  function managerWithSavedBox() {
    const manager = new CommandManager(
      createProjectDocument('Bracket', user())
    );
    const saved = manager.document;
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    return { manager, saved };
  }

  it('takes one Undo to put back', () => {
    const { manager, saved } = managerWithSavedBox();
    expect(manager.document.bodyOrder).toHaveLength(1);

    restore(manager, saved, 'Restored “First save”');
    expect(manager.document.bodyOrder).toHaveLength(0);

    manager.undo();
    // Back to the model that was on screen, in a single step — a restore the
    // user cannot walk out of is a data-loss feature.
    expect(manager.document.bodyOrder).toHaveLength(1);
  });

  it('leaves the way back on the timeline, past the undo stack', () => {
    const { manager, saved } = managerWithSavedBox();
    const before = manager.document;

    const { restored } = restore(manager, saved, 'Restored “First save”');

    // The pre-restore model is a save point of its own, so it survives a
    // reload — where the undo stack, which lives only in memory, does not.
    const guardCheckpoint = restored.checkpoints.at(-2);
    expect(guardCheckpoint?.reason).toBe('Before restore');
    expect(guardCheckpoint?.documentVersion).toBe(before.version + 1);
    expect(restored.checkpoints.at(-1)?.reason).toBe('Restored “First save”');
  });

  it('redoes the restore after undoing it', () => {
    const { manager, saved } = managerWithSavedBox();
    restore(manager, saved, 'Restored “First save”');
    manager.undo();

    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(0);
  });

  it('never rewinds the version, at any point in the gesture', () => {
    const { manager, saved } = managerWithSavedBox();
    const versions = [manager.document.version];

    restore(manager, saved, 'Restored “First save”');
    versions.push(manager.document.version);
    manager.undo();
    versions.push(manager.document.version);
    manager.redo();
    versions.push(manager.document.version);

    // Collaboration reads `version` as a room clock and every fenced cloud
    // write compares against it, so it may only ever climb — including across
    // an undone and redone restore.
    const climbing = versions.every(
      (version, index) => index === 0 || version > versions[index - 1]!
    );
    expect(climbing).toBe(true);
  });

  it('keeps the restore out of the replayable command log', () => {
    const { manager, saved } = managerWithSavedBox();
    const logLength = manager.document.commandLog.length;

    restore(manager, saved, 'Restored “First save”');

    // The restored document brings the save state's own log with it. What must
    // not happen is an extra entry carrying a whole document, which every
    // future replay would then have to drag along.
    expect(manager.document.commandLog).toEqual(saved.commandLog);
    expect(manager.document.commandLog.length).toBeLessThan(logLength);
  });

  it('undoes an edit made after a restore without undoing the restore', () => {
    const { manager, saved } = managerWithSavedBox();
    restore(manager, saved, 'Restored “First save”');

    manager.execute(
      commandFactories.addPrimitive({
        name: 'Sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: 4 }
      })
    );
    expect(manager.document.bodyOrder).toHaveLength(1);

    manager.undo();
    // One step back is the sphere, not the restore behind it.
    expect(manager.document.bodyOrder).toHaveLength(0);
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(1);
  });
});
