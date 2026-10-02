import { describe, expect, it } from 'vitest';
import type { EntityId, SketchObjectData } from './index';
import { toSketchReferenceAnnotationId } from './index';
import {
  convertReferenceLengthForDisplay,
  createSketchReferenceAnnotationId,
  describeSketchReferenceDimension,
  findSketchReferenceDimension,
  hasSketchReferenceDimensions,
  isReferenceDimensionConstraint,
  isSketchDimensionIdentity,
  isSketchReferenceDimension,
  isSketchReferenceDimensionData,
  referenceDimensionAccessibleName,
  referenceDimensionLabelText,
  referenceDisplayUnitLabel,
  refuseReferenceDimensionValueEdit,
  refuseReferenceDrivingConversion,
  resolveSketchReferenceDimension,
  sketchConstraintsForSolve,
  sketchDimensionIdentityKey,
  validateSketchReferenceDimensionData
} from './sketch-reference-dimensions';

const lineA = 'ent_lineA' as EntityId;
const lineB = 'ent_lineB' as EntityId;
const circleC = 'ent_circleC' as EntityId;
const arcD = 'ent_arcD' as EntityId;
const rectE = 'ent_rectE' as EntityId;

function objects(): Map<EntityId, SketchObjectData> {
  return new Map<EntityId, SketchObjectData>([
    [lineA, { objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }],
    [lineB, { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }],
    [circleC, { objectKind: 'circle', radius: 4, centerX: 10, centerY: 20 }],
    [
      arcD,
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ],
    [
      rectE,
      { objectKind: 'rectangle', width: 20, height: 10, centerX: 0, centerY: 0 }
    ]
  ]);
}

const numberResolve = (value: number | string) =>
  typeof value === 'number' ? value : undefined;

describe('S02-A reference dimension validation', () => {
  it('accepts the primitive first-slice targets', () => {
    const map = objects();
    expect(() =>
      validateSketchReferenceDimensionData(
        map,
        {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineA, point: 'end' }
        },
        'sref_test'
      )
    ).not.toThrow();
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'distance',
        a: { objectId: arcD, point: 'end' },
        b: { objectId: circleC, point: 'center' }
      })
    ).not.toThrow();
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'radius',
        objectId: circleC
      })
    ).not.toThrow();
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'radius',
        objectId: arcD
      })
    ).not.toThrow();
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'angle',
        a: lineA,
        b: lineB
      })
    ).not.toThrow();
  });

  it('refuses the same target identity twice at creation', () => {
    expect(() =>
      validateSketchReferenceDimensionData(
        objects(),
        {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineA, point: 'start' }
        },
        'sref_dup'
      )
    ).toThrow(/sref_dup.*same target twice/);
  });

  it('refuses missing objects, illegal point roles, and unsupported kinds', () => {
    const map = objects();
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'radius',
        objectId: 'ent_missing' as EntityId
      })
    ).toThrow(/not part of this sketch/);
    expect(() =>
      validateSketchReferenceDimensionData(
        map,
        {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'center' },
          b: { objectId: lineB, point: 'start' }
        },
        'sref_role'
      )
    ).toThrow(/sref_role.*no 'center' point/);
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'radius',
        objectId: lineA
      })
    ).toThrow(/circles and arcs/);
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'distance',
        a: { objectId: rectE, point: 'center' },
        b: { objectId: lineA, point: 'start' }
      })
    ).toThrow(/rectangle/);
    expect(() =>
      validateSketchReferenceDimensionData(
        map,
        { dimensionKind: 'angle', a: lineA, b: lineA },
        'sref_angle'
      )
    ).toThrow(/sref_angle.*two distinct lines/);
    expect(() =>
      validateSketchReferenceDimensionData(map, {
        dimensionKind: 'angle',
        a: lineA,
        b: circleC
      })
    ).toThrow(/two lines/);
  });

  it('rejects driving-dimension fields smuggled into a reference payload', () => {
    expect(
      isSketchReferenceDimensionData({
        dimensionKind: 'distance',
        a: { objectId: lineA, point: 'start' },
        b: { objectId: lineA, point: 'end' },
        value: 5
      })
    ).toBe(false);
    expect(
      isSketchReferenceDimensionData({
        dimensionKind: 'radius',
        objectId: circleC,
        value: 4
      })
    ).toBe(false);
    expect(
      isSketchReferenceDimensionData({
        constraintKind: 'distance',
        a: { objectId: lineA, point: 'start' },
        b: { objectId: lineA, point: 'end' },
        value: 5
      })
    ).toBe(false);
    expect(
      isSketchReferenceDimension({
        annotationId: 'sref_1',
        data: {
          dimensionKind: 'radius',
          objectId: circleC,
          value: 4
        }
      })
    ).toBe(false);
    expect(
      isSketchReferenceDimension({
        annotationId: 'sref_1',
        data: { dimensionKind: 'radius', objectId: circleC }
      })
    ).toBe(true);
  });
});

