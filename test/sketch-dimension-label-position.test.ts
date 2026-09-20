import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

describe('saved sketch dimension label placement', () => {
  it('is additive, undoable, redoable, and replayable without changing the driving value', () => {
    const root = createProjectDocument(
      'Dimension placement',
      toUserId('user_test')
    );
    const added = addSketchFeature(root, {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }]
    });
    const objectId = findSketch(added.document, added.sketchId)!.objectIds[0]!;
    const manager = new CommandManager(added.document);
    manager.execute(
      commandFactories.addSketchConstraint({
        sketchId: added.sketchId,
        constraint: {
          constraintKind: 'distance',
          a: { objectId, point: 'start' },
          b: { objectId, point: 'end' },
          value: 'width'
        }
      })
    );
    const constraint = findSketch(manager.document, added.sketchId)!
      .constraints![0]!;
    const before = findSketch(manager.document, added.sketchId)!
      .constraints![0]!;

    manager.execute(
      commandFactories.setSketchDimensionLabelPosition({
        sketchId: added.sketchId,
        constraintId: constraint.constraintId,
        position: { x: 2.5, y: -1.25 }
      })
    );
    expect(
      findSketch(manager.document, added.sketchId)!.dimensionLabelPositions
    ).toEqual({ [String(constraint.constraintId)]: { x: 2.5, y: -1.25 } });
    expect(
      findSketch(manager.document, added.sketchId)!.constraints![0]
    ).toEqual(before);

    const replaced = commandFactories
      .addSketchConstraint(
        {
          sketchId: added.sketchId,
          constraint: {
            constraintKind: 'distance',
            a: { objectId, point: 'start' },
            b: { objectId, point: 'end' },
            value: 6
          },
          ids: { constraintId: constraint.constraintId }
        },
        'Replace distance dimension'
      )
      .apply(
        commandFactories
          .deleteSketchConstraint({
            sketchId: added.sketchId,
            constraintId: constraint.constraintId
          })
          .apply(manager.document)
      );
    expect(
      findSketch(replaced, added.sketchId)!.dimensionLabelPositions
    ).toEqual({ [String(constraint.constraintId)]: { x: 2.5, y: -1.25 } });

    const replayed = replayCommands(
      added.document,
      manager.document.commandLog
    );
    expect(
      findSketch(replayed, added.sketchId)!.dimensionLabelPositions
    ).toEqual(
      findSketch(manager.document, added.sketchId)!.dimensionLabelPositions
    );
    expect(findSketch(replayed, added.sketchId)!.constraints![0]).toEqual(
      before
    );

    manager.undo();
    expect(
      findSketch(manager.document, added.sketchId)!.dimensionLabelPositions
    ).toBeUndefined();
    manager.redo();
    expect(
      findSketch(manager.document, added.sketchId)!.dimensionLabelPositions
    ).toEqual({ [String(constraint.constraintId)]: { x: 2.5, y: -1.25 } });
  });
});
