import { describe, expect, it } from 'vitest';
import {
  commandFactories,
  CommandManager,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  toSketchConstraintId,
  toUserId,
  type EntityId,
  type ProjectDocument
} from '@openzcad/shared';
import { sketchObjectLabels, sketchPointNamer } from './objectLabels';
import { compositeCommands, cornerRectangleShape } from './composites';
import {
  constraintRefusalMessage,
  describeConstraint,
  topResidualConstraints
} from './constraints';

function threeLines() {
  const manager = new CommandManager(
    createProjectDocument('Labels', toUserId('test'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Outline',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        { objectKind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
        { objectKind: 'line', x1: 10, y1: 10, x2: 0, y2: 10 }
      ]
    })
  );
  const document = manager.document;
  const sketch = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch'
  )!;
  return { document, sketch };
}

function rectangle() {
  const commit = compositeCommands(
    cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!,
    {
      kind: 'new-sketch',
      name: 'Plate',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
    }
  );
  const manager = new CommandManager(
    createProjectDocument('Rectangle labels', toUserId('test'))
  );
  manager.execute(composeCommands(commit.label, commit.commands));
  const sketch = findSketch(manager.document, commit.sketchId)!;
  return { document: manager.document, sketch };
}

describe('sketch display labels', () => {
  it('names unnamed objects by kind, never by the stored "line profile" (I10)', () => {
    const { document, sketch } = threeLines();
    expect(document.nodes[sketch.objectIds[0]!]!.name).toBe('line profile');
    expect([...sketchObjectLabels(document, sketch).values()]).toEqual([
      'Line 1',
      'Line 2',
      'Line 3'
    ]);
  });

  it('keeps authored names, skips their suffixes, and survives reopen', () => {
    const { document, sketch } = threeLines();
    document.nodes[sketch.objectIds[2]!]!.name = 'Line 1';
    const labels = sketchObjectLabels(document, sketch);
    expect([...labels.values()]).toEqual(['Line 2', 'Line 3', 'Line 1']);
    // Saved names are never rewritten.
    expect(document.nodes[sketch.objectIds[0]!]!.name).toBe('line profile');
    const reopened = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    expect(
      sketchObjectLabels(reopened, findSketch(reopened, sketch.sketchId)!)
    ).toEqual(labels);
  });

  it('names a rectangle’s sides and corners by the shape they belong to', () => {
    const { document, sketch } = rectangle();
    const labels = sketchObjectLabels(document, sketch);
    const sides = sketch.composites![0]!.edgeIds;
    expect(sides.map((id) => labels.get(String(id)))).toEqual([
      'Rectangle 1 side 1',
      'Rectangle 1 side 2',
      'Rectangle 1 side 3',
      'Rectangle 1 side 4'
    ]);
    const pointName = sketchPointNamer(sketch, labels);
    expect(pointName({ objectId: sides[1]!, point: 'end' })).toBe(
      'corner 3 of Rectangle 1'
    );
    expect(pointName({ objectId: sides[3]!, point: 'end' })).toBe(
      'corner 1 of Rectangle 1'
    );
  });

  it('describes a rectangle’s own corner joint once, in words', () => {
    const { document, sketch } = rectangle();
    const labels = sketchObjectLabels(document, sketch);
    const sides = sketch.composites![0]!.edgeIds;
    const nameOf = (id: EntityId) => labels.get(String(id)) ?? 'entity';
    const pointName = sketchPointNamer(sketch, labels);
    expect(
      describeConstraint(
        {
          constraintKind: 'coincident',
          a: { objectId: sides[0]!, point: 'end' },
          b: { objectId: sides[1]!, point: 'start' }
        },
        nameOf,
        pointName
      )
    ).toBe('Coincident · corner 2 of Rectangle 1');
    expect(
      describeConstraint(
        {
          constraintKind: 'lock',
          point: { objectId: sides[2]!, point: 'start' },
          x: 20,
          y: 12
        },
        nameOf,
        pointName
      )
    ).toBe('Lock · corner 3 of Rectangle 1');
  });
});

describe('constraint refusal copy (I35)', () => {
  it('never names the refused constraint as its own culprit', () => {
    const { document, sketch } = threeLines();
    const [a, b] = sketch.objectIds;
    const stored = {
      ...sketch,
      constraints: [
        {
          constraintId: toSketchConstraintId('scon_good'),
          data: {
            constraintKind: 'distance' as const,
            a: { objectId: a!, point: 'start' as const },
            b: { objectId: a!, point: 'end' as const },
            value: 50
          }
        },
        {
          constraintId: toSketchConstraintId('scon_refused'),
          data: {
            constraintKind: 'distance' as const,
            a: { objectId: a!, point: 'start' as const },
            b: { objectId: b!, point: 'end' as const },
            value: 70
          }
        }
      ]
    };
    const culprits = topResidualConstraints(
      document,
      stored,
      [
        { constraintId: 'scon_refused', maxResidual: 9 },
        { constraintId: 'scon_good', maxResidual: 3 }
      ],
      2,
      new Set(['scon_refused'])
    );
    expect(culprits).toEqual(['Distance 50 · start of Line 1 ↔ end of Line 1']);
    const message = constraintRefusalMessage('Distance 70 mm', culprits);
    expect(message).toMatch(/^Distance 70 mm was not added: it conflicts with/);
    // Said once (I46): the old copy repeated "no change was applied".
    expect(message.match(/unchanged/g)).toHaveLength(1);
    expect(message).not.toMatch(/profile|\.start|\.end/);
  });
});
