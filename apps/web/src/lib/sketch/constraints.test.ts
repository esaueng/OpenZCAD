import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { toUserId, type EntityId } from '@openzcad/shared';
import {
  buildConstraint,
  describeConstraint,
  refusePick,
  type ConstraintPick
} from './constraints';

function fixture() {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Constraints', toUserId('user_sketch')),
    {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 2 },
        { objectKind: 'line', x1: 0, y1: 5, x2: 10, y2: 6 },
        { objectKind: 'circle', radius: 'r', centerX: 20, centerY: 0 },
        { objectKind: 'rectangle', width: 4, height: 4, centerX: 30, centerY: 0 }
      ]
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const [lineA, lineB, circle, rectangle] = sketch.objectIds as string[];
  return { document, sketch, lineA: lineA!, lineB: lineB!, circle: circle!, rectangle: rectangle! };
}

const object = (objectId: string): ConstraintPick => ({
  kind: 'object',
  objectId
});
const point = (
  objectId: string,
  pointName: 'start' | 'end' | 'center'
): ConstraintPick => ({ kind: 'point', objectId, point: pointName });

describe('sketch constraint picking', () => {
  it('accepts legal picks and refuses the wrong entity kinds', () => {
    const { document, sketch, lineA, circle, rectangle } = fixture();
    expect(refusePick(document, sketch, 'horizontal', [], object(lineA))).toBe(
      null
    );
    expect(
      refusePick(document, sketch, 'horizontal', [], object(circle))
    ).toMatch(/applies to lines/);
    expect(refusePick(document, sketch, 'radius', [], object(circle))).toBe(
      null
    );
    expect(
      refusePick(document, sketch, 'radius', [], object(rectangle))
    ).toMatch(/circles and arcs/);
    expect(
      refusePick(document, sketch, 'coincident', [], object(lineA))
    ).toMatch(/snap point/);
    expect(
      refusePick(document, sketch, 'coincident', [], point(lineA, 'start'))
    ).toBe(null);
    // A circle joins by its center only.
    expect(
      refusePick(document, sketch, 'coincident', [], point(circle, 'center'))
    ).toBe(null);
  });

  it('refuses duplicate picks and foreign objects', () => {
    const { document, sketch, lineA } = fixture();
    expect(
      refusePick(
        document,
        sketch,
        'parallel',
        [object(lineA)],
        object(lineA)
      )
    ).toMatch(/already part/);
    expect(
      refusePick(document, sketch, 'parallel', [], object('ent_nowhere'))
    ).toMatch(/not part of this sketch/);
  });

  it('builds each stage-1 constraint from completed picks', () => {
    const { document, sketch, lineA, lineB, circle } = fixture();
    expect(
      buildConstraint(document, sketch, 'horizontal', [object(lineA)])
    ).toEqual({
      data: { constraintKind: 'horizontal', objectId: lineA }
    });
    expect(
      buildConstraint(document, sketch, 'parallel', [
        object(lineA),
        object(lineB)
      ])
    ).toEqual({
      data: { constraintKind: 'parallel', a: lineA, b: lineB }
    });
    expect(
      buildConstraint(document, sketch, 'coincident', [
        point(lineA, 'end'),
        point(lineB, 'start')
      ])
    ).toEqual({
      data: {
        constraintKind: 'coincident',
        a: { objectId: lineA, point: 'end' },
        b: { objectId: lineB, point: 'start' }
      }
    });
    // The pinned radius keeps the object's stored value VERBATIM, so an
    // expression stays an expression.
    expect(
      buildConstraint(document, sketch, 'radius', [object(circle)])
    ).toEqual({
      data: { constraintKind: 'radius', objectId: circle, value: 'r' }
    });
    expect(
      buildConstraint(document, sketch, 'parallel', [object(lineA)])
    ).toEqual({ error: 'Parallel needs 2 pick(s).' });
  });

  it('guides tangent to one line plus one circle, in either order', () => {
    const { document, sketch, lineA, lineB, circle, rectangle } = fixture();
    expect(refusePick(document, sketch, 'tangent', [], object(lineA))).toBe(
      null
    );
    expect(refusePick(document, sketch, 'tangent', [], object(circle))).toBe(
      null
    );
    expect(
      refusePick(document, sketch, 'tangent', [], object(rectangle))
    ).toMatch(/line and a circle/);
    // The second pick must complete the pair, whichever side came first.
    expect(
      refusePick(document, sketch, 'tangent', [object(lineA)], object(lineB))
    ).toMatch(/needs a circle/);
    expect(
      refusePick(document, sketch, 'tangent', [object(circle)], object(circle))
    ).toMatch(/already part/);
    expect(
      refusePick(document, sketch, 'tangent', [object(circle)], object(lineA))
    ).toBe(null);
    expect(
      buildConstraint(document, sketch, 'tangent', [
        object(circle),
        object(lineA)
      ])
    ).toEqual({
      data: { constraintKind: 'tangent', a: circle, b: lineA }
    });
  });

  it('describes constraints with entity names', () => {
    const names: Record<string, string> = { a: 'Left edge', b: 'Right edge' };
    const nameOf = (objectId: EntityId) => names[String(objectId)] ?? 'entity';
    expect(
      describeConstraint(
        { constraintKind: 'parallel', a: 'a' as EntityId, b: 'b' as EntityId },
        nameOf
      )
    ).toBe('Parallel · Left edge ∥ Right edge');
    expect(
      describeConstraint(
        { constraintKind: 'radius', objectId: 'a' as EntityId, value: 12 },
        nameOf
      )
    ).toBe('Radius 12 · Left edge');
  });
});
