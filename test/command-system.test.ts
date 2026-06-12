import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories, replayCommands } from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId,
  getLatestSketchId
} from '@openzcad/document-core';
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

  it('replays a command log into an identical entity graph', () => {
    const base = createProjectDocument('Replay Test', toUserId('user_test'));
    const manager = new CommandManager(base);

    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        objectKind: 'rectangle',
        rectangle: { width: 32, height: 18 }
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    manager.execute(
      commandFactories.extrudeSketch({ name: 'Extrude', sketchId, distance: 24 })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: bodyId,
        translation: { x: 5, y: 0, z: 0 }
      })
    );

    // Commands never mutate their input, so `base` is still the pristine
    // initial document and can serve as the replay starting point.
    const replayed = replayCommands(base, manager.document.commandLog);

    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(replayed.sketchOrder).toEqual(manager.document.sketchOrder);
    expect(Object.keys(replayed.nodes).sort()).toEqual(
      Object.keys(manager.document.nodes).sort()
    );

    const kernel = createMockKernelAdapter();
    const fromLive = kernel.syncDocument(manager.document);
    const fromReplay = kernel.syncDocument(replayed);
    expect(fromReplay.warnings).toEqual([]);
    expect(fromReplay.bodyRepresentations[bodyId]?.transform.translation).toEqual({
      x: 5,
      y: 0,
      z: 0
    });
    expect(Object.keys(fromReplay.bodyRepresentations)).toEqual(
      Object.keys(fromLive.bodyRepresentations)
    );
  });

  it('clears the redo stack when a new command is executed after undo', () => {
    const manager = new CommandManager(
      createProjectDocument('History Test', toUserId('user_test'))
    );
    const box = (name: string) =>
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });

    manager.execute(box('A'));
    manager.execute(box('B'));
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(1);

    manager.execute(box('C'));
    const afterC = manager.document;
    manager.redo();
    expect(manager.document).toBe(afterC);
  });

  it('records transactions as a single undoable step', () => {
    const manager = new CommandManager(
      createProjectDocument('Txn Test', toUserId('user_test'))
    );
    manager.runTransaction('Two boxes', [
      commandFactories.addPrimitive({
        name: 'A',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      }),
      commandFactories.addPrimitive({
        name: 'B',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      })
    ]);
    expect(manager.document.bodyOrder).toHaveLength(2);
    expect(manager.document.commandLog).toHaveLength(2);

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
  });
});

