import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  toUserId,
  type EntityId,
  type ParamValue,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  advanceSketchEditPick,
  runSketchEdit,
  type SketchEditHost
} from './edits';
import {
  curveCrossings,
  planSketchCircularPattern,
  planSketchLinearPattern,
  planSketchMirror,
  planSketchTrim,
  resolvePatternPivot,
  type SketchModifyPlan
} from './modify';

const resolve = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);

function sketchWith(objects: SketchObjectData[]) {
  const manager = new CommandManager(
    createProjectDocument('Modify', toUserId('user_modify'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Modify',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds.map(String);
  const constrain = (constraint: SketchConstraintData) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  const sketch = () => findSketch(manager.document, sketchId)!;
  const object = (id: string) => {
    const node = manager.document.nodes[id as EntityId];
    if (node?.kind !== 'sketch-object') throw new Error(`no object ${id}`);
    return node.data;
  };
  /** Commit a plan the way the app does: one transaction, one undo step. */
  const commit = (plan: SketchModifyPlan) => {
    if (plan.status !== 'commands') throw new Error(plan.reason);
    manager.execute(composeCommands(plan.label, plan.commands));
    return plan;
  };
  return { manager, sketchId, ids, constrain, sketch, object, commit };
}

const kinds = (constraints: readonly { data: SketchConstraintData }[]) =>
  constraints.map((constraint) => constraint.data.constraintKind).sort();

function expectClose(actual: Record<string, unknown>, expected: object) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key] as number, key).toBeCloseTo(value as number, 9);
  }
}

describe('curve crossings', () => {
  it('finds line, circle and arc crossings bounded to both curves', () => {
    const line = {
      kind: 'line' as const,
      a: { x: -10, y: 0 },
      b: { x: 10, y: 0 }
    };
    expect(
      curveCrossings(line, { kind: 'circle', c: { x: 0, y: 0 }, r: 5 })
    ).toHaveLength(2);
    // A tangent touch is one crossing at the foot of the perpendicular.
    const tangent = curveCrossings(line, {
      kind: 'circle',
      c: { x: 3, y: 5 },
      r: 5
    });
    expect(tangent).toHaveLength(1);
    expect(tangent[0]!.x).toBeCloseTo(3, 9);
    // An upper half-arc misses the line's y=0 crossings only at its ends.
    const upper = {
      kind: 'arc' as const,
      c: { x: 0, y: 1 },
      r: 2,
      start: 0,
      sweep: Math.PI
    };
    expect(curveCrossings(line, upper)).toEqual([]);
    // Segments that would cross only on an extension do not cross.
    expect(
      curveCrossings(line, {
        kind: 'line',
        a: { x: 20, y: -5 },
        b: { x: 20, y: 5 }
      })
    ).toEqual([]);
    expect(
      curveCrossings(
        { kind: 'circle', c: { x: 0, y: 0 }, r: 5 },
        { kind: 'circle', c: { x: 8, y: 0 }, r: 5 }
      ).map((p) => Math.abs(p.y))
    ).toEqual([3, 3]);
  });
});

