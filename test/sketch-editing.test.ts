import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  checkSketchEdit,
  sketchEntityEditCommands
} from '../apps/web/src/lib/sketch/editing';
import { affectedFeatureTargets } from '../apps/web/src/lib/affectedFeatureTargets';
import { buildConstraint } from '../apps/web/src/lib/sketch/constraints';

function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Sketch editing', toUserId('user_test'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const objectId = findSketch(manager.document, sketchId)!.objectIds[0]!;
  return { manager, sketchId, objectId };
}

describe('predictable sketch edits', () => {
  let kernel: ExactKernelAdapter;
  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });
  afterAll(() => kernel.dispose());

  it('checks a sketch-dependent solid and changes its exact volume in one undoable edit', async () => {
    const { manager, sketchId, objectId } = fixture();
    manager.execute(
      commandFactories.extrudeSketch({ name: 'Plate', sketchId, distance: 4 })
    );
    const base = manager.document;
    const source = listFeaturesInOrder(base)[0]!;
    expect(
      affectedFeatureTargets(base, source.featureId).map(
        (target) => target.featureName
      )
    ).toEqual(['Plate']);
    const commands = await sketchEntityEditCommands(
      base,
      sketchId,
      objectId,
      { objectKind: 'circle', radius: 7, centerX: 0, centerY: 0 },
      (doc, id) => kernel.solveSketch(doc, id)
    );
    const derived = await checkSketchEdit(base, sketchId, commands, (doc) =>
      kernel.syncDocument(doc)
    );
    expect(derived?.warnings).toEqual([]);
    const body = derived!.bodyRepresentations[base.bodyOrder[0]!]!;
    expect(body.volume).toBeCloseTo(Math.PI * 49 * 4, 5);
    manager.runTransaction('Resize profile', commands);
    manager.undo();
    expect(manager.document.nodes[objectId]).toEqual(base.nodes[objectId]);
  });

  it('refuses an edit that removes the profile required by a downstream solid', async () => {
    const { manager, sketchId, objectId } = fixture();
    manager.execute(
      commandFactories.extrudeSketch({ name: 'Plate', sketchId, distance: 4 })
    );
    const base = manager.document;
    const commands = [
      commandFactories.deleteSketchObject({ sketchId, objectId })
    ];
    await expect(
      checkSketchEdit(base, sketchId, commands, (doc) =>
        kernel.syncDocument(doc)
      )
    ).rejects.toThrow(/Plate.*not saved/s);
    expect(manager.document).toBe(base);
  });

  it('explains a driving constraint instead of silently discarding a typed radius', async () => {
    const { manager, sketchId, objectId } = fixture();
    const constraint = buildConstraint(
      manager.document,
      findSketch(manager.document, sketchId)!,
      'radius',
      [{ kind: 'object', objectId }]
    );
    if ('error' in constraint) throw new Error(constraint.error);
    manager.execute(
      commandFactories.addSketchConstraint({
        sketchId,
        constraint: constraint.data
      })
    );
    const base = manager.document;
    await expect(
      sketchEntityEditCommands(
        base,
        sketchId,
        objectId,
        { objectKind: 'circle', radius: 7, centerX: 0, centerY: 0 },
        (doc, id) => kernel.solveSketch(doc, id)
      )
    ).rejects.toThrow('A constraint controls a value you changed');
    expect(manager.document).toBe(base);
    const commands = await sketchEntityEditCommands(
      base,
      sketchId,
      objectId,
      { objectKind: 'circle', radius: 5, centerX: 10, centerY: 0 },
      (doc, id) => kernel.solveSketch(doc, id)
    );
    manager.runTransaction('Move constrained circle', commands);
    expect(manager.document.nodes[objectId]).toMatchObject({
      data: { radius: 5, centerX: 10 }
    });
  });
});
