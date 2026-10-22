import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  setParameter
} from '@openzcad/document-core';
import { toSketchId, toUserId } from '@openzcad/shared';
import {
  retainSketchGeometryCommands,
  sketchUsesProjectionGeometry
} from './releaseGeometry';

function fixture() {
  const added = addSketchFeature(
    createProjectDocument('Release view', toUserId('user_release')),
    {
      name: 'Outline',
      plane: 'XY',
      objects: [
        {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: '20',
          y2: 0,
          construction: true
        },
        { objectKind: 'circle', centerX: 0, centerY: 4, radius: '2' }
      ]
    }
  );
  const manager = new CommandManager(added.document);
  const lineId = findSketch(manager.document, added.sketchId)!.objectIds[0]!;
  manager.execute(
    commandFactories.addSketchConstraint({
      sketchId: added.sketchId,
      constraint: { constraintKind: 'horizontal', objectId: lineId }
    })
  );
  const sketch = findSketch(manager.document, added.sketchId)!;
  const authored = manager.document.nodes[lineId];
  if (authored?.kind !== 'sketch-object') throw new Error('Expected line.');
  manager.document.derived.sketchGeometry = {
    projectId: manager.document.projectId,
    documentVersion: manager.document.version,
    objects: {
      [lineId]: {
        ...authored.data,
        objectKind: 'line',
        x1: 0,
        y1: 0,
        x2: 32,
        y2: 0
      }
    }
  };
  return { manager, sketch, lineId, circleId: sketch.objectIds[1]! };
}

describe('retaining geometry when releasing sketch drivers', () => {
  it('requires current geometry only for sketches covered by a current or stale channel', () => {
    const f = fixture();
    expect(
      sketchUsesProjectionGeometry(f.manager.document, f.sketch.sketchId)
    ).toBe(true);
    f.manager.document.version += 1;
    expect(
      sketchUsesProjectionGeometry(f.manager.document, f.sketch.sketchId)
    ).toBe(true);
    const unrelated = addSketchFeature(f.manager.document, {
      name: 'Unrelated',
      plane: 'XY',
      object: { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 }
    });
    expect(
      sketchUsesProjectionGeometry(unrelated.document, unrelated.sketchId)
    ).toBe(false);
    expect(
      sketchUsesProjectionGeometry(unrelated.document, f.sketch.sketchId)
    ).toBe(true);
  });

  it('retains typed expressions in fields unchanged within existing solve application precision', () => {
    const added = addSketchFeature(
      setParameter(
        createProjectDocument('Typed release', toUserId('user_typed_release')),
        { name: 'h', expression: '0.4 cm', quantity: 'length' }
      ),
      {
        name: 'Outline',
        plane: 'XY',
        objects: [
          { objectKind: 'line', x1: 0, y1: 'h', x2: '2 cm', y2: '4 mm' }
        ]
      }
    );
    const id = findSketch(added.document, added.sketchId)!.objectIds[0]!;
    added.document.derived.sketchGeometry = {
      projectId: added.document.projectId,
      documentVersion: added.document.version,
      objects: {
        [id]: {
          objectKind: 'line',
          x1: 0,
          y1: 4.0000000000059135,
          x2: 32,
          y2: 4.0000000000059135
        }
      }
    };
    const [command] = retainSketchGeometryCommands(
      added.document,
      added.sketchId
    );
    expect(command?.payload).toMatchObject({
      data: { x1: 0, y1: 'h', x2: 32, y2: '4 mm' }
    });
    expect(added.document.nodes[id]).toMatchObject({
      data: { x2: '2 cm', y1: 'h', y2: '4 mm' }
    });
  });

  it('retains only moved geometry in the same undo step as removing a relation', () => {
    const f = fixture();
    const base = f.manager.document;
    const before = structuredClone(base);
    const prefix = retainSketchGeometryCommands(base, f.sketch.sketchId);
    expect(prefix).toHaveLength(1);
    expect(base).toEqual(before);
    const constraintId = f.sketch.constraints![0]!.constraintId;
    f.manager.runTransaction('Release relation', [
      ...prefix,
      commandFactories.deleteSketchConstraint({
        sketchId: f.sketch.sketchId,
        constraintId
      })
    ]);
    expect(f.manager.document.nodes[f.lineId]).toMatchObject({
      data: { x2: 32, construction: true }
    });
    expect(f.manager.document.nodes[f.circleId]).toMatchObject({
      data: { radius: '2' }
    });
    expect(
      findSketch(f.manager.document, f.sketch.sketchId)!.constraints
    ).toHaveLength(0);
    expect(f.manager.document.editHistory!.cursor).toBe(
      base.editHistory!.cursor + 1
    );
    f.manager.undo();
    expect(f.manager.document.nodes[f.lineId]).toMatchObject({
      data: { x2: '20' }
    });
    expect(
      findSketch(f.manager.document, f.sketch.sketchId)!.constraints
    ).toHaveLength(1);
    f.manager.redo();
    expect(f.manager.document.nodes[f.lineId]).toMatchObject({
      data: { x2: 32 }
    });
  });

  it('ignores excluded objects, stale results, foreign projects and other sketches', () => {
    const f = fixture();
    expect(
      retainSketchGeometryCommands(f.manager.document, f.sketch.sketchId, [
        f.lineId
      ])
    ).toEqual([]);
    expect(
      retainSketchGeometryCommands(
        f.manager.document,
        toSketchId('sketch_missing')
      )
    ).toEqual([]);
    f.manager.document.version += 1;
    expect(
      retainSketchGeometryCommands(f.manager.document, f.sketch.sketchId)
    ).toEqual([]);
    f.manager.document.version -= 1;
    f.manager.document.derived.sketchGeometry = {
      ...f.manager.document.derived.sketchGeometry!,
      projectId: createProjectDocument('Other', toUserId('user_other'))
        .projectId
    };
    expect(
      retainSketchGeometryCommands(f.manager.document, f.sketch.sketchId)
    ).toEqual([]);
  });

  it('does not partially seed the document when the release transaction fails', () => {
    const f = fixture();
    const base = f.manager.document;
    const before = structuredClone(base);
    expect(() =>
      f.manager.runTransaction('Refused release', [
        ...retainSketchGeometryCommands(base, f.sketch.sketchId),
        commandFactories.deleteSketchObject({
          sketchId: toSketchId('sketch_missing'),
          objectId: f.lineId
        })
      ])
    ).toThrow('not found');
    expect(f.manager.document).toBe(base);
    expect(f.manager.document).toEqual(before);
  });
});