describe('Trim', () => {
  // A horizontal line from 0 to 30 crossed at x=10 and x=20, with a tail
  // line joined to its right end.
  function crossed() {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
      { objectKind: 'line', x1: 10, y1: -5, x2: 10, y2: 5 },
      { objectKind: 'line', x1: 20, y1: -5, x2: 20, y2: 5 },
      { objectKind: 'line', x1: 30, y1: 0, x2: 30, y2: 8 }
    ]);
    const [target, left, right, tail] = fixture.ids as [
      string,
      string,
      string,
      string
    ];
    return { ...fixture, target, left, right, tail };
  }

  it('splits a line between two crossings and moves the far end’s relations to the new piece', () => {
    const { manager, sketchId, sketch, object, commit, constrain, ...ids } =
      crossed();
    constrain({ constraintKind: 'horizontal', objectId: ids.target as never });
    constrain({
      constraintKind: 'coincident',
      a: { objectId: ids.target as never, point: 'end' },
      b: { objectId: ids.tail as never, point: 'start' }
    });
    constrain({
      constraintKind: 'equal',
      a: ids.target as never,
      b: ids.tail as never
    });
    const before = { sketch: sketch(), nodes: manager.document.nodes };
    const plan = commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids.target,
        { x: 15, y: 0.1 },
        resolve
      )
    );
    expect(plan.message).toBe(
      'Trim split the line in two. Dropped 1 relation on the removed part.'
    );
    expectClose(object(ids.target), { x1: 0, y1: 0, x2: 10, y2: 0 });
    const piece = sketch().objectIds.map(String).at(-1)!;
    expectClose(object(piece), { x1: 20, y1: 0, x2: 30, y2: 0 });
    const constraints = sketch().constraints ?? [];
    // Horizontal stays; equal length goes; the tail joint moved to the
    // piece; the piece is held collinear; each cut end sits on its cutter.
    expect(kinds(constraints)).toEqual([
      'coincident',
      'horizontal',
      'parallel',
      'point-on-object',
      'point-on-object',
      'point-on-object'
    ]);
    const joint = constraints.find(
      (c) => c.data.constraintKind === 'coincident'
    )!.data;
    expect(joint).toMatchObject({
      a: { objectId: piece, point: 'end' },
      b: { objectId: ids.tail, point: 'start' }
    });
    const onCutters = constraints
      .map((c) => c.data)
      .filter(
        (data) =>
          data.constraintKind === 'point-on-object' &&
          data.objectId !== ids.target
      );
    expect(onCutters).toEqual([
      expect.objectContaining({
        point: { objectId: ids.target, point: 'end' },
        objectId: ids.left
      }),
      expect.objectContaining({
        point: { objectId: piece, point: 'start' },
        objectId: ids.right
      })
    ]);
    // One undo step restores the document exactly.
    manager.undo();
    expect({ sketch: sketch(), nodes: manager.document.nodes }).toEqual(before);
  });

  it('shortens a line from the end the click is on, dropping relations there', () => {
    const { manager, sketchId, sketch, object, commit, constrain, ...ids } =
      crossed();
    constrain({
      constraintKind: 'coincident',
      a: { objectId: ids.target as never, point: 'end' },
      b: { objectId: ids.tail as never, point: 'start' }
    });
    const plan = commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids.target,
        { x: 25, y: 0 },
        resolve
      )
    );
    expect(plan.message).toBe(
      'Trim shortened the line. Dropped 1 relation on the removed part.'
    );
    expectClose(object(ids.target), { x1: 0, y1: 0, x2: 20, y2: 0 });
    expect(sketch().constraints).toEqual([
      expect.objectContaining({
        data: {
          constraintKind: 'point-on-object',
          point: { objectId: ids.target, point: 'end' },
          objectId: ids.right
        }
      })
    ]);
    // The start end is untouched, so a trim from that side keeps x2.
    commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids.target,
        { x: 3, y: 0 },
        resolve
      )
    );
    expectClose(object(ids.target), { x1: 10, y1: 0, x2: 20, y2: 0 });
  });

  it('refuses a trim that would move an end a reference dimension measures', () => {
    const { manager, sketchId, sketch, ...ids } = crossed();
    manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId,
        data: {
          dimensionKind: 'distance',
          a: { objectId: ids.target as never, point: 'end' },
          b: { objectId: ids.tail as never, point: 'end' }
        }
      })
    );
    const trim = (x: number) =>
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids.target,
        { x, y: 0 },
        resolve
      );
    const refusal = {
      status: 'refuse',
      reason:
        'A reference dimension measures the end this trim would move. Delete the dimension first.'
    };
    // Splitting would hand the measured end to a new piece; shortening from
    // that side would move it.
    expect(trim(15)).toEqual(refusal);
    expect(trim(25)).toEqual(refusal);
    // The start end is not measured, so trimming there still works.
    expect(trim(5)).toMatchObject({ status: 'commands' });
  });

  it('keeps expressions on the end it did not move', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'line', x1: '0', y1: '0', x2: 30, y2: 0 },
      { objectKind: 'line', x1: 20, y1: -5, x2: 20, y2: 5 }
    ]);
    commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 25, y: 0 },
        resolve
      )
    );
    expect(object(ids[0]!)).toMatchObject({ x1: '0', y1: '0', x2: 20 });
  });

  it('hands the far end’s expressions to the piece a split creates', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: '30', y2: '0' },
      { objectKind: 'line', x1: 10, y1: -5, x2: 10, y2: 5 },
      { objectKind: 'line', x1: 20, y1: -5, x2: 20, y2: 5 }
    ]);
    commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 15, y: 0 },
        resolve
      )
    );
    expect(object(sketch().objectIds.map(String).at(-1)!)).toMatchObject({
      x1: 20,
      x2: '30',
      y2: '0'
    });
  });

  it('deletes an entity nothing crosses, and refuses composites', () => {
    const { manager, sketchId, ids, sketch, commit } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'rectangle', width: 4, height: 4, centerX: 5, centerY: 0 }
    ]);
    expect(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[1]!,
        { x: 7, y: 2 },
        resolve
      )
    ).toEqual({
      status: 'refuse',
      reason:
        'A rectangle is one object with no point identity. Draw it as lines to trim part of it.'
    });
    // The rectangle's edges cut the line at x=3 and x=7.
    commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 5, y: 0 },
        resolve
      )
    );
    expect(sketch().objectIds).toHaveLength(3);
    const lone = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    const plan = lone.commit(
      planSketchTrim(
        lone.manager.document,
        lone.sketch(),
        lone.sketchId,
        lone.ids[0]!,
        { x: 5, y: 0 },
        resolve
      )
    );
    expect(plan.message).toBe(
      'Trim removed the whole line: nothing crosses it.'
    );
    expect(lone.sketch().objectIds).toEqual([]);
  });

  it('cuts against a polygon’s edges', () => {
    // A square-on-its-corner polygon (4 sides, top vertex at (0, 5)) whose
    // left and right corners sit at x = ±5 on the line y = 0.
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'line', x1: -20, y1: 1, x2: 20, y2: 1 },
      { objectKind: 'polygon', sides: 4, radius: 5, centerX: 0, centerY: 0 }
    ]);
    const plan = commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 1 },
        resolve
      )
    );
    expect(plan.message).toBe('Trim split the line in two.');
    expectClose(object(ids[0]!), { x1: -20, x2: -4 });
    expectClose(object(sketch().objectIds.map(String).at(-1)!), {
      x1: 4,
      x2: 20
    });
  });

  it('turns a circle into the arc outside two crossings, carrying its relations', () => {
    const { manager, sketchId, ids, sketch, object, commit, constrain } =
      sketchWith([
        { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
        // A vertical chord at x=3 crosses at (3, ±4).
        { objectKind: 'line', x1: 3, y1: -10, x2: 3, y2: 10 },
        { objectKind: 'line', x1: -9, y1: 0, x2: -9, y2: 9 }
      ]);
    const [circle, chord, other] = ids as [string, string, string];
    constrain({
      constraintKind: 'radius',
      objectId: circle as never,
      value: 5
    });
    const radiusId = sketch().constraints!.at(-1)!.constraintId;
    constrain({
      constraintKind: 'tangent',
      a: other as never,
      b: circle as never
    });
    constrain({
      constraintKind: 'lock',
      point: { objectId: circle as never, point: 'center' },
      x: 0,
      y: 0
    });
    const plan = commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        circle,
        { x: 5, y: 0 },
        resolve
      )
    );
    expect(plan.message).toBe(
      'Trim turned the circle into an arc. Dropped 1 relation on the removed part.'
    );
    expect(sketch().objectIds.map(String)).not.toContain(circle);
    const arc = sketch().objectIds.map(String).at(-1)!;
    const data = object(arc);
    expect(data.objectKind).toBe('arc');
    if (data.objectKind !== 'arc') return;
    // The kept arc runs counter-clockwise from (3, 4) round to (3, -4).
    expect(data.startAngleDeg as number).toBeCloseTo(53.13010235, 6);
    expect(data.endAngleDeg as number).toBeCloseTo(306.86989765, 6);
    const constraints = (sketch().constraints ?? []).map((c) => c.data);
    expect(constraints).toEqual(
      expect.arrayContaining([
        { constraintKind: 'radius', objectId: arc, value: 5 },
        {
          constraintKind: 'lock',
          point: { objectId: arc, point: 'center' },
          x: 0,
          y: 0
        },
        {
          constraintKind: 'point-on-object',
          point: { objectId: arc, point: 'start' },
          objectId: chord
        }
      ])
    );
    // Restated relations keep their identity, so placed labels stay put.
    expect(
      (sketch().constraints ?? []).find(
        (c) => c.data.constraintKind === 'radius'
      )!.constraintId
    ).toBe(radiusId);
    // The point-free tangent cannot name a contact point on the new arc.
    expect(constraints.some((c) => c.constraintKind === 'tangent')).toBe(false);
  });

  it('moves an arc tangent at the split far end onto the new piece', () => {
    const { manager, sketchId, ids, sketch, commit, constrain } = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 10,
        startAngleDeg: 0,
        endAngleDeg: 180
      },
      { objectKind: 'line', x1: -5, y1: 0, x2: -5, y2: 20 },
      { objectKind: 'line', x1: 5, y1: 0, x2: 5, y2: 20 },
      // Tangent to the arc at its end, (-10, 0).
      { objectKind: 'line', x1: -10, y1: 0, x2: -10, y2: -8 }
    ]);
    const [arc, , , leg] = ids as [string, string, string, string];
    constrain({
      constraintKind: 'tangent',
      a: leg as never,
      b: arc as never,
      at: { objectId: arc as never, point: 'end' }
    });
    commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        arc,
        { x: 0, y: 10 },
        resolve
      )
    );
    const piece = sketch().objectIds.map(String).at(-1)!;
    expect(
      (sketch().constraints ?? [])
        .map((c) => c.data)
        .find((data) => data.constraintKind === 'tangent')
    ).toEqual({
      constraintKind: 'tangent',
      a: leg,
      b: piece,
      at: { objectId: piece, point: 'end' }
    });
  });

  it('refuses a circle only one curve touches', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      { objectKind: 'line', x1: 5, y1: -5, x2: 5, y2: 5 }
    ]);
    expect(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: -5, y: 0 },
        resolve
      )
    ).toMatchObject({ status: 'refuse' });
  });

  it('splits an arc into two concentric pieces of equal radius', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 10,
        startAngleDeg: 0,
        endAngleDeg: 180
      },
      { objectKind: 'line', x1: -5, y1: 0, x2: -5, y2: 20 },
      { objectKind: 'line', x1: 5, y1: 0, x2: 5, y2: 20 }
    ]);
    commit(
      planSketchTrim(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 10 },
        resolve
      )
    );
    expect(object(ids[0]!)).toMatchObject({ startAngleDeg: 0 });
    expect(
      (object(ids[0]!) as { endAngleDeg: number }).endAngleDeg
    ).toBeCloseTo(60, 9);
    const piece = sketch().objectIds.map(String).at(-1)!;
    expect(
      (object(piece) as { startAngleDeg: number }).startAngleDeg
    ).toBeCloseTo(120, 9);
    expect(object(piece)).toMatchObject({ endAngleDeg: 180, radius: 10 });
    expect(kinds(sketch().constraints ?? [])).toEqual([
      'concentric',
      'equal',
      'point-on-object',
      'point-on-object'
    ]);
  });
});

