import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type EntityId as EntityIdT,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  buildConstraint,
  disconnectConstraintIds,
  lockConstraintIds
} from '../apps/web/src/lib/sketch/constraints';

/**
 * S07 relations, solved by the pinned kernel and checked against closed-form
 * geometry rather than the solver's own report: mirror images about an axis,
 * points on a line/circle/arc, a locked point that stays put (and a lock
 * that refuses an edit), and Disconnect freeing exactly one joint.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

function sketchWith(objects: SketchObjectData[]) {
  const manager = new CommandManager(
    createProjectDocument('S07', toUserId('user_s07'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Relations',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds;
  const constrain = (constraint: SketchConstraintData) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  return { manager, sketchId, ids, constrain };
}

function lockAt(
  objectId: string,
  point: 'start' | 'end' | 'center',
  x: number,
  y: number
): SketchConstraintData {
  return {
    constraintKind: 'lock',
    point: { objectId: objectId as never, point },
    x,
    y
  };
}

function line(outcome: SketchSolveOutcome, index: number) {
  const object = outcome.objects[index]!;
  if (object.kind !== 'line') throw new Error('expected a line');
  return object;
}

describe('S07 constraint set on the pinned kernel', () => {
  it('mirrors two points about an axis line', async () => {
    // Axis: the y axis from (0,-10) to (0,10). Point A at (3,4) is free,
    // point B starts at (-1,1) and must land on A's mirror image (-3,4)
    // once A is also locked in place.
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'line', x1: 3, y1: 4, x2: 8, y2: 9 },
      { objectKind: 'line', x1: -1, y1: 1, x2: -8, y2: 9 }
    ]);
    const [axis, a, b] = ids as unknown as [string, string, string];
    constrain({
      constraintKind: 'lock',
      point: { objectId: axis as never, point: 'start' },
      x: 0,
      y: -10
    });
    constrain({
      constraintKind: 'lock',
      point: { objectId: axis as never, point: 'end' },
      x: 0,
      y: 10
    });
    constrain({
      constraintKind: 'lock',
      point: { objectId: a as never, point: 'start' },
      x: 3,
      y: 4
    });
    constrain({
      constraintKind: 'symmetric',
      a: { objectId: a as never, point: 'start' },
      b: { objectId: b as never, point: 'start' },
      axis: axis as never
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    const mirrored = line(outcome, 2);
    expect(mirrored.x1).toBeCloseTo(-3, 9);
    expect(mirrored.y1).toBeCloseTo(4, 9);
    // The locks held the axis and A exactly where they were recorded.
    const held = line(outcome, 0);
    for (const [value, expected] of [
      [held.x1, 0],
      [held.y1, -10],
      [held.x2, 0],
      [held.y2, 10]
    ] as const)
      expect(value).toBeCloseTo(expected, 9);
    expect(line(outcome, 1).x1).toBeCloseTo(3, 9);
    expect(line(outcome, 1).y1).toBeCloseTo(4, 9);
  });

  it('holds a point on a line, a circle and an arc', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      // Fixed references.
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 },
      { objectKind: 'circle', centerX: 30, centerY: 0, radius: 5 },
      {
        objectKind: 'arc',
        centerX: 60,
        centerY: 0,
        radius: 4,
        startAngleDeg: 0,
        endAngleDeg: 180
      },
      // Movers, each starting off its target.
      { objectKind: 'line', x1: 6, y1: 2, x2: 6, y2: -8 },
      { objectKind: 'line', x1: 30, y1: 1, x2: 30, y2: -20 },
      { objectKind: 'line', x1: 60, y1: 1, x2: 60, y2: -20 }
    ]);
    const [diagonal, circle, arc, m1, m2, m3] = ids as string[];
    for (const [id, point, x, y] of [
      [diagonal, 'start', 0, 0],
      [diagonal, 'end', 10, 10],
      [circle, 'center', 30, 0],
      [arc, 'center', 60, 0],
      [arc, 'start', 64, 0]
    ] as const) {
      constrain({
        constraintKind: 'lock',
        point: { objectId: id as never, point },
        x,
        y
      });
    }
    for (const [mover, target] of [
      [m1, diagonal],
      [m2, circle],
      [m3, arc]
    ]) {
      constrain({
        constraintKind: 'point-on-object',
        point: { objectId: mover as never, point: 'start' },
        objectId: target as never
      });
    }
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    const onLine = line(outcome, 3);
    expect(onLine.x1 - onLine.y1).toBeCloseTo(0, 9); // y = x
    const onCircle = line(outcome, 4);
    expect(Math.hypot(onCircle.x1 - 30, onCircle.y1)).toBeCloseTo(5, 9);
    const onArc = line(outcome, 5);
    expect(Math.hypot(onArc.x1 - 60, onArc.y1)).toBeCloseTo(4, 9);
    // Each residual is reported once per document constraint, even for the
    // two-equation lock.
    const counted = new Map<string, number>();
    for (const { constraintId } of outcome.constraintResiduals)
      counted.set(constraintId, (counted.get(constraintId) ?? 0) + 1);
    expect([...counted.values()].every((n) => n === 1)).toBe(true);
    expect(counted.size).toBe(
      findSketch(manager.document, sketchId)!.constraints!.length
    );
  });

  it('a locked point refuses a driving dimension that would move it', async () => {
    // A 10 mm line with both ends locked cannot also be 20 mm long.
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    const id = ids[0]! as never;
    constrain({
      constraintKind: 'lock',
      point: { objectId: id, point: 'start' },
      x: 0,
      y: 0
    });
    constrain({
      constraintKind: 'lock',
      point: { objectId: id, point: 'end' },
      x: 10,
      y: 0
    });
    constrain({
      constraintKind: 'distance',
      a: { objectId: id, point: 'start' },
      b: { objectId: id, point: 'end' },
      value: 20
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.classification === 'solved' && outcome.converged).toBe(
      false
    );
  });

  it('records a lock at the point’s resolved position and toggles by id', () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 'w', y1: 2, x2: 9, y2: 2 }
    ]);
    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '4' })
    );
    const sketch = findSketch(manager.document, sketchId)!;
    const built = buildConstraint(
      manager.document,
      sketch,
      'lock',
      [{ kind: 'point', objectId: ids[0]!, point: 'start' }],
      undefined,
      (value) => (value === 'w' ? 4 : Number(value))
    );
    if ('error' in built) throw new Error(built.error);
    expect(built.data).toMatchObject({ constraintKind: 'lock', x: 4, y: 2 });
    constrain(built.data);
    const ref = { objectId: ids[0]! as never, point: 'start' as const };
    expect(
      lockConstraintIds(findSketch(manager.document, sketchId)!, ref)
    ).toHaveLength(1);
    // A second lock on the same point is refused by the document.
    expect(() => constrain(built.data)).toThrow(/already locked/);
  });

  it('Disconnect frees one joint and keeps every other relation', async () => {
    // Two lines joined end to start, plus a horizontal relation and a
    // distance on the first line.
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 10, y1: 0, x2: 10, y2: 8 }
    ]);
    const [first, second] = ids as [never, never];
    constrain({
      constraintKind: 'coincident',
      a: { objectId: first, point: 'end' },
      b: { objectId: second, point: 'start' }
    });
    constrain({ constraintKind: 'horizontal', objectId: first });
    constrain({
      constraintKind: 'distance',
      a: { objectId: first, point: 'start' },
      b: { objectId: first, point: 'end' },
      value: 10
    });
    const sketch = findSketch(manager.document, sketchId)!;
    const removals = disconnectConstraintIds(sketch, {
      objectId: second,
      point: 'start'
    });
    expect(removals).toHaveLength(1);
    manager.execute(
      composeCommands(
        'Disconnect point',
        removals.map((constraintId) =>
          commandFactories.deleteSketchConstraint({
            sketchId,
            constraintId: constraintId as never
          })
        )
      )
    );
    const left = findSketch(manager.document, sketchId)!.constraints!;
    expect(left.map((c) => c.data.constraintKind).sort()).toEqual([
      'distance',
      'horizontal'
    ]);
    // Independence, not just a missing icon: drive the second line's start
    // 2 mm away and its former neighbor stays where it was.
    manager.execute(
      commandFactories.updateSketchObject({
        sketchId,
        objectId: second,
        data: { objectKind: 'line', x1: 12, y1: 0, x2: 10, y2: 8 }
      })
    );
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    expect(line(outcome, 0).x2).toBeCloseTo(10, 9);
    expect(line(outcome, 1).x1).toBeCloseTo(12, 9);
    // One undo restores the joint.
    manager.undo();
    manager.undo();
    expect(
      findSketch(manager.document, sketchId)!.constraints!.map(
        (c) => c.data.constraintKind
      )
    ).toContain('coincident');
  });
});

describe('S07 whole-entity symmetry on the pinned kernel', () => {
  const resolve = (value: unknown) =>
    typeof value === 'number' ? value : Number(value);

  /**
   * The y axis locked from (0,-10) to (0,10), the first entity held fully
   * by `hold`, and the second mirrored onto it by the relations one
   * Symmetric pick sequence over the two entities writes.
   */
  async function mirrored(
    first: SketchObjectData,
    second: SketchObjectData,
    hold: (id: string) => SketchConstraintData[]
  ) {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      first,
      second
    ]);
    const [axis, a, b] = fixture.ids as unknown as [string, string, string];
    fixture.constrain(lockAt(axis, 'start', 0, -10));
    fixture.constrain(lockAt(axis, 'end', 0, 10));
    for (const constraint of hold(a)) fixture.constrain(constraint);
    const sketch = findSketch(fixture.manager.document, fixture.sketchId)!;
    const built = buildConstraint(
      fixture.manager.document,
      sketch,
      'symmetric',
      [
        { kind: 'object', objectId: a },
        { kind: 'object', objectId: b },
        { kind: 'object', objectId: axis }
      ],
      undefined,
      resolve
    );
    if ('error' in built) throw new Error(built.error);
    const written = [built.data, ...(built.also ?? [])];
    for (const constraint of written) fixture.constrain(constraint);
    const outcome = await adapter.solveSketch(
      fixture.manager.document,
      fixture.sketchId
    );
    expect(outcome.converged).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    // Each set fixes the image exactly once: no redundant equation.
    expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
    return { outcome, written };
  }

  it('mirrors a whole line, pairing the ends the way they already lie', async () => {
    // The second line runs the other way, so its end is nearer the image of
    // the first's start: the pairing crosses, and the line does not flip.
    const { outcome, written } = await mirrored(
      { objectKind: 'line', x1: 2, y1: 1, x2: 6, y2: 5 },
      { objectKind: 'line', x1: -5, y1: 4, x2: -1, y2: 2 },
      (id) => [lockAt(id, 'start', 2, 1), lockAt(id, 'end', 6, 5)]
    );
    expect(written.map((data) => data.constraintKind)).toEqual([
      'symmetric',
      'symmetric'
    ]);
    expect(outcome.classification).toBe('solved');
    const image = line(outcome, 2);
    expect(image.x1).toBeCloseTo(-6, 9);
    expect(image.y1).toBeCloseTo(5, 9);
    expect(image.x2).toBeCloseTo(-2, 9);
    expect(image.y2).toBeCloseTo(1, 9);
  });

  it('mirrors a whole circle: centre and radius', async () => {
    const { outcome, written } = await mirrored(
      { objectKind: 'circle', centerX: 4, centerY: 3, radius: 2 },
      { objectKind: 'circle', centerX: -3, centerY: 2, radius: 1 },
      (id) => [
        lockAt(id, 'center', 4, 3),
        { constraintKind: 'radius', objectId: id as never, value: 2 }
      ]
    );
    expect(written.map((data) => data.constraintKind)).toEqual([
      'symmetric',
      'equal'
    ]);
    expect(outcome.classification).toBe('solved');
    const image = outcome.objects[2]!;
    if (image.kind !== 'circle') throw new Error('expected a circle');
    expect(image.centerX).toBeCloseTo(-4, 9);
    expect(image.centerY).toBeCloseTo(3, 9);
    expect(image.radius).toBeCloseTo(2, 9);
  });

  it('refuses a second arc nearer the complement than the mirror image', () => {
    // Review case: about the y axis, the radius-2 arc at (5, 0) sweeping
    // 0°–90° mirrors to one at (-5, 0) sweeping 90°–180°. The radius-2 arc
    // at (-7, 2) sweeping 0°–270° already meets both end symmetries and the
    // equal radius, so the relations alone would keep it.
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      {
        objectKind: 'arc',
        centerX: 5,
        centerY: 0,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      {
        objectKind: 'arc',
        centerX: -7,
        centerY: 2,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 270
      }
    ]);
    const [axis, a, b] = fixture.ids as unknown as [string, string, string];
    const built = buildConstraint(
      fixture.manager.document,
      findSketch(fixture.manager.document, fixture.sketchId)!,
      'symmetric',
      [
        { kind: 'object', objectId: a },
        { kind: 'object', objectId: b },
        { kind: 'object', objectId: axis }
      ],
      undefined,
      resolve
    );
    expect(built).toEqual({
      error:
        "The second arc sweeps 270°, nearer the other way round than the 90° of the first arc's mirror image. Pick an arc of matching sweep, or use Mirror to make the image."
    });
  });

  it('mirrors a whole arc, reversing its direction', async () => {
    // A quarter arc about (5,0) from 0° to 90°: its image about the y axis
    // is centred on (-5,0) and, still counter-clockwise, runs 90° to 180°.
    const { outcome, written } = await mirrored(
      {
        objectKind: 'arc',
        centerX: 5,
        centerY: 0,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      {
        objectKind: 'arc',
        centerX: -4.5,
        centerY: 0.3,
        radius: 1.8,
        startAngleDeg: 95,
        endAngleDeg: 175
      },
      (id) => [
        lockAt(id, 'start', 7, 0),
        lockAt(id, 'end', 5, 2),
        { constraintKind: 'radius', objectId: id as never, value: 2 }
      ]
    );
    expect(written.map((data) => data.constraintKind)).toEqual([
      'symmetric',
      'symmetric',
      'equal'
    ]);
    const image = outcome.objects[2]!;
    if (image.kind !== 'arc') throw new Error('expected an arc');
    expect(image.centerX).toBeCloseTo(-5, 8);
    expect(image.centerY).toBeCloseTo(0, 8);
    expect(image.radius).toBeCloseTo(2, 8);
    const start = ((image.startAngleDeg % 360) + 360) % 360;
    const end = ((image.endAngleDeg % 360) + 360) % 360;
    expect(start).toBeCloseTo(90, 6);
    expect(end).toBeCloseTo(180, 6);
  });
});

