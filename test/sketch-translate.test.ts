/**
 * Moving a whole sketch, as the move gizmo commits it.
 *
 * The contract: a translated axis bakes resolved numbers, a zero-delta axis
 * preserves stored expressions, canonical sketches may move along their
 * normal as a plane-offset change, and face-attached sketches must refuse
 * normal movement rather than silently dropping it.
 */
import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  setParameter,
  translateSketch
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { toUserId, type SketchObjectData } from '@openzcad/shared';

function sketchWith(objects: SketchObjectData[], offset: number | string = 0) {
  const base = setParameter(
    createProjectDocument('Move sketch', toUserId('user_sketch_move')),
    { name: 'w', expression: '30' }
  );
  return addSketchFeature(base, {
    name: 'Sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset },
    objects
  });
}

function objectsOf(document: ReturnType<typeof sketchWith>['document']) {
  const sketch = findSketch(
    document,
    document.sketchOrder.at(-1)!
  )!;
  return sketch.objectIds.map((id) => {
    const node = document.nodes[id]!;
    if (node.kind !== 'sketch-object') {
      throw new Error('not a sketch object');
    }
    return node.data;
  });
}

describe('translateSketch', () => {
  it('translates every object kind by the same in-plane delta', () => {
    const { document, sketchId } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'circle', radius: 5, centerX: 1, centerY: 2 },
      {
        objectKind: 'text',
        text: 'Hi',
        fontFamily: 'open-sans',
        fontStyle: 'regular',
        size: 10,
        x: 3,
        y: 4
      }
    ]);
    const moved = translateSketch(document, { sketchId, du: 7, dv: -2 });
    expect(objectsOf(moved)).toEqual([
      { objectKind: 'line', x1: 7, y1: -2, x2: 17, y2: -2 },
      { objectKind: 'circle', radius: 5, centerX: 8, centerY: 0 },
      {
        objectKind: 'text',
        text: 'Hi',
        fontFamily: 'open-sans',
        fontStyle: 'regular',
        size: 10,
        x: 10,
        y: 2
      }
    ]);
  });

  it('bakes expressions only on the axis that moved', () => {
    const { document, sketchId } = sketchWith([
      { objectKind: 'circle', radius: 5, centerX: 'w / 2', centerY: 'w / 3' }
    ]);
    const moved = translateSketch(document, { sketchId, du: 5, dv: 0 });
    // X moved: 30/2 + 5 baked. Y did not: the expression survives, so the
    // parametric relationship the user authored is not destroyed by a drag
    // that never touched it.
    expect(objectsOf(moved)[0]).toMatchObject({ centerX: 20, centerY: 'w / 3' });
  });

  it('moves a canonical sketch along its normal via the plane offset', () => {
    const { document, sketchId } = sketchWith(
      [{ objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }],
      2
    );
    const moved = translateSketch(document, { sketchId, du: 0, dv: 0, dn: 3 });
    const sketch = findSketch(moved, sketchId)!;
    expect(sketch.planeRef).toMatchObject({ type: 'canonical', offset: 5 });
    // In-plane coordinates are untouched by a pure normal move.
    expect(objectsOf(moved)[0]).toMatchObject({ centerX: 0, centerY: 0 });
  });

  it('refuses to move a face-attached sketch along its normal', () => {
    const base = createProjectDocument('Face', toUserId('user_face_move'));
    const { document, sketchId } = addSketchFeature(base, {
      name: 'Attached',
      planeRef: {
        type: 'frame',
        frame: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 }
        }
      },
      objects: [{ objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }]
    });
    expect(() =>
      translateSketch(document, { sketchId, du: 0, dv: 0, dn: 1 })
    ).toThrow(/bound to its surface/);
    // In-plane movement of the same sketch is fine.
    const moved = translateSketch(document, { sketchId, du: 2, dv: 3 });
    expect(objectsOf(moved)[0]).toMatchObject({ centerX: 2, centerY: 3 });
  });

  it('replays through the command system and undoes cleanly', () => {
    const { document, sketchId } = sketchWith([
      { objectKind: 'rectangle', width: 4, height: 6, centerX: 0, centerY: 0 }
    ]);
    const manager = new CommandManager(document);
    const moved = manager.execute(
      commandFactories.translateSketch({ sketchId, du: 10, dv: 5 })
    );
    expect(objectsOf(moved)[0]).toMatchObject({ centerX: 10, centerY: 5 });
    const undone = manager.undo();
    expect(undone && objectsOf(undone)[0]).toMatchObject({
      centerX: 0,
      centerY: 0
    });
  });

  it('rejects non-finite deltas', () => {
    const { document, sketchId } = sketchWith([
      { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
    ]);
    expect(() =>
      translateSketch(document, { sketchId, du: Number.NaN, dv: 0 })
    ).toThrow(/finite/);
  });
});
