import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder,
  transformBody,
  type TransformInput
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

function setup() {
  const base = createProjectDocument(
    'Finite Move',
    toUserId('user_move_refusal')
  );
  const manager = new CommandManager(base);
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 10 }
    })
  );
  const payload: TransformInput = {
    name: 'Move',
    targetBodyId: manager.document.bodyOrder[0]!,
    translation: { x: 5, y: 0, z: 0 }
  };
  return { base, manager, payload };
}

describe('non-finite Move refusal', () => {
  it.each([NaN, Infinity, -Infinity])(
    'refuses %s without changing the document or undo/redo history',
    (value) => {
      const { base, manager, payload } = setup();
      manager.execute(commandFactories.transformBody(payload));
      manager.undo();
      const before = manager.document;
      const saved = JSON.stringify(before);
      const undo = manager.undoLabel;
      const redo = manager.redoLabel;
      const invalid: TransformInput[] = [{ ...payload, scale: value }];
      for (const axis of ['x', 'y', 'z'] as const) {
        invalid.push({
          ...payload,
          translation: { ...payload.translation, [axis]: value }
        });
        invalid.push({
          ...payload,
          rotationDeg: { x: 0, y: 0, z: 0, [axis]: value }
        });
      }
      for (const input of invalid) {
        const command = commandFactories.transformBody(input);
        expect(() => manager.execute(command)).toThrow(/must be finite/);
        expect(() => transformBody(before, input)).toThrow(/must be finite/);
        expect(() =>
          replayCommands(base, [...before.commandLog, command.serialize()])
        ).toThrow(/must be finite/);
        expect(manager.document).toBe(before);
        expect(JSON.stringify(manager.document)).toBe(saved);
        expect(manager.undoLabel).toBe(undo);
        expect(manager.redoLabel).toBe(redo);
      }
      manager.redo();
      expect(listFeaturesInOrder(manager.document)).toHaveLength(2);
    }
  );

  it('keeps finite and expression-valued transforms replayable', () => {
    const { base, manager, payload } = setup();
    manager.execute(
      commandFactories.transformBody({
        ...payload,
        translation: { x: 'move_x', y: -5, z: 0 },
        rotationDeg: { x: 0, y: 'angle', z: 30 },
        scale: 'scale'
      })
    );
    const saved = JSON.parse(
      JSON.stringify(manager.document.commandLog)
    ) as ProjectDocument['commandLog'];
    expect(replayCommands(base, saved).nodes).toEqual(manager.document.nodes);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(2);
  });
});