describe('Mirror', () => {
  it('mirrors a line about an axis with symmetric relations, coincident on the axis', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'line', x1: 0, y1: 2, x2: 6, y2: 5, construction: true }
    ]);
    const [axis, source] = ids as [string, string];
    const plan = commit(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        source,
        axis,
        resolve
      )
    );
    expect(plan.message).toBe('Mirror added a linked line.');
    const image = sketch().objectIds.map(String).at(-1)!;
    expectClose(object(image), { x1: 0, y1: 2, x2: -6, y2: 5 });
    expect(object(image).construction).toBe(true);
    expect((sketch().constraints ?? []).map((c) => c.data)).toEqual([
      {
        constraintKind: 'coincident',
        a: { objectId: source, point: 'start' },
        b: { objectId: image, point: 'start' }
      },
      {
        constraintKind: 'point-on-object',
        point: { objectId: source, point: 'start' },
        objectId: axis
      },
      {
        constraintKind: 'symmetric',
        a: { objectId: source, point: 'end' },
        b: { objectId: image, point: 'end' },
        axis
      }
    ]);
  });

  it('reuses a relation that already holds an on-axis point on the axis', () => {
    const { manager, sketchId, ids, sketch, commit, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'line', x1: 0, y1: 2, x2: 6, y2: 5 }
    ]);
    const [axis, source] = ids as [string, string];
    constrain({
      constraintKind: 'point-on-object',
      point: { objectId: source as never, point: 'start' },
      objectId: axis as never
    });
    commit(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        source,
        axis,
        resolve
      )
    );
    expect(kinds(sketch().constraints ?? [])).toEqual([
      'coincident',
      'point-on-object',
      'symmetric'
    ]);
  });

  it('ties a locked on-axis point to the axis unless the axis is locked too', () => {
    const fixture = () => {
      const made = sketchWith([
        { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
        { objectKind: 'line', x1: 0, y1: 2, x2: 6, y2: 5 }
      ]);
      made.constrain({
        constraintKind: 'lock',
        point: { objectId: made.ids[1] as never, point: 'start' },
        x: 0,
        y: 2
      });
      return made;
    };
    const mirrorKinds = (made: ReturnType<typeof fixture>) => {
      made.commit(
        planSketchMirror(
          made.manager.document,
          made.sketch(),
          made.sketchId,
          made.ids[1]!,
          made.ids[0]!,
          resolve
        )
      );
      return kinds(made.sketch().constraints ?? []);
    };
    // A movable axis still needs the relation to stay through the joint.
    expect(mirrorKinds(fixture())).toEqual([
      'coincident',
      'lock',
      'point-on-object',
      'symmetric'
    ]);
    const fixed = fixture();
    for (const [point, y] of [
      ['start', -10],
      ['end', 10]
    ] as const) {
      fixed.constrain({
        constraintKind: 'lock',
        point: { objectId: fixed.ids[0] as never, point },
        x: 0,
        y
      });
    }
    expect(mirrorKinds(fixed)).toEqual([
      'coincident',
      'lock',
      'lock',
      'lock',
      'symmetric'
    ]);
  });

  it('reverses an arc’s sweep and links its ends crosswise with an equal radius', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      {
        objectKind: 'arc',
        centerX: 5,
        centerY: 0,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    const [axis, source] = ids as [string, string];
    commit(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        source,
        axis,
        resolve
      )
    );
    const image = sketch().objectIds.map(String).at(-1)!;
    // Reflected about x=0: the quarter from 0° to 90° becomes 90° to 180°.
    expectClose(object(image), {
      centerX: -5,
      centerY: 0,
      radius: 2,
      startAngleDeg: 90,
      endAngleDeg: 180
    });
    expect((sketch().constraints ?? []).map((c) => c.data)).toEqual([
      {
        constraintKind: 'symmetric',
        a: { objectId: source, point: 'start' },
        b: { objectId: image, point: 'end' },
        axis
      },
      {
        constraintKind: 'symmetric',
        a: { objectId: source, point: 'end' },
        b: { objectId: image, point: 'start' },
        axis
      },
      { constraintKind: 'equal', a: source, b: image }
    ]);
  });

  it('refuses a mirror image that overlaps part of its source', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: -10, y1: 0, x2: 10, y2: 0 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 3,
        startAngleDeg: 0,
        endAngleDeg: 270
      },
      // Crosses the axis off-centre: its image shares the span 0 < y < 2.
      { objectKind: 'line', x1: 5, y1: -2, x2: 5, y2: 6 }
    ]);
    const [axis, arc, line] = ids as [string, string, string];
    for (const source of [arc, line]) {
      expect(
        planSketchMirror(
          manager.document,
          sketch(),
          sketchId,
          source,
          axis,
          resolve
        )
      ).toEqual({
        status: 'refuse',
        reason:
          'The mirror image would overlap part of its source. Trim the entity at the mirror line first.'
      });
    }
  });

  it('refuses a full-sweep arc mirrored about a line through its centre', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 3,
        radius: 2,
        startAngleDeg: 30,
        endAngleDeg: 30
      }
    ]);
    expect(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        ids[1]!,
        ids[0]!,
        resolve
      )
    ).toMatchObject({ status: 'refuse' });
  });

  it('refuses a mirror or pattern that lands on existing geometry', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'circle', centerX: 4, centerY: 0, radius: 1 },
      // Already where the mirror image and the second instance would go.
      { objectKind: 'circle', centerX: -4, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 4, y1: 0, x2: 12, y2: 0 },
      { objectKind: 'circle', centerX: 12, centerY: 0, radius: 1 }
    ]);
    const [axis, circle, , direction] = ids as [string, string, string, string];
    const refusal = {
      status: 'refuse',
      reason: 'The result would lie on top of geometry already in the sketch.'
    };
    expect(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        circle,
        axis,
        resolve
      )
    ).toEqual(refusal);
    const linear = (spacing: number) =>
      planSketchLinearPattern(
        manager.document,
        sketch(),
        sketchId,
        circle,
        direction,
        spacing,
        3,
        resolve
      );
    expect(linear(4)).toEqual(refusal);
    expect(linear(3)).toMatchObject({ status: 'commands' });
    expect(
      planSketchCircularPattern(
        manager.document,
        sketch(),
        sketchId,
        circle,
        { x: 0, y: 0 },
        2,
        360,
        resolve
      )
    ).toEqual(refusal);
  });

  it('lets mirror and pattern copies lie on construction guides', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'circle', centerX: 4, centerY: 0, radius: 1 },
      {
        objectKind: 'circle',
        centerX: -4,
        centerY: 0,
        radius: 1,
        construction: true
      },
      { objectKind: 'line', x1: 4, y1: 0, x2: 12, y2: 0 },
      // A construction source may land on profile geometry.
      {
        objectKind: 'circle',
        centerX: 20,
        centerY: 0,
        radius: 1,
        construction: true
      },
      { objectKind: 'circle', centerX: -20, centerY: 0, radius: 1 }
    ]);
    const [axis, circle, , , guide] = ids as [
      string,
      string,
      string,
      string,
      string
    ];
    expect(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        circle,
        axis,
        resolve
      )
    ).toMatchObject({ status: 'commands' });
    expect(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        guide,
        axis,
        resolve
      )
    ).toMatchObject({ status: 'commands' });
  });

  it('refuses an entity that is its own mirror image, and a non-line mirror', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'circle', centerX: 0, centerY: 3, radius: 2 },
      { objectKind: 'line', x1: -4, y1: 0, x2: 4, y2: 0 }
    ]);
    const [axis, circle, across] = ids as [string, string, string];
    for (const source of [circle, across]) {
      expect(
        planSketchMirror(
          manager.document,
          sketch(),
          sketchId,
          source,
          axis,
          resolve
        )
      ).toEqual({
        status: 'refuse',
        reason:
          'That entity is already symmetric about the line; its mirror image is itself.'
      });
    }
    expect(
      planSketchMirror(
        manager.document,
        sketch(),
        sketchId,
        across,
        circle,
        resolve
      )
    ).toMatchObject({ status: 'refuse' });
  });
});

