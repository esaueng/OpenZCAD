import { describe, expect, it } from 'vitest';
import { commandFactories, CommandManager } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { sketchObjectLabels } from './objectLabels';

describe('sketch display labels', () => {
  it('distinguishes repeated names, avoids authored suffixes, and survives reopen', () => {
    const manager = new CommandManager(
      createProjectDocument('Labels', toUserId('test'))
    );
    const command = commandFactories.addSketch({
      name: 'Outline',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        { objectKind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
        { objectKind: 'line', x1: 10, y1: 10, x2: 0, y2: 10 }
      ]
    });
    manager.execute(command);
    const document = manager.document;
    const sketch = Object.values(document.nodes).find(
      (node) => node.kind === 'sketch'
    )!;
    const last = document.nodes[sketch.objectIds[2]!]!;
    last.name = 'line profile 1';
    const labels = sketchObjectLabels(document, sketch);
    expect([...labels.values()]).toEqual([
      'line profile 2',
      'line profile 3',
      'line profile 1'
    ]);
    expect(document.nodes[sketch.objectIds[0]!]!.name).toBe('line profile');
    const reopened = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    expect(
      sketchObjectLabels(reopened, findSketch(reopened, sketch.sketchId)!)
    ).toEqual(labels);
  });
});