describe('S02-A pure resolver', () => {
  it('measures a 3-4-5 distance from current geometry', () => {
    const outcome = resolveSketchReferenceDimension(
      objects(),
      {
        annotationId: toSketchReferenceAnnotationId('sref_dist'),
        data: {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineA, point: 'end' }
        }
      },
      numberResolve
    );
    expect(outcome.status).toBe('current');
    if (outcome.status === 'current' && outcome.dimensionKind === 'distance') {
      expect(outcome.value).toBeCloseTo(5, 12);
    } else {
      throw new Error('expected a current distance');
    }
  });

  it('reports a valid zero distance for distinct coincident points', () => {
    const map = objects();
    map.set(lineB, { objectKind: 'line', x1: 1, y1: 1, x2: 1, y2: 1 });
    const outcome = resolveSketchReferenceDimension(
      map,
      {
        annotationId: toSketchReferenceAnnotationId('sref_zero'),
        data: {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineB, point: 'start' }
        }
      },
      (value) => (typeof value === 'number' ? value : undefined)
    );
    // lineA.start is (0,0) and lineB.start was moved to (1,1): non-zero.
    expect(outcome.status).toBe('current');
    const coincident = new Map<EntityId, SketchObjectData>([
      [lineA, { objectKind: 'line', x1: 2, y1: 2, x2: 5, y2: 5 }],
      [lineB, { objectKind: 'line', x1: 2, y1: 2, x2: 9, y2: 9 }]
    ]);
    const zero = resolveSketchReferenceDimension(
      coincident,
      {
        annotationId: toSketchReferenceAnnotationId('sref_zero2'),
        data: {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineB, point: 'start' }
        }
      },
      numberResolve
    );
    expect(zero.status).toBe('current');
    if (zero.status === 'current' && zero.dimensionKind === 'distance') {
      expect(zero.value).toBe(0);
    } else {
      throw new Error('expected a current zero distance');
    }
  });

  it('measures radius and angle from resolved geometry', () => {
    const radius = resolveSketchReferenceDimension(
      objects(),
      {
        annotationId: toSketchReferenceAnnotationId('sref_rad'),
        data: { dimensionKind: 'radius', objectId: circleC }
      },
      numberResolve
    );
    expect(radius).toMatchObject({ status: 'current', value: 4 });

    const angle = resolveSketchReferenceDimension(
      new Map<EntityId, SketchObjectData>([
        [lineA, { objectKind: 'line', x1: -10, y1: 0, x2: 10, y2: 0 }],
        [lineB, { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 }]
      ]),
      {
        annotationId: toSketchReferenceAnnotationId('sref_ang'),
        data: { dimensionKind: 'angle', a: lineA, b: lineB }
      },
      numberResolve
    );
    expect(angle.status).toBe('current');
    if (angle.status === 'current' && angle.dimensionKind === 'angle') {
      expect(angle.valueDeg).toBeCloseTo(90, 10);
    } else {
      throw new Error('expected a current angle');
    }
  });

  it('follows parameter edits without changing the annotation record', () => {
    const annotation = {
      annotationId: toSketchReferenceAnnotationId('sref_follow'),
      data: {
        dimensionKind: 'distance',
        a: { objectId: lineA, point: 'start' },
        b: { objectId: lineA, point: 'end' }
      }
    } as const;
    const before = resolveSketchReferenceDimension(
      objects(),
      annotation,
      numberResolve
    );
    const moved = new Map(objects());
    moved.set(lineA, { objectKind: 'line', x1: 0, y1: 0, x2: 6, y2: 8 });
    const after = resolveSketchReferenceDimension(
      moved,
      annotation,
      numberResolve
    );
    if (before.status !== 'current' || before.dimensionKind !== 'distance') {
      throw new Error('expected current');
    }
    if (after.status !== 'current' || after.dimensionKind !== 'distance') {
      throw new Error('expected current');
    }
    expect(before.value).toBeCloseTo(5, 12);
    expect(after.value).toBeCloseTo(10, 12);
    expect(annotation.annotationId).toBe('sref_follow');
  });

  it('returns unresolved with a named reason instead of calling the solver', () => {
    const map = objects();
    const unknown = resolveSketchReferenceDimension(
      map,
      {
        annotationId: toSketchReferenceAnnotationId('sref_expr'),
        data: {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineA, point: 'end' }
        }
      },
      () => undefined
    );
    expect(unknown.status).toBe('unresolved');
    if (unknown.status === 'unresolved') {
      expect(unknown.reason).toContain('sref_expr');
      expect(unknown.reason).toMatch(/could not be resolved|not part of/);
    }

    const missing = resolveSketchReferenceDimension(
      map,
      {
        annotationId: toSketchReferenceAnnotationId('sref_gone'),
        data: { dimensionKind: 'radius', objectId: 'ent_gone' as EntityId }
      },
      numberResolve
    );
    expect(missing.status).toBe('unresolved');
    if (missing.status === 'unresolved') {
      expect(missing.reason).toContain('sref_gone');
      expect(missing.reason).toContain('ent_gone');
    }

    const illegal = resolveSketchReferenceDimension(
      map,
      {
        annotationId: toSketchReferenceAnnotationId('sref_bad'),
        data: {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'center' },
          b: { objectId: lineB, point: 'start' }
        }
      },
      numberResolve
    );
    expect(illegal.status).toBe('unresolved');
    if (illegal.status === 'unresolved') {
      expect(illegal.reason).toContain('sref_bad');
    }
  });

  it('refuses degenerate radius and degenerate line direction by status', () => {
    const flat = new Map<EntityId, SketchObjectData>([
      [circleC, { objectKind: 'circle', radius: 0, centerX: 0, centerY: 0 }]
    ]);
    const zeroRadius = resolveSketchReferenceDimension(
      flat,
      {
        annotationId: toSketchReferenceAnnotationId('sref_degen'),
        data: { dimensionKind: 'radius', objectId: circleC }
      },
      numberResolve
    );
    expect(zeroRadius.status).toBe('unresolved');
    if (zeroRadius.status === 'unresolved') {
      expect(zeroRadius.reason).toContain('sref_degen');
      expect(zeroRadius.reason).toMatch(/degenerate radius/);
    }

    const negative = resolveSketchReferenceDimension(
      new Map<EntityId, SketchObjectData>([
        [circleC, { objectKind: 'circle', radius: -3, centerX: 0, centerY: 0 }]
      ]),
      {
        annotationId: toSketchReferenceAnnotationId('sref_neg'),
        data: { dimensionKind: 'radius', objectId: circleC }
      },
      numberResolve
    );
    expect(negative.status).toBe('unresolved');

    const nonFinite = resolveSketchReferenceDimension(
      new Map<EntityId, SketchObjectData>([
        [circleC, { objectKind: 'circle', radius: NaN, centerX: 0, centerY: 0 }]
      ]),
      {
        annotationId: toSketchReferenceAnnotationId('sref_nan'),
        data: { dimensionKind: 'radius', objectId: circleC }
      },
      numberResolve
    );
    expect(nonFinite.status).toBe('unresolved');

    const zeroLine = resolveSketchReferenceDimension(
      new Map<EntityId, SketchObjectData>([
        [lineA, { objectKind: 'line', x1: 1, y1: 1, x2: 1, y2: 1 }],
        [lineB, { objectKind: 'line', x1: 0, y1: 0, x2: 5, y2: 0 }]
      ]),
      {
        annotationId: toSketchReferenceAnnotationId('sref_dir'),
        data: { dimensionKind: 'angle', a: lineA, b: lineB }
      },
      numberResolve
    );
    expect(zeroLine.status).toBe('unresolved');
    if (zeroLine.status === 'unresolved') {
      expect(zeroLine.reason).toMatch(/invalid line direction/);
    }
  });
});