describe('Patterns', () => {
  it('repeats a circle along a direction line, each instance equal to the source', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 4 }
    ]);
    const [circle, direction] = ids as [string, string];
    const plan = commit(
      planSketchLinearPattern(
        manager.document,
        sketch(),
        sketchId,
        circle,
        direction,
        5,
        3,
        resolve
      )
    );
    expect(plan.message).toBe('Linear pattern added 2 linked circles.');
    const copies = sketch().objectIds.map(String).slice(2);
    expect(copies.map((id) => object(id))).toEqual([
      { objectKind: 'circle', centerX: 0, centerY: 5, radius: 1 },
      { objectKind: 'circle', centerX: 0, centerY: 10, radius: 1 }
    ]);
    expect((sketch().constraints ?? []).map((c) => c.data)).toEqual(
      copies.map((copy) => ({ constraintKind: 'equal', a: circle, b: copy }))
    );
    manager.undo();
    expect(sketch().objectIds).toHaveLength(2);
  });

  it('keeps pattern lines parallel and equal to the source', () => {
    const { manager, sketchId, ids, sketch, commit } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 4 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    commit(
      planSketchLinearPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        ids[1]!,
        2,
        2,
        resolve
      )
    );
    expect(kinds(sketch().constraints ?? [])).toEqual(['equal', 'parallel']);
  });

  it('refuses a linear pattern whose lines overlap along the direction, but lets them touch', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
      { objectKind: 'line', x1: 0, y1: -5, x2: 10, y2: -5 }
    ]);
    const plan = (spacing: number) =>
      planSketchLinearPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        ids[1]!,
        spacing,
        3,
        resolve
      );
    expect(plan(3)).toMatchObject({
      status: 'refuse',
      reason:
        'Some instances would overlap others. Use a spacing at least as long as the entity along the direction.'
    });
    expect(plan(4)).toMatchObject({ status: 'commands' });
  });

  it('refuses a circular pattern of arcs whose sweeps overlap', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 180
      }
    ]);
    const plan = (count: number) =>
      planSketchCircularPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 0 },
        count,
        360,
        resolve
      );
    expect(plan(4)).toMatchObject({ status: 'refuse' });
    expect(plan(2)).toMatchObject({ status: 'commands' });
  });

  it('refuses fractional, too small and too large counts, and zero spacing', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 4 }
    ]);
    const plan = (spacing: number, count: number) =>
      planSketchLinearPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        ids[1]!,
        spacing,
        count,
        resolve
      );
    expect(plan(5, 2.5)).toEqual({
      status: 'refuse',
      reason: 'A pattern count is a whole number of instances.'
    });
    expect(plan(5, 1)).toMatchObject({ status: 'refuse' });
    expect(plan(5, 101)).toMatchObject({ status: 'refuse' });
    expect(plan(0, 3)).toEqual({
      status: 'refuse',
      reason: 'Pattern spacing must be a non-zero distance.'
    });
  });

  it('turns a line about a pivot: a full turn spaces evenly, a partial one ends on the angle', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      { objectKind: 'line', x1: 5, y1: 0, x2: 8, y2: 0 }
    ]);
    commit(
      planSketchCircularPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 0 },
        4,
        360,
        resolve
      )
    );
    const copies = sketch().objectIds.map(String).slice(1);
    expect(copies).toHaveLength(3);
    expectClose(object(copies[0]!), { x1: 0, y1: 5, x2: 0, y2: 8 });
    expectClose(object(copies[1]!), { x1: -5, y1: 0, x2: -8, y2: 0 });
    expectClose(object(copies[2]!), { x1: 0, y1: -5, x2: 0, y2: -8 });
    const partial = sketchWith([
      {
        objectKind: 'arc',
        centerX: 5,
        centerY: 0,
        radius: 1,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    partial.commit(
      planSketchCircularPattern(
        partial.manager.document,
        partial.sketch(),
        partial.sketchId,
        partial.ids[0]!,
        { x: 0, y: 0 },
        3,
        90,
        resolve
      )
    );
    const last = partial.sketch().objectIds.map(String).at(-1)!;
    // The last instance sits at 90°, and an arc turns with the pattern.
    expectClose(partial.object(last), {
      centerX: 0,
      centerY: 5,
      startAngleDeg: 90,
      endAngleDeg: 180
    });
  });

  it('refuses a pattern whose instances land on each other', () => {
    // A line through the pivot maps onto itself after half a turn.
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: -4, y1: 0, x2: 4, y2: 0 }
    ]);
    const plan = (count: number) =>
      planSketchCircularPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 0 },
        count,
        360,
        resolve
      );
    for (const count of [2, 4]) {
      expect(plan(count)).toEqual({
        status: 'refuse',
        reason:
          'Some instances would overlap others. Change the count or the angle, or move the pivot off the entity.'
      });
    }
    expect(plan(3)).toMatchObject({ status: 'commands' });
  });

  it('turns a partial arc about its own centre into distinct quadrants', () => {
    const { manager, sketchId, ids, sketch, object, commit } = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    commit(
      planSketchCircularPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 0 },
        4,
        360,
        resolve
      )
    );
    const copies = sketch().objectIds.map(String).slice(1);
    expect(
      copies.map((id) =>
        Math.round((object(id) as { startAngleDeg: number }).startAngleDeg)
      )
    ).toEqual([90, 180, 270]);
  });

  it('refuses a round centred on the pivot', () => {
    const { manager, sketchId, ids, sketch } = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 }
    ]);
    expect(
      planSketchCircularPattern(
        manager.document,
        sketch(),
        sketchId,
        ids[0]!,
        { x: 0, y: 0 },
        4,
        360,
        resolve
      )
    ).toMatchObject({ status: 'refuse' });
  });

  it('resolves the pivot from a circle centre or a snapped line end', () => {
    const { manager, ids, sketch } = sketchWith([
      { objectKind: 'circle', centerX: 3, centerY: 4, radius: 1 },
      { objectKind: 'line', x1: 1, y1: 2, x2: 7, y2: 9 }
    ]);
    const pivot = (pick: string) =>
      resolvePatternPivot(manager.document, sketch(), pick, resolve);
    expect(pivot(ids[0]!)).toEqual({ pivot: { x: 3, y: 4 } });
    expect(pivot(`${ids[1]!}#end`)).toEqual({ pivot: { x: 7, y: 9 } });
    expect('error' in pivot(ids[1]!)).toBe(true);
  });
});

