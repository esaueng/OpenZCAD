import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId,
  getLatestSketchId,
  getParameterScope
} from '@openzcad/document-core';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import { toUserId, type FeatureNode } from '@openzcad/shared';

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

    const kernel = createKernelAdapter();
    const derived = kernel.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
  });

  it('replays a full parametric command log into an identical entity graph', () => {
    const base = createProjectDocument('Replay Test', toUserId('user_test'));
    const manager = new CommandManager(base);

    manager.execute(
      commandFactories.setParameter({ name: 'depth', expression: '24' })
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        offset: 0,
        object: {
          objectKind: 'rectangle',
          width: 32,
          height: 18,
          centerX: 0,
          centerY: 0
        }
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Extrude',
        sketchId,
        distance: 'depth'
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: bodyId,
        translation: { x: 5, y: 0, z: 0 }
      })
    );
    const extrudeFeature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'extrude'
    )!;
    manager.execute(
      commandFactories.updateFeature(
        {
          featureId: extrudeFeature.featureId,
          data: { featureKind: 'extrude', sketchId, distance: 'depth / 2' }
        },
        'Halve depth'
      )
    );

    // Commands never mutate their input, so `base` is still the pristine
    // initial document and can serve as the replay starting point.
    const replayed = replayCommands(base, manager.document.commandLog);

    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(replayed.sketchOrder).toEqual(manager.document.sketchOrder);
    expect(replayed.parameterOrder).toEqual(manager.document.parameterOrder);
    expect(Object.keys(replayed.nodes).sort()).toEqual(
      Object.keys(manager.document.nodes).sort()
    );
    expect(getParameterScope(replayed).scope).toEqual({ depth: 24 });

    const kernel = createKernelAdapter();
    const fromLive = kernel.syncDocument(manager.document);
    const fromReplay = kernel.syncDocument(replayed);
    expect(fromReplay.warnings).toEqual([]);
    const live = fromLive.bodyRepresentations[bodyId]!;
    const replay = fromReplay.bodyRepresentations[bodyId]!;
    expect(replay.volume).toBeCloseTo(live.volume, 6);
    expect(replay.volume).toBeCloseTo(32 * 18 * 12, 4);
    expect(replay.bbox).toEqual(live.bbox);
    // The transform is baked into geometry on both paths.
    expect(replay.bbox.min.x).toBeCloseTo(5 - 16, 6);
  });

  it('replays deletions', () => {
    const base = createProjectDocument('Delete Replay', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const feature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode => node.kind === 'feature'
    )!;
    manager.execute(
      commandFactories.deleteFeature({ featureId: feature.featureId })
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.bodyOrder).toHaveLength(0);
    expect(replayed.featureOrder).toHaveLength(0);
  });

  it('replays embedded editable STEP imports without losing source data', () => {
    const base = createProjectDocument('STEP Replay', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported',
        artifactId: 'artifact_step',
        sourceName: 'part.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      })
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    const feature = Object.values(replayed.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'imported-step'
    );
    expect(feature?.data.featureKind).toBe('imported-step');
    if (feature?.data.featureKind === 'imported-step') {
      expect(feature.data.stepText).toContain('ISO-10303-21');
    }
  });

  it('validates command preconditions before applying', () => {
    const manager = new CommandManager(
      createProjectDocument('Validate Test', toUserId('user_test'))
    );
    expect(() =>
      manager.execute(
        commandFactories.booleanBodies({
          name: 'Bad union',
          operation: 'union',
          targetBodyIds: manager.document.bodyOrder
        })
      )
    ).toThrow();
    expect(manager.document.commandLog).toHaveLength(0);
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

  it('turns a reviewed AI patch into normal undoable commands', () => {
    const manager = new CommandManager(
      createProjectDocument('AI Patch', toUserId('user_test'))
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_1',
      summary: 'Add a driven mounting block.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'width', expression: '80' },
        {
          kind: 'add_primitive',
          name: 'Mounting block',
          primitiveKind: 'box',
          dimensions: {
            width: 'width',
            height: 20,
            depth: 8,
            radius: null,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        }
      ]
    });

    manager.runTransaction('Apply AI patch', commands);
    expect(manager.document.parameterOrder).toHaveLength(1);
    expect(manager.document.bodyOrder).toHaveLength(1);
    manager.undo();
    expect(manager.document.parameterOrder).toHaveLength(0);
    expect(manager.document.bodyOrder).toHaveLength(0);
  });

  it('converts advanced AI operations into replayable feature commands', () => {
    const manager = new CommandManager(
      createProjectDocument('Advanced AI Patch', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Seed',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_advanced',
      summary: 'Move and repeat the seed.',
      assumptions: [],
      operations: [
        {
          kind: 'add_transform',
          name: 'Move seed',
          targetBodyId: bodyId,
          translation: { x: 5, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        },
        {
          kind: 'add_pattern',
          name: 'Seed pattern',
          targetBodyId: bodyId,
          patternKind: 'linear',
          count: 3,
          axis: 'x',
          spacing: 20,
          angleDeg: 360
        }
      ]
    });

    manager.runTransaction('Apply advanced AI patch', commands);
    expect(manager.document.commandLog.at(-2)?.kind).toBe('feature.transform');
    expect(manager.document.commandLog.at(-1)?.kind).toBe('feature.pattern');
    expect(manager.document.featureOrder).toHaveLength(3);
  });
});