describe('S02-A units and presentation', () => {
  it('converts length for display only and keeps angles in degrees', () => {
    expect(convertReferenceLengthForDisplay(25.4, 'mm', 'inch')).toBeCloseTo(
      1,
      12
    );
    expect(convertReferenceLengthForDisplay(1, 'inch', 'mm')).toBeCloseTo(
      25.4,
      12
    );
    expect(convertReferenceLengthForDisplay(10, 'mm', 'cm')).toBeCloseTo(1, 12);
    expect(convertReferenceLengthForDisplay(1000, 'mm', 'm')).toBeCloseTo(
      1,
      12
    );
    expect(convertReferenceLengthForDisplay(12, 'mm', 'mm')).toBe(12);
    expect(referenceDisplayUnitLabel('length', 'inch')).toBe('in');
    expect(referenceDisplayUnitLabel('length', 'mm')).toBe('mm');
    expect(referenceDisplayUnitLabel('angle', 'inch')).toBe('°');
    expect(referenceDisplayUnitLabel('angle', 'mm')).toBe('°');
  });

  it('marks reference labels distinctly and never as driving', () => {
    const label = referenceDimensionLabelText('distance', '12 mm');
    expect(label).toBe('(12 mm)');
    expect(label).not.toContain('Driving');
    const accessible = referenceDimensionAccessibleName('distance', '12 mm');
    expect(accessible).toBe('Reference distance, 12 mm');
    expect(accessible).not.toContain('Driving');
    expect(referenceDimensionAccessibleName('angle', '90°')).toBe(
      'Reference angle, 90°'
    );
    expect(referenceDimensionAccessibleName('radius', 'R 4 mm')).toBe(
      'Reference radius, R 4 mm'
    );
  });

  it('describes reference rows without constraint vocabulary', () => {
    const nameOf = (id: EntityId) => String(id);
    expect(
      describeSketchReferenceDimension(
        {
          dimensionKind: 'distance',
          a: { objectId: lineA, point: 'start' },
          b: { objectId: lineA, point: 'end' }
        },
        nameOf
      )
    ).toContain('Reference distance');
    expect(
      describeSketchReferenceDimension(
        { dimensionKind: 'radius', objectId: circleC },
        nameOf
      )
    ).toContain('Reference radius');
    expect(
      describeSketchReferenceDimension(
        { dimensionKind: 'angle', a: lineA, b: lineB },
        nameOf
      )
    ).toContain('Reference angle');
  });
});

