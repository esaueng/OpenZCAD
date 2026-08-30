import { describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EntityId,
  type SketchObjectData
} from '@openzcad/shared';
import {
  buildConstraint,
  CONSTRAINT_TOOL_SPECS,
  describeConstraint,
  measureDrivingDimension,
  refusePick,
  type PendingConstraintKind,
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
        { objectKind: 'circle', radius: 3, centerX: 24, centerY: 4 },
        {
          objectKind: 'arc',
          radius: 2,
          centerX: 28,
          centerY: 0,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 30,
          centerY: 0
        }
      ]
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const [lineA, lineB, circle, circleB, arc, rectangle] =
    sketch.objectIds as string[];
  return {
    document,
    sketch,
    lineA: lineA!,
    lineB: lineB!,
    circle: circle!,
    circleB: circleB!,
    arc: arc!,
    rectangle: rectangle!
  };
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
  it('enumerates the solver-ready constraints and driving dimensions', () => {
    expect(CONSTRAINT_TOOL_SPECS.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'perpendicular',
        'equal',
        'concentric',
        'midpoint',
        'distance',
        'angle'
      ])
    );
    expect(CONSTRAINT_TOOL_SPECS).toHaveLength(12);
  });

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
      refusePick(document, sketch, 'parallel', [object(lineA)], object(lineA))
    ).toMatch(/already part/);
    expect(
      refusePick(document, sketch, 'parallel', [], object('ent_nowhere'))
    ).toMatch(/not part of this sketch/);
  });

  it('builds each stage-1 constraint from completed picks', () => {
    const { document, sketch, lineA, lineB, circle, circleB } = fixture();
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
    expect(
      buildConstraint(document, sketch, 'perpendicular', [
        object(lineA),
        object(lineB)
      ])
    ).toEqual({
      data: { constraintKind: 'perpendicular', a: lineA, b: lineB }
    });
    expect(
      buildConstraint(document, sketch, 'equal', [
        object(circle),
        object(circleB)
      ])
    ).toEqual({
      data: { constraintKind: 'equal', a: circle, b: circleB }
    });
    expect(
      buildConstraint(document, sketch, 'concentric', [
        object(circle),
        object(circleB)
      ])
    ).toEqual({
      data: { constraintKind: 'concentric', a: circle, b: circleB }
    });
    expect(
      buildConstraint(document, sketch, 'midpoint', [
        point(lineA, 'end'),
        object(lineB)
      ])
    ).toEqual({
      data: {
        constraintKind: 'midpoint',
        point: { objectId: lineA, point: 'end' },
        line: lineB
      }
    });
    expect(
      buildConstraint(
        document,
        sketch,
        'distance',
        [point(lineA, 'start'), point(lineB, 'end')],
        'span'
      )
    ).toEqual({
      data: {
        constraintKind: 'distance',
        a: { objectId: lineA, point: 'start' },
        b: { objectId: lineB, point: 'end' },
        value: 'span'
      }
    });
    expect(
      buildConstraint(
        document,
        sketch,
        'angle',
        [object(lineA), object(lineB)],
        45
      )
    ).toEqual({
      data: {
        constraintKind: 'angle',
        a: lineA,
        b: lineB,
        valueDeg: 45
      }
    });
    expect(
      buildConstraint(document, sketch, 'distance', [
        point(lineA, 'start'),
        point(lineB, 'end')
      ])
    ).toEqual({ error: 'Distance needs a driving value.' });
  });

  it('pins both sides of the new tools applicability boundaries', () => {
    const { document, sketch, lineA, lineB, circle, circleB, arc, rectangle } =
      fixture();

    expect(
      refusePick(document, sketch, 'perpendicular', [], object(lineA))
    ).toBe(null);
    expect(
      refusePick(document, sketch, 'perpendicular', [], object(circle))
    ).toMatch(/applies to lines/);

    expect(refusePick(document, sketch, 'equal', [], object(lineA))).toBe(null);
    expect(
      refusePick(document, sketch, 'equal', [object(lineA)], object(circle))
    ).toMatch(/another line/);
    expect(refusePick(document, sketch, 'equal', [], object(circle))).toBe(
      null
    );
    expect(
      refusePick(document, sketch, 'equal', [object(circle)], object(arc))
    ).toBe(null);
    expect(
      refusePick(document, sketch, 'equal', [], object(rectangle))
    ).toMatch(/two lines or two circles/);

    expect(refusePick(document, sketch, 'concentric', [], object(circle))).toBe(
      null
    );
    expect(
      refusePick(
        document,
        sketch,
        'concentric',
        [object(circle)],
        object(circleB)
      )
    ).toBe(null);
    expect(
      refusePick(document, sketch, 'concentric', [], object(lineA))
    ).toMatch(/circles and arcs/);

    expect(
      refusePick(document, sketch, 'midpoint', [], point(lineA, 'end'))
    ).toBe(null);
    expect(
      refusePick(
        document,
        sketch,
        'midpoint',
        [point(lineA, 'end')],
        object(lineB)
      )
    ).toBe(null);
    expect(
      refusePick(
        document,
        sketch,
        'midpoint',
        [point(lineA, 'end')],
        point(lineB, 'start')
      )
    ).toMatch(/Pick an object/);
    expect(
      refusePick(
        document,
        sketch,
        'midpoint',
        [point(lineA, 'end')],
        object(lineA)
      )
    ).toMatch(/different objects/);

    expect(
      refusePick(document, sketch, 'distance', [], point(lineA, 'start'))
    ).toBe(null);
    expect(
      refusePick(document, sketch, 'distance', [], point(circle, 'center'))
    ).toBe(null);
    expect(refusePick(document, sketch, 'distance', [], object(lineA))).toMatch(
      /snap point/
    );
    expect(
      refusePick(document, sketch, 'distance', [], point(lineA, 'center'))
    ).toMatch(/start or end/);
    expect(
      refusePick(document, sketch, 'distance', [], point(rectangle, 'center'))
    ).toMatch(/line and arc points/);

    expect(refusePick(document, sketch, 'angle', [], object(lineA))).toBe(null);
    expect(
      refusePick(document, sketch, 'angle', [object(lineA)], object(lineB))
    ).toBe(null);
    expect(refusePick(document, sketch, 'angle', [], object(circle))).toMatch(
      /applies to two lines/
    );
  });

  it('prefills dimensions from independent closed-form geometry', () => {
    const { document, sketch, lineA, lineB } = fixture();
    const resolve = (value: number | string) =>
      typeof value === 'number' ? value : value === 'r' ? 3 : undefined;
    expect(
      measureDrivingDimension(
        document,
        sketch,
        'distance',
        [point(lineA, 'start'), point(lineB, 'end')],
        resolve
      )
    ).toEqual({ value: Math.hypot(10, 6) });
    const angle = measureDrivingDimension(
      document,
      sketch,
      'angle',
      [object(lineA), object(lineB)],
      resolve
    );
    expect(angle).toHaveProperty('value');
    if ('value' in angle) {
      const a = Math.atan2(2, 10);
      const b = Math.atan2(1, 10);
      expect(angle.value).toBeCloseTo(Math.abs(((a - b) * 180) / Math.PI), 10);
    }
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

async function solveWithConstraint(
  objects: SketchObjectData[],
  kind: PendingConstraintKind,
  picksFor: (ids: string[]) => ConstraintPick[],
  value?: number | string
) {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Constraint oracle', toUserId('user_oracle')),
    {
      name: 'Oracle profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const ids = sketch.objectIds.map(String);
  const built = buildConstraint(document, sketch, kind, picksFor(ids), value);
  if ('error' in built) {
    throw new Error(built.error);
  }
  const command = commandFactories.addSketchConstraint({
    sketchId,
    constraint: built.data
  });
  command.validate(document);
  const constrained = command.apply(document);
  const adapter = await createExactKernelAdapter();
  try {
    return await adapter.solveSketch(constrained, sketchId);
  } finally {
    adapter.dispose();
  }
}

function solvedObject(
  outcome: Awaited<ReturnType<typeof solveWithConstraint>>,
  index: number
) {
  const object = outcome.objects[index];
  if (!object) {
    throw new Error(`Missing solved object ${index}.`);
  }
  return object;
}

describe('solver-ready constraint command oracles', () => {
  it('solves a driving point distance to the closed-form length', async () => {
    const outcome = await solveWithConstraint(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 1 },
        { objectKind: 'line', x1: 4, y1: 6, x2: 9, y2: 8 }
      ],
      'distance',
      ([a, b]) => [point(a!, 'start'), point(b!, 'end')],
      12
    );
    const a = solvedObject(outcome, 0);
    const b = solvedObject(outcome, 1);
    if (a.kind !== 'line' || b.kind !== 'line') {
      throw new Error('Distance oracle expected two solved lines.');
    }
    expect(outcome.converged).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(Math.hypot(b.x2 - a.x1, b.y2 - a.y1)).toBeCloseTo(12, 8);
    expect([a.x1, a.y1, b.x2, b.y2]).not.toEqual([0, 0, 9, 8]);
  });

  it('solves a driving line angle to the requested degrees', async () => {
    const outcome = await solveWithConstraint(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 8, y2: 1 },
        { objectKind: 'line', x1: 1, y1: 3, x2: 7, y2: 9 }
      ],
      'angle',
      ([a, b]) => [object(a!), object(b!)],
      60
    );
    const a = solvedObject(outcome, 0);
    const b = solvedObject(outcome, 1);
    if (a.kind !== 'line' || b.kind !== 'line') {
      throw new Error('Angle oracle expected two solved lines.');
    }
    const ax = a.x2 - a.x1;
    const ay = a.y2 - a.y1;
    const bx = b.x2 - b.x1;
    const by = b.y2 - b.y1;
    const cosine = Math.max(
      -1,
      Math.min(1, (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by))
    );
    expect(outcome.converged).toBe(true);
    expect((Math.acos(cosine) * 180) / Math.PI).toBeCloseTo(60, 8);
    expect([a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2]).not.toEqual([
      0, 0, 8, 1, 1, 3, 7, 9
    ]);
  });

  it('binds a driving dimension to a named parameter', async () => {
    const { document, sketchId } = addSketchFeature(
      createProjectDocument('Parameter dimension', toUserId('user_parameter')),
      {
        name: 'Parameter profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 2, y2: 0 },
          { objectKind: 'line', x1: 4, y1: 0, x2: 8, y2: 0 }
        ]
      }
    );
    const parameter = commandFactories.setParameter({
      name: 'span',
      expression: '15'
    });
    parameter.validate(document);
    const parameterized = parameter.apply(document);
    const sketch = findSketch(parameterized, sketchId)!;
    const [a, b] = sketch.objectIds;
    const dimension = commandFactories.addSketchConstraint({
      sketchId,
      constraint: {
        constraintKind: 'distance',
        a: { objectId: a!, point: 'start' },
        b: { objectId: b!, point: 'end' },
        value: 'span'
      }
    });
    dimension.validate(parameterized);
    const constrained = dimension.apply(parameterized);
    const adapter = await createExactKernelAdapter();
    try {
      const outcome = await adapter.solveSketch(constrained, sketchId);
      const first = solvedObject(outcome, 0);
      const second = solvedObject(outcome, 1);
      if (first.kind !== 'line' || second.kind !== 'line') {
        throw new Error('Parameter oracle expected two solved lines.');
      }
      expect(outcome.converged).toBe(true);
      expect(
        Math.hypot(second.x2 - first.x1, second.y2 - first.y1)
      ).toBeCloseTo(15, 8);

      const retarget = commandFactories.setParameter({
        name: 'span',
        expression: '6'
      });
      retarget.validate(constrained);
      const retargeted = retarget.apply(constrained);
      const updated = await adapter.solveSketch(retargeted, sketchId);
      const updatedFirst = solvedObject(updated, 0);
      const updatedSecond = solvedObject(updated, 1);
      if (updatedFirst.kind !== 'line' || updatedSecond.kind !== 'line') {
        throw new Error('Parameter retarget oracle expected two solved lines.');
      }
      expect(updated.converged).toBe(true);
      expect(
        Math.hypot(
          updatedSecond.x2 - updatedFirst.x1,
          updatedSecond.y2 - updatedFirst.y1
        )
      ).toBeCloseTo(6, 8);
    } finally {
      adapter.dispose();
    }
  });

  it('solves perpendicular lines to a right angle', async () => {
    const outcome = await solveWithConstraint(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 8, y2: 1 },
        { objectKind: 'line', x1: 1, y1: 3, x2: 7, y2: 9 }
      ],
      'perpendicular',
      ([a, b]) => [object(a!), object(b!)]
    );
    const a = solvedObject(outcome, 0);
    const b = solvedObject(outcome, 1);
    expect(a.kind).toBe('line');
    expect(b.kind).toBe('line');
    if (a.kind !== 'line' || b.kind !== 'line') {
      return;
    }
    const ax = a.x2 - a.x1;
    const ay = a.y2 - a.y1;
    const bx = b.x2 - b.x1;
    const by = b.y2 - b.y1;
    const cosine =
      (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by);
    expect(outcome.converged).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(Math.abs(cosine)).toBeLessThan(1e-8);
    expect([a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2]).not.toEqual([
      0, 0, 8, 1, 1, 3, 7, 9
    ]);
  });

  it('solves equal line length', async () => {
    const outcome = await solveWithConstraint(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        { objectKind: 'line', x1: 0, y1: 4, x2: 4, y2: 4 }
      ],
      'equal',
      ([a, b]) => [object(a!), object(b!)]
    );
    const a = solvedObject(outcome, 0);
    const b = solvedObject(outcome, 1);
    if (a.kind !== 'line' || b.kind !== 'line') {
      throw new Error('Equal-length oracle expected two solved lines.');
    }
    expect(outcome.converged).toBe(true);
    expect(Math.hypot(a.x2 - a.x1, a.y2 - a.y1)).toBeCloseTo(
      Math.hypot(b.x2 - b.x1, b.y2 - b.y1),
      8
    );
    expect(Math.hypot(b.x2 - b.x1, b.y2 - b.y1)).not.toBeCloseTo(4, 8);
  });

  it('solves circles to a shared center', async () => {
    const outcome = await solveWithConstraint(
      [
        { objectKind: 'circle', centerX: 0, centerY: 0, radius: 3 },
        { objectKind: 'circle', centerX: 8, centerY: 5, radius: 2 }
      ],
      'concentric',
      ([a, b]) => [object(a!), object(b!)]
    );
    const a = solvedObject(outcome, 0);
    const b = solvedObject(outcome, 1);
    if (a.kind !== 'circle' || b.kind !== 'circle') {
      throw new Error('Concentric oracle expected two solved circles.');
    }
    expect(outcome.converged).toBe(true);
    expect(a.centerX).toBeCloseTo(b.centerX, 9);
    expect(a.centerY).toBeCloseTo(b.centerY, 9);
    expect([a.centerX, a.centerY, b.centerX, b.centerY]).not.toEqual([
      0, 0, 8, 5
    ]);
  });

  it('solves a point onto another lines midpoint', async () => {
    const outcome = await solveWithConstraint(
      [
        { objectKind: 'line', x1: -3, y1: -2, x2: 2, y2: 8 },
        { objectKind: 'line', x1: 4, y1: 1, x2: 12, y2: 5 }
      ],
      'midpoint',
      ([pointLine, targetLine]) => [
        point(pointLine!, 'end'),
        object(targetLine!)
      ]
    );
    const pointLine = solvedObject(outcome, 0);
    const targetLine = solvedObject(outcome, 1);
    if (pointLine.kind !== 'line' || targetLine.kind !== 'line') {
      throw new Error('Midpoint oracle expected two solved lines.');
    }
    expect(outcome.converged).toBe(true);
    expect(pointLine.x2).toBeCloseTo((targetLine.x1 + targetLine.x2) / 2, 9);
    expect(pointLine.y2).toBeCloseTo((targetLine.y1 + targetLine.y2) / 2, 9);
    expect([pointLine.x2, pointLine.y2]).not.toEqual([2, 8]);
  });

  it('returns typed unsatisfied diagnostics for conflicting driving dimensions', async () => {
    const { document, sketchId } = addSketchFeature(
      createProjectDocument('Constraint conflict', toUserId('user_conflict')),
      {
        name: 'Conflict profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
          { objectKind: 'line', x1: 8, y1: 0, x2: 10, y2: 0 }
        ]
      }
    );
    const [a, b] = findSketch(document, sketchId)!.objectIds;
    const first = commandFactories.addSketchConstraint({
      sketchId,
      constraint: {
        constraintKind: 'distance',
        a: { objectId: a!, point: 'start' },
        b: { objectId: b!, point: 'end' },
        value: 8
      }
    });
    first.validate(document);
    const onceConstrained = first.apply(document);
    const second = commandFactories.addSketchConstraint({
      sketchId,
      constraint: {
        constraintKind: 'distance',
        a: { objectId: a!, point: 'start' },
        b: { objectId: b!, point: 'end' },
        value: 12
      }
    });
    second.validate(onceConstrained);
    const conflicted = second.apply(onceConstrained);
    const adapter = await createExactKernelAdapter();
    try {
      const outcome = await adapter.solveSketch(conflicted, sketchId);
      expect(outcome.classification).toBe('unsatisfied');
      expect(outcome.converged).toBe(false);
      expect(outcome.rolledBack).toBe(true);
      expect(outcome.constraintResiduals).toHaveLength(2);
      expect(
        outcome.constraintResiduals.some(({ maxResidual }) => maxResidual > 1)
      ).toBe(true);
    } finally {
      adapter.dispose();
    }
  });
});
