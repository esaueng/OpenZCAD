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
import {
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

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
    const executedVersion = manager.document.version;
    const executedRevisionCount = manager.document.revisions.length;

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    expect(manager.document.version).toBeGreaterThan(executedVersion);
    expect(manager.document.revisions).toHaveLength(executedRevisionCount + 1);
    expect(manager.document.revisions.at(-1)?.reason).toBe('Undo Add box');
    const undoneVersion = manager.document.version;

    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(1);
    expect(manager.document.version).toBeGreaterThan(undoneVersion);
    expect(manager.document.revisions).toHaveLength(executedRevisionCount + 2);
    expect(manager.document.revisions.at(-1)?.reason).toBe('Redo Add box');

    const kernel = createKernelAdapter();
    const derived = kernel.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
  });

  it('renames the project through replayable undoable document history', () => {
    const base = createProjectDocument('Original Name', toUserId('user_test'));
    const manager = new CommandManager(base);

    manager.execute(
      commandFactories.renameNode({
        nodeId: base.rootNodeId,
        name: 'Renamed Part'
      })
    );

    expect(manager.document.name).toBe('Renamed Part');
    expect(manager.document.nodes[base.rootNodeId]?.name).toBe('Renamed Part');
    expect(replayCommands(base, manager.document.commandLog).name).toBe(
      'Renamed Part'
    );

    manager.undo();
    expect(manager.document.name).toBe('Original Name');
    manager.redo();
    expect(manager.document.name).toBe('Renamed Part');
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
    expect(manager.document.revisions.at(-1)?.reason).toBe('Undo Two boxes');
  });

  it('preserves durable checkpoints while undoing model history', () => {
    const manager = new CommandManager(
      createProjectDocument('Checkpoint Test', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    manager.document = {
      ...manager.document,
      checkpoints: [
        ...manager.document.checkpoints,
        {
          checkpointId: 'checkpoint_manual',
          revisionId: manager.document.revisions.at(-1)!.revisionId,
          documentVersion: manager.document.version,
          createdAt: new Date().toISOString(),
          reason: 'Manual save'
        }
      ]
    };

    manager.undo();

    expect(manager.document.checkpoints.at(-1)?.reason).toBe('Manual save');
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

  it('builds a hollow part from bodies created inside the same patch', () => {
    const manager = new CommandManager(
      createProjectDocument('Hollow Box', toUserId('user_test'))
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_hollow',
      summary: 'Hollow the box.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'wall', expression: '2.4' },
        {
          kind: 'add_primitive',
          name: 'Box Outer',
          localId: 'box_outer',
          primitiveKind: 'box',
          dimensions: {
            width: 120,
            height: 80,
            depth: 60,
            radius: null,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        },
        {
          kind: 'add_primitive',
          name: 'Box Cavity',
          localId: 'box_cavity',
          primitiveKind: 'box',
          dimensions: {
            width: '120 - 2*wall',
            height: '80 - 2*wall',
            depth: '60 - wall',
            radius: null,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        },
        {
          kind: 'add_transform',
          name: 'Position Box Cavity',
          targetBodyId: '$box_cavity',
          translation: { x: 'wall', y: 'wall', z: 'wall' },
          rotationDeg: { x: 0, y: 0, z: 0 }
        },
        {
          kind: 'add_boolean',
          name: 'Box',
          localId: 'box',
          operation: 'subtract',
          targetBodyIds: ['$box_outer', '$box_cavity']
        }
      ]
    });

    manager.runTransaction('Apply hollow patch', commands);

    // The boolean must target the two bodies the patch itself created.
    const booleanCommand = manager.document.commandLog.at(-1);
    expect(booleanCommand?.kind).toBe('feature.boolean');
    const payload = booleanCommand?.payload as {
      targetBodyIds: string[];
    };
    const createdBodies = manager.document.bodyOrder;
    expect(payload.targetBodyIds).toEqual([createdBodies[0], createdBodies[1]]);
    // Aliases are an AI-only concept and must never reach the command log.
    expect(JSON.stringify(manager.document.commandLog)).not.toContain('$');
    expect(manager.document.bodyOrder).toHaveLength(3);

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
  });

  it('rejects a patch that references a body it never creates', () => {
    const manager = new CommandManager(
      createProjectDocument('Dangling', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_dangling',
        summary: 'Move a body that does not exist.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move ghost',
            targetBodyId: '$ghost',
            translation: { x: 1, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/no earlier operation creates that body/);
  });

  it('rejects re-targeting a body a boolean already consumed', () => {
    const manager = new CommandManager(
      createProjectDocument('Consumed', toUserId('user_test'))
    );
    const box = (name: string, localId: string) =>
      ({
        kind: 'add_primitive',
        name,
        localId,
        primitiveKind: 'box',
        dimensions: {
          width: 10,
          height: 10,
          depth: 10,
          radius: null,
          bottomRadius: null,
          topRadius: null,
          majorRadius: null,
          minorRadius: null
        }
      }) as const;

    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_consumed',
        summary: 'Reuse a consumed body.',
        assumptions: [],
        operations: [
          box('A', 'a'),
          box('B', 'b'),
          {
            kind: 'add_boolean',
            name: 'Merged',
            localId: 'merged',
            operation: 'subtract',
            targetBodyIds: ['$a', '$b']
          },
          {
            kind: 'add_transform',
            name: 'Move consumed tool',
            targetBodyId: '$b',
            translation: { x: 5, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/already consumed/);
  });

  it('accepts an expression that is only valid at the real parameter values', () => {
    const manager = new CommandManager(
      createProjectDocument('Real Values', toUserId('user_test'))
    );
    // hole_count - 1 divides by zero under any placeholder of 1, so this is
    // only checkable against the values the patch actually produces.
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_pitch',
      summary: 'Space the holes evenly.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'total_len', expression: '120' },
        { kind: 'set_parameter', name: 'hole_count', expression: '4' },
        {
          kind: 'set_parameter',
          name: 'pitch',
          expression: 'total_len / (hole_count - 1)'
        }
      ]
    });
    manager.runTransaction('Apply pitch', commands);
    expect(getParameterScope(manager.document).scope.pitch).toBeCloseTo(40);
  });

  it('rejects an expression that cannot produce a finite number', () => {
    const manager = new CommandManager(
      createProjectDocument('Divide By Zero', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_infinite',
        summary: 'Divide by zero.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter', name: 'wall', expression: '0' },
          {
            kind: 'add_primitive',
            name: 'Bad',
            localId: null,
            primitiveKind: 'box',
            dimensions: {
              width: '10 / wall',
              height: 10,
              depth: 10,
              radius: null,
              bottomRadius: null,
              topRadius: null,
              majorRadius: null,
              minorRadius: null
            }
          }
        ]
      })
    ).toThrow(/finite/);
  });

  it('rejects parameters that reference each other in a cycle', () => {
    const manager = new CommandManager(
      createProjectDocument('Cycle', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_cycle',
        summary: 'Define a cycle.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter', name: 'a', expression: 'b + 1' },
          { kind: 'set_parameter', name: 'b', expression: 'a + 1' }
        ]
      })
    ).toThrow(/depends on itself/);
  });

  it('rejects a parameter named after a built-in', () => {
    const manager = new CommandManager(
      createProjectDocument('Reserved', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_reserved',
        summary: 'Shadow a built-in.',
        assumptions: [],
        operations: [{ kind: 'set_parameter', name: 'pi', expression: '3' }]
      })
    ).toThrow(/not usable/);
  });

  it('rejects targeting a body an earlier turn already consumed', () => {
    const manager = new CommandManager(
      createProjectDocument('Earlier Turn', toUserId('user_test'))
    );
    const box = (name: string) =>
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    manager.execute(box('A'));
    manager.execute(box('B'));
    const [first, second] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Merged',
        operation: 'union',
        targetBodyIds: [first!, second!]
      })
    );
    // Mark the operands consumed the way a kernel sync would.
    const derived = {
      ...manager.document.derived,
      bodyRepresentations: Object.fromEntries(
        manager.document.bodyOrder.map((bodyId) => [
          bodyId,
          { consumed: bodyId !== manager.document.bodyOrder.at(-1) }
        ])
      )
    } as ProjectDocument['derived'];
    const document = { ...manager.document, derived };

    expect(() =>
      commandsForCadPatch(document, {
        proposalId: 'proposal_dead_body',
        summary: 'Move an absorbed body.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move absorbed',
            targetBodyId: first!,
            translation: { x: 5, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/already consumed/);
  });

  it('rejects a parameter expression the evaluator cannot read', () => {
    const manager = new CommandManager(
      createProjectDocument('Bad Expression', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_bad_expression',
        summary: 'Set a broken parameter.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter', name: 'wall', expression: '2 +' }
        ]
      })
    ).toThrow(/invalid expression/);
  });

  it('accepts parameters that reference each other in any order', () => {
    const manager = new CommandManager(
      createProjectDocument('Cross Params', toUserId('user_test'))
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_cross',
      summary: 'Derive the cavity from the shell.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'cavity_len', expression: 'box_len - 2*wall' },
        { kind: 'set_parameter', name: 'box_len', expression: '120' },
        { kind: 'set_parameter', name: 'wall', expression: '2.4' }
      ]
    });
    manager.runTransaction('Apply cross params', commands);
    expect(getParameterScope(manager.document).scope.cavity_len).toBeCloseTo(
      115.2
    );
  });
});