describe('S02-A identity, solver exclusion, and refusal paths', () => {
  it('allocates stable generated ids, never coordinate hashes', () => {
    const first = createSketchReferenceAnnotationId();
    const second = createSketchReferenceAnnotationId();
    expect(first).toMatch(/^sref_/);
    expect(second).toMatch(/^sref_/);
    expect(first).not.toBe(second);
  });

  it('keys placement by tagged identity and looks up references explicitly', () => {
    const annotationId = toSketchReferenceAnnotationId('sref_place');
    expect(
      sketchDimensionIdentityKey({ kind: 'reference', annotationId })
    ).toBe('sref_place');
    expect(
      sketchDimensionIdentityKey({
        kind: 'constraint',
        constraintId: 'scon_1' as never
      })
    ).toBe('scon_1');
    expect(isSketchDimensionIdentity({ kind: 'reference', annotationId })).toBe(
      true
    );
    expect(isSketchDimensionIdentity({ kind: 'reference' })).toBe(false);
    expect(isSketchDimensionIdentity('sref_place')).toBe(false);

    const sketch = {
      referenceDimensions: [
        {
          annotationId,
          data: { dimensionKind: 'radius', objectId: circleC }
        }
      ]
    };
    expect(
      findSketchReferenceDimension(sketch as never, annotationId)?.annotationId
    ).toBe(annotationId);
    expect(
      findSketchReferenceDimension(sketch as never, 'sref_missing')
    ).toBeUndefined();
    expect(hasSketchReferenceDimensions(sketch as never)).toBe(true);
    expect(hasSketchReferenceDimensions({})).toBe(false);
  });

  it('excludes reference rows from the GCS solve inputs', () => {
    const sketch = {
      constraints: [
        {
          constraintId: 'scon_1',
          data: {
            constraintKind: 'distance',
            a: { objectId: lineA, point: 'start' },
            b: { objectId: lineA, point: 'end' },
            value: 5
          }
        }
      ],
      referenceDimensions: [
        {
          annotationId: 'sref_1',
          data: {
            dimensionKind: 'distance',
            a: { objectId: lineA, point: 'start' },
            b: { objectId: lineA, point: 'end' }
          }
        }
      ]
    } as never;
    const forSolve = sketchConstraintsForSolve(sketch);
    expect(forSolve).toHaveLength(1);
    expect(forSolve[0]?.constraintId).toBe('scon_1');
    expect(
      forSolve.some(
        (entry) =>
          (entry as unknown as Record<string, unknown>).annotationId !==
          undefined
      )
    ).toBe(false);
    expect(sketchConstraintsForSolve({})).toEqual([]);
  });

  it('never mistakes a reference row for a constraint', () => {
    expect(
      isReferenceDimensionConstraint({
        annotationId: toSketchReferenceAnnotationId('sref_1'),
        data: { dimensionKind: 'radius', objectId: circleC }
      })
    ).toBe(false);
    expect(
      isReferenceDimensionConstraint({
        constraintId: 'scon_1',
        data: {
          constraintKind: 'radius',
          objectId: circleC,
          value: 4
        }
      } as never)
    ).toBe(true);
  });

  it('refuses expressions and implicit driving conversion', () => {
    expect(refuseReferenceDimensionValueEdit()).toMatch(
      /cannot carry an expression/
    );
    expect(refuseReferenceDrivingConversion()).toMatch(
      /cannot become a driving constraint/
    );
  });
});
