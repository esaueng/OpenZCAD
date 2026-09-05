import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import { buildConstraint } from '../apps/web/src/lib/sketch/constraints';
import { solvedSketchCommands } from '../apps/web/src/lib/sketch/applySolve';

function fixture(kind: 'circle' | 'arc') {
  const manager = new CommandManager(
    createProjectDocument('Radius', toUserId('user_radius'))
  );
  const object: SketchObjectData =
    kind === 'circle'
      ? { objectKind: kind, centerX: 12, centerY: 8, radius: 3 }
      : {
          objectKind: kind,
          centerX: 12,
          centerY: 8,
          radius: 3,
          startAngleDeg: 300,
          endAngleDeg: 60
        };
  manager.execute(
    commandFactories.addSketch({
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [object]
    })
  );
  manager.execute(
    commandFactories.setParameter({ name: 'wall_r', expression: '7' })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const sketch = findSketch(manager.document, sketchId)!;
  const objectId = sketch.objectIds[0]!;
  const pin = buildConstraint(manager.document, sketch, 'radius', [
    { kind: 'object', objectId }
  ]);
  if ('error' in pin) throw new Error(pin.error);
  manager.execute(
    commandFactories.addSketchConstraint({ sketchId, constraint: pin.data })
  );
  return { manager, sketchId, objectId };
}

describe('editable radius constraints', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => {
    adapter.dispose();
  });

  it.each(['circle', 'arc'] as const)(
    'solves an expression-driven %s radius in one undoable transaction',
    async (kind) => {
      const { manager, sketchId, objectId } = fixture(kind);
      const before = manager.document;
      const sketch = findSketch(before, sketchId)!;
      const existing = sketch.constraints![0]!;
      expect(existing.data).toMatchObject({
        constraintKind: 'radius',
        value: 3
      });
      const edited = buildConstraint(
        before,
        sketch,
        'radius',
        [{ kind: 'object', objectId }],
        'wall_r'
      );
      if ('error' in edited) throw new Error(edited.error);
      const commands = [
        commandFactories.deleteSketchConstraint({
          sketchId,
          constraintId: existing.constraintId
        }),
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: edited.data,
          ids: { constraintId: existing.constraintId }
        })
      ];
      let prospective = before;
      for (const command of commands) {
        command.validate(prospective);
        prospective = command.apply(prospective);
      }
      const outcome = await adapter.solveSketch(prospective, sketchId);
      expect(outcome.converged).toBe(true);
      expect(outcome.rolledBack).toBe(false);
      manager.runTransaction('Edit radius dimension', [
        ...commands,
        ...solvedSketchCommands(prospective, sketchId, outcome)
      ]);
      const after = manager.document;
      expect(findSketch(after, sketchId)!.constraints).toEqual([
        {
          constraintId: existing.constraintId,
          data: { constraintKind: 'radius', objectId, value: 'wall_r' }
        }
      ]);
      const solved = after.nodes[objectId];
      if (
        solved?.kind !== 'sketch-object' ||
        (solved.data.objectKind !== 'circle' &&
          solved.data.objectKind !== 'arc')
      )
        throw new Error('Expected radial object');
      expect(Number(solved.data.radius)).toBeCloseTo(7, 9);
      manager.undo();
      expect(manager.document.nodes).toEqual(before.nodes);
      manager.redo();
      expect(manager.document.nodes).toEqual(after.nodes);
    }
  );

  it('refuses contradictory radii without changing the input document', async () => {
    const { manager, sketchId, objectId } = fixture('circle');
    manager.execute(
      commandFactories.addSketchConstraint({
        sketchId,
        constraint: { constraintKind: 'radius', objectId, value: 7 }
      })
    );
    const snapshot = JSON.stringify(manager.document);
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.classification).toBe('unsatisfied');
    expect(outcome.converged).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.constraintResiduals).toHaveLength(2);
    expect(JSON.stringify(manager.document)).toBe(snapshot);
  });

  it.each([0, -2])(
    'rejects the invalid radius %s when applying the command',
    (value) => {
      const { manager, sketchId, objectId } = fixture('circle');
      const sketch = findSketch(manager.document, sketchId)!;
      const edited = buildConstraint(
        manager.document,
        sketch,
        'radius',
        [{ kind: 'object', objectId }],
        value
      );
      if ('error' in edited) throw new Error(edited.error);
      expect(() =>
        commandFactories
          .addSketchConstraint({ sketchId, constraint: edited.data })
          .apply(manager.document)
      ).toThrow(/Radius must be a positive number/);
    }
  );
});
