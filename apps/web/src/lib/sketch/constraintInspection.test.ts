import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import {
  toEntityId,
  toSketchConstraintId,
  toSketchId,
  toUserId,
  type SketchConstraintData,
  type SketchNode
} from '@openzcad/shared';
import { constraintInspectionTargets } from './constraintInspection';

const constraintId = toSketchConstraintId('constraint_inspect');

function fixture() {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Constraint inspection', toUserId('user_sketch')),
    {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 2 },
        { objectKind: 'line', x1: 0, y1: 5, x2: 10, y2: 6 },
        { objectKind: 'circle', radius: 3, centerX: 20, centerY: 0 }
      ]
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const [lineA, lineB, circle] = sketch.objectIds;
  document.nodes[lineA!]!.name = 'First line';
  document.nodes[lineB!]!.name = 'Second line';
  document.nodes[circle!]!.name = 'Circle';
  const store = (data: SketchConstraintData) => {
    sketch.constraints = [{ constraintId, data }];
  };
  return {
    document,
    sketch,
    lineA: lineA!,
    lineB: lineB!,
    circle: circle!,
    store
  };
}

describe('constraintInspectionTargets', () => {
  it('resolves unary references and uses current names with an object-kind fallback', () => {
    const { document, sketch, lineA, circle, store } = fixture();
    store({ constraintKind: 'horizontal', objectId: lineA });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: lineA, label: 'First line' }]
    );

    document.nodes[lineA]!.name = 'Renamed line';
    store({ constraintKind: 'vertical', objectId: lineA });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: lineA, label: 'Renamed line' }]
    );

    document.nodes[circle]!.name = '';
    store({ constraintKind: 'radius', objectId: circle, value: 3 });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: circle, label: 'circle' }]
    );
  });

  it('returns pair relations in sketch order rather than reference order', () => {
    const { document, sketch, lineA, lineB, store } = fixture();
    for (const constraintKind of [
      'parallel',
      'perpendicular',
      'equal',
      'tangent',
      'concentric'
    ] as const) {
      store({ constraintKind, a: lineB, b: lineA });
      expect(
        constraintInspectionTargets(document, sketch, constraintId)
      ).toEqual([
        { objectId: lineA, label: 'First line' },
        { objectId: lineB, label: 'Second line' }
      ]);
    }
    store({ constraintKind: 'angle', a: lineB, b: lineA, valueDeg: 45 });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [
        { objectId: lineA, label: 'First line' },
        { objectId: lineB, label: 'Second line' }
      ]
    );
  });

  it('resolves point relations and both sides of a midpoint relation', () => {
    const { document, sketch, lineA, lineB, store } = fixture();
    const a = { objectId: lineB, point: 'start' as const };
    const b = { objectId: lineA, point: 'end' as const };
    for (const data of [
      { constraintKind: 'coincident', a, b },
      { constraintKind: 'distance', a, b, value: '10 mm' },
      { constraintKind: 'midpoint', point: a, line: lineA }
    ] satisfies SketchConstraintData[]) {
      store(data);
      expect(
        constraintInspectionTargets(document, sketch, constraintId)
      ).toEqual([
        { objectId: lineA, label: 'First line' },
        { objectId: lineB, label: 'Second line' }
      ]);
    }
  });

  it('requires exact supplied and live sketch membership even for existing nodes', () => {
    const { document, sketch, lineA, lineB, circle, store } = fixture();
    store({ constraintKind: 'parallel', a: lineA, b: lineB });
    const supplied = { ...sketch, objectIds: [circle, lineB] };
    expect(
      constraintInspectionTargets(document, supplied, constraintId)
    ).toEqual([{ objectId: lineB, label: 'Second line' }]);

    // A stale caller still holds lineB, but it has left the live sketch.
    sketch.objectIds = [lineA, circle];
    expect(
      constraintInspectionTargets(document, supplied, constraintId)
    ).toEqual([]);
  });

  it('ignores stale prospective constraints and resolves current stored references', () => {
    const { document, sketch, lineA, lineB, store } = fixture();
    store({ constraintKind: 'horizontal', objectId: lineA });
    const stale: SketchNode = {
      ...sketch,
      constraints: [
        {
          constraintId: toSketchConstraintId('constraint_prospective'),
          data: { constraintKind: 'vertical', objectId: lineB }
        },
        {
          constraintId,
          data: { constraintKind: 'vertical', objectId: lineB }
        }
      ]
    };
    expect(
      constraintInspectionTargets(document, stale, 'constraint_prospective')
    ).toEqual([]);
    expect(constraintInspectionTargets(document, stale, constraintId)).toEqual([
      { objectId: lineA, label: 'First line' }
    ]);
    sketch.constraints = [];
    expect(constraintInspectionTargets(document, stale, constraintId)).toEqual(
      []
    );
  });

  it('returns no targets for a missing sketch or constraint', () => {
    const { document, sketch, lineA, store } = fixture();
    expect(
      constraintInspectionTargets(document, undefined, constraintId)
    ).toEqual([]);
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      []
    );
    store({ constraintKind: 'horizontal', objectId: lineA });
    expect(
      constraintInspectionTargets(
        document,
        { ...sketch, sketchId: toSketchId('sketch_missing') },
        constraintId
      )
    ).toEqual([]);
    delete document.nodes[sketch.id];
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      []
    );
  });

  it('skips missing, wrong-kind, and unreferenced objects without dropping valid targets', () => {
    const { document, sketch, lineA, lineB, circle, store } = fixture();
    store({ constraintKind: 'parallel', a: lineA, b: lineB });
    delete document.nodes[lineA];
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: lineB, label: 'Second line' }]
    );

    document.nodes[lineB] = {
      ...document.nodes[document.rootNodeId]!,
      id: lineB
    };
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      []
    );

    const missing = toEntityId('ent_missing');
    sketch.objectIds.push(missing);
    store({ constraintKind: 'parallel', a: missing, b: circle });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: circle, label: 'Circle' }]
    );
  });

  it('deduplicates repeated membership and repeated point references', () => {
    const { document, sketch, lineA, lineB, store } = fixture();
    sketch.objectIds = [lineA, lineB, lineA];
    store({
      constraintKind: 'distance',
      a: { objectId: lineA, point: 'start' },
      b: { objectId: lineA, point: 'end' },
      value: 10
    });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: lineA, label: 'First line' }]
    );
  });

  it('uses the sketch-wide labels for unary and pair targets, ignoring repeated membership', () => {
    const { document, sketch, lineA, lineB, circle, store } = fixture();
    document.nodes[lineA]!.name = 'Edge';
    document.nodes[lineB]!.name = 'Edge';
    sketch.objectIds = [circle, lineB, lineB, lineA];
    store({ constraintKind: 'parallel', a: lineA, b: lineB });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [
        { objectId: lineB, label: 'Edge 1' },
        { objectId: lineA, label: 'Edge 2' }
      ]
    );
    store({ constraintKind: 'horizontal', objectId: lineA });
    expect(constraintInspectionTargets(document, sketch, constraintId)).toEqual(
      [{ objectId: lineA, label: 'Edge 2' }]
    );
  });
});