describe('S07 entity lock on the pinned kernel', () => {
  const resolve = (value: unknown) =>
    typeof value === 'number' ? value : Number(value);

  function lockedWhole(object: SketchObjectData) {
    const fixture = sketchWith([object]);
    const sketch = findSketch(fixture.manager.document, fixture.sketchId)!;
    const built = buildConstraint(
      fixture.manager.document,
      sketch,
      'lock',
      [{ kind: 'object', objectId: fixture.ids[0]! }],
      undefined,
      resolve
    );
    if ('error' in built) throw new Error(built.error);
    fixture.constrain(built.data);
    return { ...fixture, data: built.data };
  }

  const solve = (fixture: ReturnType<typeof sketchWith>) =>
    adapter.solveSketch(fixture.manager.document, fixture.sketchId);

  it('holds a whole line, circle and arc with exactly their freedoms', async () => {
    const cases: [SketchObjectData, number[]][] = [
      [{ objectKind: 'line', x1: 1, y1: 2, x2: 7, y2: 5 }, [1, 2, 7, 5]],
      [
        { objectKind: 'circle', centerX: 3, centerY: -1, radius: 2 },
        [3, -1, 2]
      ],
      // Ends near the x axis (the end's y is fixed), near the y axis (its x
      // is), and diagonal: every branch of the arc's one end coordinate.
      ...[
        [10, 80],
        [30, 175],
        [-40, 45]
      ].map(
        ([start, end]) =>
          [
            {
              objectKind: 'arc',
              centerX: 4,
              centerY: 4,
              radius: 3,
              startAngleDeg: start!,
              endAngleDeg: end!
            },
            [4, 4, 3, start!, end!]
          ] as [SketchObjectData, number[]]
      )
    ];
    for (const [object, at] of cases) {
      const fixture = lockedWhole(object);
      expect(fixture.data).toEqual({
        constraintKind: 'lock-entity',
        objectId: fixture.ids[0],
        at
      });
      const outcome = await solve(fixture);
      expect(outcome.converged).toBe(true);
      expect(outcome.classification).toBe('solved');
      expect(outcome.dof.dof).toBe(0);
      // Never redundant with itself.
      expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
      // One residual row for the one document constraint.
      expect(outcome.constraintResiduals).toHaveLength(1);
    }
  });

  it('refuses a driving dimension that would resize a locked circle', async () => {
    const fixture = lockedWhole({
      objectKind: 'circle',
      centerX: 0,
      centerY: 0,
      radius: 2
    });
    fixture.constrain({
      constraintKind: 'radius',
      objectId: fixture.ids[0]!,
      value: 3
    });
    const outcome = await solve(fixture);
    expect(outcome.classification === 'solved' && outcome.converged).toBe(
      false
    );
  });

  it('keeps a locked arc where it is while joined geometry moves to it', async () => {
    const fixture = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      { objectKind: 'line', x1: 7, y1: 1, x2: 12, y2: 3 }
    ]);
    const [arc, bar] = fixture.ids as unknown as [string, string];
    const sketch = findSketch(fixture.manager.document, fixture.sketchId)!;
    const built = buildConstraint(
      fixture.manager.document,
      sketch,
      'lock',
      [{ kind: 'object', objectId: arc }],
      undefined,
      resolve
    );
    if ('error' in built) throw new Error(built.error);
    fixture.constrain(built.data);
    fixture.constrain({
      constraintKind: 'coincident',
      a: { objectId: arc as never, point: 'start' },
      b: { objectId: bar as never, point: 'start' }
    });
    const outcome = await solve(fixture);
    expect(outcome.converged).toBe(true);
    const held = outcome.objects[0]!;
    if (held.kind !== 'arc') throw new Error('expected an arc');
    expect(held.centerX).toBeCloseTo(0, 9);
    expect(held.centerY).toBeCloseTo(0, 9);
    expect(held.radius).toBeCloseTo(5, 9);
    expect(held.startAngleDeg).toBeCloseTo(0, 7);
    expect(held.endAngleDeg).toBeCloseTo(90, 7);
    expect(line(outcome, 1).x1).toBeCloseTo(5, 9);
    expect(line(outcome, 1).y1).toBeCloseTo(0, 9);
  });

  it('validates the entity, its recorded geometry and its point locks', () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
      { objectKind: 'circle', centerX: 9, centerY: 0, radius: 1 }
    ]);
    const [line, circle] = fixture.ids as unknown as [EntityIdT, EntityIdT];
    const lockLine: SketchConstraintData = {
      constraintKind: 'lock-entity',
      objectId: line,
      at: [0, 0, 4, 0]
    };
    expect(() => fixture.constrain({ ...lockLine, at: [0, 0, 4] })).toThrow(
      'A locked line needs its 4 recorded finite values.'
    );
    expect(() =>
      fixture.constrain({
        constraintKind: 'lock-entity',
        objectId: circle,
        at: [9, 0, 0]
      })
    ).toThrow('A locked circle needs a positive radius.');
    fixture.constrain(lockAt(line, 'start', 0, 0));
    // A whole lock beside a point lock would hold that point twice.
    expect(() => fixture.constrain(lockLine)).toThrow(/has a locked point/);
    const sketchId = fixture.sketchId;
    const pointLock = findSketch(fixture.manager.document, sketchId)!
      .constraints![0]!.constraintId;
    fixture.manager.execute(
      composeCommands('Lock entity', [
        commandFactories.deleteSketchConstraint({
          sketchId,
          constraintId: pointLock
        }),
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: lockLine
        })
      ])
    );
    expect(() => fixture.constrain(lockLine)).toThrow(
      'That entity is already locked.'
    );
    expect(() => fixture.constrain(lockAt(line, 'end', 4, 0))).toThrow(
      'That point belongs to a locked entity. Unlock the entity first.'
    );
  });

  it('needs schema v138: an older stamp refuses a document that holds one', () => {
    const fixture = lockedWhole({
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: 4,
      y2: 0
    });
    const saved = JSON.parse(
      JSON.stringify(fixture.manager.document)
    ) as ProjectDocument;
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(138);
    expect(normalizeDocument(saved)).toEqual(fixture.manager.document);
    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: 137 as typeof saved.schemaVersion
      })
    ).toThrow(/Sketch entity locks/);
  });
});

describe('S07 schema boundary', () => {
  it('stamps the current schema, opens a v17 document unchanged and refuses a newer one', () => {
    const { manager, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    constrain({
      constraintKind: 'lock',
      point: { objectId: ids[0]!, point: 'start' },
      x: 0,
      y: 0
    });
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    // A v17 client compares this stamp and refuses the document, rather
    // than solving without the lock it cannot read.
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(normalizeDocument(saved)).toEqual(manager.document);

    const legacy = structuredClone(manager.document);
    const sketch = findSketch(legacy, legacy.sketchOrder[0]!)!;
    sketch.constraints = [];
    legacy.schemaVersion = 17 as typeof legacy.schemaVersion;
    const opened = normalizeDocument(legacy);
    expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect({ ...opened, schemaVersion: 17 }).toEqual(legacy);

    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: (PROJECT_DOCUMENT_SCHEMA_VERSION +
          1) as typeof saved.schemaVersion
      })
    ).toThrow(
      `Unsupported project schema (v${PROJECT_DOCUMENT_SCHEMA_VERSION + 1})`
    );
  });
});
