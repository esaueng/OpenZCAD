import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  isFeatureSuppressed,
  toUserId
} from '@openzcad/shared';

function addBox(name: string) {
  return commandFactories.addPrimitive({
    name,
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
}

function names(manager: CommandManager): string[] {
  return listFeaturesInOrder(manager.document).map((feature) => feature.name);
}

/** A, B, C with the marker rolled back to just after A. */
function rolledBack() {
  const base = createProjectDocument('Rollback insert', toUserId('user_rb'));
  const manager = new CommandManager(base);
  for (const name of ['A', 'B', 'C']) manager.execute(addBox(name));
  const paused = listFeaturesInOrder(manager.document).slice(1);
  manager.runTransaction(
    'Roll back to A',
    paused.map((feature) =>
      commandFactories.setNodeMetadata({
        nodeId: feature.id,
        metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
      })
    )
  );
  return { base, manager };
}

describe('adding a feature while History is rolled back', () => {
  it('lands at the rollback marker, ahead of the paused tail', () => {
    const { manager } = rolledBack();
    manager.execute(addBox('New'));
    expect(names(manager)).toEqual(['A', 'New', 'B', 'C']);
    const [, added, ...tail] = listFeaturesInOrder(manager.document);
    expect(isFeatureSuppressed(added!)).toBe(false);
    expect(tail.every(isFeatureSuppressed)).toBe(true);
  });

  it('places every feature a transaction adds, in order', () => {
    const { manager } = rolledBack();
    manager.runTransaction('Two boxes', [addBox('N1'), addBox('N2')]);
    expect(names(manager)).toEqual(['A', 'N1', 'N2', 'B', 'C']);
  });

  it('is one undo step and replays to the same order', () => {
    const { base, manager } = rolledBack();
    manager.execute(addBox('New'));
    expect(manager.undoLabel).toBe('Add box');
    manager.undo();
    expect(names(manager)).toEqual(['A', 'B', 'C']);
    manager.redo();
    expect(names(manager)).toEqual(['A', 'New', 'B', 'C']);
    const replayed = replayCommands(base, manager.document.commandLog);
    expect(listFeaturesInOrder(replayed).map((f) => f.name)).toEqual([
      'A',
      'New',
      'B',
      'C'
    ]);
  });

  it('appends as before when nothing is rolled back', () => {
    const base = createProjectDocument('No rollback', toUserId('user_rb'));
    const manager = new CommandManager(base);
    for (const name of ['A', 'B']) manager.execute(addBox(name));
    manager.execute(addBox('New'));
    expect(names(manager)).toEqual(['A', 'B', 'New']);
  });
});
