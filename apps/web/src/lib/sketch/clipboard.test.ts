import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  toUserId,
  type EntityId,
  type SketchObjectData
} from '@openzcad/shared';
import { copySketchObjects, pasteSketchObjectsCommands } from './clipboard';

const resolve = (value: unknown) =>
  typeof value === 'number' ? value : Number(value);

describe('sketch copy and paste', () => {
  it('pastes the selected entities as new ones, stepped clear of the copy', () => {
    const manager = new CommandManager(
      createProjectDocument('Clipboard', toUserId('user_clipboard'))
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Clipboard',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 4 },
          { objectKind: 'circle', centerX: 5, centerY: 2, radius: 1 },
          { objectKind: 'line', x1: 50, y1: 50, x2: 60, y2: 50 }
        ]
      })
    );
    const sketchId = manager.document.sketchOrder[0]!;
    const sketch = () => findSketch(manager.document, sketchId)!;
    const objects = sketch().objectIds.map((id) => {
      const node = manager.document.nodes[id];
      if (node?.kind !== 'sketch-object') throw new Error('no object');
      return { id: String(id), data: node.data };
    });
    const [line, circle] = objects.map((object) => object.id);
    const clipboard = copySketchObjects(objects, [circle!, line!], resolve);
    expect(clipboard).not.toBeNull();
    // Sketch order, not selection order; the unselected line stays out.
    expect(clipboard!.objects.map((data) => data.objectKind)).toEqual([
      'line',
      'circle'
    ]);
    expect(clipboard!.span).toEqual({ x: 10, y: 4 });

    const first = pasteSketchObjectsCommands(clipboard!, sketchId, resolve);
    manager.execute(composeCommands('Paste', first.commands));
    const second = pasteSketchObjectsCommands(clipboard!, sketchId, resolve);
    manager.execute(composeCommands('Paste', second.commands));
    expect(sketch().objectIds).toHaveLength(7);
    const data = (id: string) => {
      const node = manager.document.nodes[id as EntityId];
      if (node?.kind !== 'sketch-object') throw new Error('no object');
      return node.data as SketchObjectData & Record<string, unknown>;
    };
    // One span (10) plus a tenth of it, then twice that.
    expect(data(first.objectIds[0]!)).toMatchObject({ x1: 11, x2: 21, y1: 0 });
    expect(data(first.objectIds[1]!)).toMatchObject({ centerX: 16, radius: 1 });
    expect(data(second.objectIds[0]!)).toMatchObject({ x1: 22, x2: 32 });
    manager.undo();
    expect(sketch().objectIds).toHaveLength(5);
  });

  it('evaluates dimensions when copied, so a paste elsewhere keeps the shape', () => {
    const source = (value: unknown) =>
      value === 'width' ? 20 : value === 'r' ? 3 : Number(value);
    const destination = (value: unknown) =>
      value === 'width' ? 100 : value === 'r' ? 9 : Number(value);
    const clipboard = copySketchObjects(
      [
        {
          id: 'line',
          data: { objectKind: 'line', x1: 0, y1: 0, x2: 'width', y2: 0 }
        },
        {
          id: 'round',
          data: { objectKind: 'circle', centerX: 0, centerY: 0, radius: 'r' }
        }
      ],
      ['line', 'round'],
      source
    )!;
    expect(clipboard.objects).toEqual([
      { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 3 }
    ]);
    const { commands } = pasteSketchObjectsCommands(
      clipboard,
      'sk_any' as never,
      destination
    );
    const added = (
      commands[0] as unknown as {
        payload: { objects: Record<string, unknown>[] };
      }
    ).payload.objects;
    // Stepped one span (-3…20 = 23) plus a tenth; the copy keeps its
    // copied length of 20 and radius of 3, not the destination's values.
    expect(Number(added[0]!.x1)).toBeCloseTo(25.3, 9);
    expect(Number(added[0]!.x2) - Number(added[0]!.x1)).toBeCloseTo(20, 9);
    expect(added[1]).toMatchObject({ radius: 3 });
  });

  it('copies nothing when nothing selected is in the sketch', () => {
    expect(copySketchObjects([], ['ghost'], resolve)).toBeNull();
  });
});
