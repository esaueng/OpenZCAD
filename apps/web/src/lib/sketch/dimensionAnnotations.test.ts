import { describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import { sketchDimensionAnnotations } from './dimensionAnnotations';

function fixture(
  objects: SketchObjectData[],
  constraint: (ids: ReturnType<typeof findSketch> & {}) => SketchConstraintData
) {
  const added = addSketchFeature(
    createProjectDocument('Dimensions', toUserId('user_test')),
    {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    }
  );
  const sketch = findSketch(added.document, added.sketchId)!;
  const doc = commandFactories
    .addSketchConstraint({
      sketchId: added.sketchId,
      constraint: constraint(sketch)
    })
    .apply(added.document);
  const constrained = findSketch(doc, added.sketchId)!;
  const entries = constrained.objectIds.map((id) => ({
    id,
    data: objects[constrained.objectIds.indexOf(id)]!
  }));
  return { entries, constraints: constrained.constraints! };
}
const resolve = (value: number | string) =>
  typeof value === 'number' ? value : value === 'length' ? 5 : undefined;
const line: SketchObjectData = {
  objectKind: 'line',
  x1: 0,
  y1: 0,
  x2: 3,
  y2: 4
};

describe('persistent sketch dimensions', () => {
  it('uses a commanded constraint identity and a 3-4-5 span with in-plane witnesses', () => {
    const { entries, constraints } = fixture([line], (sketch) => ({
      constraintKind: 'distance',
      a: { objectId: sketch.objectIds[0]!, point: 'start' },
      b: { objectId: sketch.objectIds[0]!, point: 'end' },
      value: 'length'
    }));
    const [annotation] = sketchDimensionAnnotations(
      entries,
      constraints,
      resolve,
      'mm'
    );
    expect(annotation?.id).toBe(constraints[0]!.constraintId);
    expect(annotation?.label).toBe('length = 5 mm');
    expect(
      sketchDimensionAnnotations(
        entries,
        constraints,
        (value) => (value === 'length' ? 0.0001 : resolve(value)),
        'mm'
      )[0]?.label
    ).toBe('length = 1.000e-4 mm');

    expect(annotation?.span?.start.x).toBeCloseTo(-0.6, 12);
    expect(annotation?.span?.start.y).toBeCloseTo(0.45, 12);
    expect(annotation?.span?.end.x).toBeCloseTo(2.4, 12);
    expect(annotation?.span?.end.y).toBeCloseTo(4.45, 12);
    expect(annotation?.lines[0]?.[0]).toEqual({ x: 0, y: 0 });
    expect(annotation?.lines[1]?.[0]).toEqual({ x: 3, y: 4 });
    expect(
      sketchDimensionAnnotations(entries, constraints, () => undefined, 'mm')
    ).toEqual([]);
    expect(sketchDimensionAnnotations([], constraints, resolve, 'mm')).toEqual(
      []
    );
    expect(sketchDimensionAnnotations(entries, [], resolve, 'mm')).toEqual([]);
  });

  it('places the arc for directed perpendicular lines about their intersection', () => {
    const { entries, constraints } = fixture(
      [
        { objectKind: 'line', x1: -10, y1: 0, x2: 10, y2: 0 },
        { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 }
      ],
      (sketch) => ({
        constraintKind: 'angle',
        a: sketch.objectIds[0]!,
        b: sketch.objectIds[1]!,
        valueDeg: 90
      })
    );
    const [annotation] = sketchDimensionAnnotations(
      entries,
      constraints,
      resolve,
      'in'
    );
    expect(annotation?.label).toBe('90°');
    expect(annotation?.lines[0]).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 0 }
    ]);
    expect(annotation?.anchor.x).toBeCloseTo(6 / Math.sqrt(2));
    expect(annotation?.anchor.y).toBeCloseTo(6 / Math.sqrt(2));
    expect(annotation?.span).toBeUndefined();
  });

  it('resolves arc endpoints and circle centers without inventing point identity', () => {
    const { entries, constraints } = fixture(
      [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        { objectKind: 'circle', centerX: 0, centerY: 10, radius: 2 }
      ],
      (sketch) => ({
        constraintKind: 'distance',
        a: { objectId: sketch.objectIds[0]!, point: 'end' },
        b: { objectId: sketch.objectIds[1]!, point: 'center' },
        value: 5
      })
    );
    const [annotation] = sketchDimensionAnnotations(
      entries,
      constraints,
      resolve,
      'mm'
    );
    expect(annotation?.lines[0]?.[0]?.x).toBeCloseTo(0);
    expect(annotation?.lines[0]?.[0]?.y).toBeCloseTo(5);
    expect(annotation?.lines[1]?.[0]).toEqual({ x: 0, y: 10 });
    const invalid = constraints.map((entry) => ({
      ...entry,
      data: {
        ...entry.data,
        b: { objectId: entries[1]!.id, point: 'start' as const }
      } as SketchConstraintData
    }));
    expect(sketchDimensionAnnotations(entries, invalid, resolve, 'mm')).toEqual(
      []
    );
  });

  it('omits nonfinite and degenerate geometry instead of placing labels at the origin', () => {
    const { entries, constraints } = fixture([line], (sketch) => ({
      constraintKind: 'distance',
      a: { objectId: sketch.objectIds[0]!, point: 'start' },
      b: { objectId: sketch.objectIds[0]!, point: 'end' },
      value: 5
    }));
    expect(
      sketchDimensionAnnotations(entries, constraints, () => NaN, 'mm')
    ).toEqual([]);
    expect(
      sketchDimensionAnnotations(
        [{ ...entries[0]!, data: { ...line, x2: 0, y2: 0 } }],
        constraints,
        resolve,
        'mm'
      )
    ).toEqual([]);
  });
  it('draws a circle radius from its center to its actual rim, while labeling the driving target', () => {
    const { entries, constraints } = fixture(
      [{ objectKind: 'circle', centerX: 10, centerY: 20, radius: 4 }],
      (sketch) => ({
        constraintKind: 'radius',
        objectId: sketch.objectIds[0]!,
        value: 'length'
      })
    );
    const [annotation] = sketchDimensionAnnotations(
      entries,
      constraints,
      resolve,
      'in'
    );
    expect(annotation?.kind).toBe('radius');
    expect(annotation?.label).toBe('R length = 5 in');
    expect(annotation?.span?.start).toEqual({ x: 10, y: 20 });
    expect(annotation?.span?.end.x).toBeCloseTo(10 + 4 / Math.sqrt(2), 12);
    expect(annotation?.span?.end.y).toBeCloseTo(20 + 4 / Math.sqrt(2), 12);
    expect(annotation?.id).toBe(constraints[0]!.constraintId);
    expect(
      sketchDimensionAnnotations(entries, constraints, () => undefined, 'mm')
    ).toEqual([]);
    expect(sketchDimensionAnnotations([], constraints, resolve, 'mm')).toEqual(
      []
    );
  });

  it('places an arc radius on the counter-clockwise sweep across zero degrees', () => {
    const { entries, constraints } = fixture(
      [
        {
          objectKind: 'arc',
          centerX: 2,
          centerY: 3,
          radius: 5,
          startAngleDeg: 300,
          endAngleDeg: 60
        }
      ],
      (sketch) => ({
        constraintKind: 'radius',
        objectId: sketch.objectIds[0]!,
        value: 5
      })
    );
    const [annotation] = sketchDimensionAnnotations(
      entries,
      constraints,
      resolve,
      'mm'
    );
    expect(annotation?.span?.end.x).toBeCloseTo(7, 12);
    expect(annotation?.span?.end.y).toBeCloseTo(3, 12);
    for (const [startAngleDeg, endAngleDeg] of [
      [0, 0],
      [0, 720],
      [NaN, 60]
    ]) {
      expect(
        sketchDimensionAnnotations(
          [
            {
              ...entries[0]!,
              data: {
                objectKind: 'arc',
                centerX: 2,
                centerY: 3,
                radius: 5,
                startAngleDeg: startAngleDeg!,
                endAngleDeg: endAngleDeg!
              }
            }
          ],
          constraints,
          resolve,
          'mm'
        )
      ).toEqual([]);
    }
    expect(
      sketchDimensionAnnotations(
        [{ ...entries[0]!, data: line }],
        constraints,
        resolve,
        'mm'
      )
    ).toEqual([]);
  });
});