describe('modify tool picking', () => {
  function host(applied: { commands: AnyCommand[]; label: string }[]) {
    const log: string[] = [];
    const asked: string[] = [];
    const value: SketchEditHost = {
      setStatus: (message) => log.push(message),
      setError: () => {},
      setBusy: () => {},
      resolve,
      addPick: () => {},
      askValue: (kind, picks, label, initial, step) =>
        asked.push(
          `${kind} ${picks.length} ${label} ${initial} ${step?.unitKind} ${step?.values.join(',')}`
        ),
      disarm: () => log.push('disarm'),
      runOperation: () => Promise.reject(new Error('no kernel here')),
      commit: async (_sketchId, commands, label) => {
        applied.push({ commands, label });
        return true;
      },
      describeFailure: (_error, fallback) => fallback
    };
    return { host: value, log, asked };
  }

  it('runs Trim at the click and needs no value', () => {
    const { manager, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    const pick = (at?: { x: number; y: number }) =>
      advanceSketchEditPick(
        manager.document,
        sketch(),
        'trim',
        [],
        ids[0]!,
        resolve,
        { at: at ?? null }
      );
    expect(pick()).toMatchObject({ status: 'hint' });
    expect(pick({ x: 5, y: 0 })).toEqual({ status: 'run', picks: [ids[0]] });
  });

  it('asks Mirror and Linear pattern for a line second, and lets a circular pivot snap to its own source', () => {
    const { manager, ids, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'circle', centerX: 0, centerY: 5, radius: 1 }
    ]);
    const [line, circle] = ids as [string, string];
    const pick = (
      kind: 'mirror' | 'linear-pattern' | 'circular-pattern',
      existing: string[],
      objectId: string,
      snapPoint: { objectId: string; point: 'start' | 'end' } | null = null
    ) =>
      advanceSketchEditPick(
        manager.document,
        sketch(),
        kind,
        existing,
        objectId,
        resolve,
        { snapPoint }
      );
    expect(pick('mirror', [line], circle)).toEqual({
      status: 'refuse',
      reason: 'Mirror reflects about a line. Pick a line as the mirror.'
    });
    expect(pick('mirror', [circle], line)).toEqual({
      status: 'run',
      picks: [circle, line]
    });
    expect(pick('linear-pattern', [circle], line)).toMatchObject({
      status: 'value',
      label: 'Pattern spacing',
      unitKind: 'length',
      initial: 10
    });
    expect(pick('circular-pattern', [line], line)).toMatchObject({
      status: 'refuse'
    });
    expect(
      pick('circular-pattern', [line], line, { objectId: line, point: 'start' })
    ).toMatchObject({
      status: 'value',
      picks: [line, `${line}#start`],
      label: 'Pattern count',
      unitKind: 'count'
    });
  });

  it('takes a circular pivot from a centre snap that hit no curve', () => {
    const { manager, ids, sketch } = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    const arc = ids[0]!;
    expect(
      advanceSketchEditPick(
        manager.document,
        sketch(),
        'circular-pattern',
        [arc],
        null,
        resolve,
        { snapPoint: { objectId: arc, point: 'center' } }
      )
    ).toMatchObject({ status: 'value', picks: [arc, `${arc}#center`] });
  });

  it('prefers the active pivot snap over a curve the click also hit', () => {
    const { manager, ids, sketch } = sketchWith([
      { objectKind: 'circle', centerX: 10, centerY: 0, radius: 1 },
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      // A line through the hub's centre, under the same click.
      { objectKind: 'line', x1: -8, y1: 0, x2: 8, y2: 0 }
    ]);
    const [source, hub, line] = ids as [string, string, string];
    expect(
      advanceSketchEditPick(
        manager.document,
        sketch(),
        'circular-pattern',
        [source],
        line,
        resolve,
        { snapPoint: { objectId: hub, point: 'center' } }
      )
    ).toMatchObject({ status: 'value', picks: [source, `${hub}#center`] });
  });

  it('collects a pattern’s two values before committing one transaction', async () => {
    const { manager, ids, sketch } = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 }
    ]);
    const applied: { commands: AnyCommand[]; label: string }[] = [];
    const { host: driver, asked, log } = host(applied);
    const picks = [ids[0]!, ids[1]!];
    await runSketchEdit(
      driver,
      manager.document,
      sketch(),
      'linear-pattern',
      picks,
      6,
      '6',
      { values: [], raws: [] }
    );
    expect(asked).toEqual(['linear-pattern 2 Pattern count 3 count 6']);
    expect(applied).toEqual([]);
    await runSketchEdit(
      driver,
      manager.document,
      sketch(),
      'linear-pattern',
      picks,
      4,
      '4',
      { values: [6], raws: ['6'] }
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]!.label).toBe('Linear pattern');
    expect(log.at(-1)).toBe('Linear pattern added 3 linked circles.');
  });
});
