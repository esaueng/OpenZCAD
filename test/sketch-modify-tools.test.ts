import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  normalizeDocument,
  rewriteNodeExpressions
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type EntityId,
  type ProjectDocument,
  type ParamValue,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  planSketchCircularPattern,
  planSketchExtend,
  planSketchLinearPattern,
  planSketchMirror,
  planSketchTrim,
  settleOptionalRelations,
  type SketchModifyPlan
} from '../apps/web/src/lib/sketch/modify';
import {
  compositeCommands,
  cornerRectangleShape
} from '../apps/web/src/lib/sketch/composites';
import {
  planSketchOffset,
  type SketchOffsetPick
} from '../apps/web/src/lib/sketch/offset';
import { sketchEntityEditCommands } from '../apps/web/src/lib/sketch/editing';

/**
 * S05 Trim, Mirror and patterns on the pinned kernel's solver: the relations
 * each tool writes must be ones the solver satisfies without calling them
 * redundant, and must carry an edit of the source through to what the tool
 * made from it. Checked against closed-form geometry.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const resolve = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);

function sketchWith(objects: SketchObjectData[]) {
  const manager = new CommandManager(
    createProjectDocument('S05', toUserId('user_s05'))
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
  const sketch = () => findSketch(manager.document, sketchId)!;
  const constrain = (constraint: SketchConstraintData) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  /** Commit a plan the way the app does, optional relations settled. */
  const commit = async (plan: SketchModifyPlan) => {
    if (plan.status !== 'commands') throw new Error(plan.reason);
    const commands = await settleOptionalRelations(
      manager.document,
      sketchId,
      plan.commands,
      plan.optional ?? [],
      (document, id) => adapter.solveSketch(document, id)
    );
    manager.execute(composeCommands(plan.label, commands));
  };
  const solve = () => adapter.solveSketch(manager.document, sketchId);
  return { manager, sketchId, ids, sketch, constrain, commit, solve };
}

function solved(outcome: SketchSolveOutcome, objectId: string) {
  const object = outcome.objects.find((entry) => entry.objectId === objectId);
  if (!object) throw new Error(`no solved object ${objectId}`);
  return object as unknown as Record<string, number>;
}

function expectGood(outcome: SketchSolveOutcome) {
  expect(outcome.converged).toBe(true);
  expect(outcome.rolledBack).toBe(false);
  expect(['solved', 'underConstrained']).toContain(outcome.classification);
  expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
}

const lock = (
  objectId: string,
  point: 'start' | 'end' | 'center',
  x: number,
  y: number
) =>
  ({
    constraintKind: 'lock',
    point: { objectId: objectId as EntityId, point },
    x,
    y
  }) as const;

describe('S05 modify tools on the pinned kernel', () => {
  it('a mirrored line and arc follow their sources across the axis', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'line', x1: 2, y1: 1, x2: 6, y2: 5 },
      {
        objectKind: 'arc',
        centerX: 5,
        centerY: -4,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    const [axis, line, arc] = fixture.ids as [string, string, string];
    fixture.constrain(lock(axis, 'start', 0, -10));
    fixture.constrain(lock(axis, 'end', 0, 10));
    for (const source of [line, arc]) {
      await fixture.commit(
        planSketchMirror(
          fixture.manager.document,
          fixture.sketch(),
          fixture.sketchId,
          source,
          axis,
          resolve
        )
      );
    }
    const [lineImage, arcImage] = fixture
      .sketch()
      .objectIds.map(String)
      .slice(3);
    const first = await fixture.solve();
    expectGood(first);
    expect(solved(first, lineImage!)).toMatchObject({ x1: -2, y1: 1 });

    // Pin the source somewhere new; the images must land on its mirror.
    fixture.constrain(lock(line, 'start', 3, 2));
    fixture.constrain(lock(line, 'end', 7, 8));
    fixture.constrain({
      constraintKind: 'radius',
      objectId: arc as EntityId,
      value: 3
    });
    const moved = await fixture.solve();
    expectGood(moved);
    const image = solved(moved, lineImage!);
    for (const [value, expected] of [
      [image.x1, -3],
      [image.y1, 2],
      [image.x2, -7],
      [image.y2, 8]
    ] as const)
      expect(value).toBeCloseTo(expected, 6);
    const sourceArc = solved(moved, arc);
    const imageArc = solved(moved, arcImage!);
    expect(imageArc.radius).toBeCloseTo(3, 6);
    expect(imageArc.centerX).toBeCloseTo(-sourceArc.centerX!, 6);
    expect(imageArc.centerY).toBeCloseTo(sourceArc.centerY!, 6);
  });

  it('a mirrored end that starts on the axis stays on it, joined to its image', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      { objectKind: 'line', x1: 0, y1: 2, x2: 6, y2: 5 }
    ]);
    const [axis, line] = fixture.ids as [string, string];
    fixture.constrain(lock(axis, 'start', 0, -10));
    fixture.constrain(lock(axis, 'end', 0, 10));
    await fixture.commit(
      planSketchMirror(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        line,
        axis,
        resolve
      )
    );
    const image = fixture.sketch().objectIds.map(String).at(-1)!;
    // Move the free end and lengthen the source: the joint must slide
    // along the axis rather than leave it with its image.
    fixture.constrain(lock(line, 'end', 7, 8));
    fixture.constrain({
      constraintKind: 'distance',
      a: { objectId: line as EntityId, point: 'start' },
      b: { objectId: line as EntityId, point: 'end' },
      value: 10
    });
    const outcome = await fixture.solve();
    expectGood(outcome);
    const source = solved(outcome, line);
    const mirrored = solved(outcome, image);
    expect(source.x1).toBeCloseTo(0, 6);
    expect(
      Math.hypot(source.x2! - source.x1!, source.y2! - source.y1!)
    ).toBeCloseTo(10, 6);
    expect(mirrored.x1).toBeCloseTo(0, 6);
    expect(mirrored.y1).toBeCloseTo(source.y1!, 6);
    expect(mirrored.x2).toBeCloseTo(-7, 6);
    expect(mirrored.y2).toBeCloseTo(8, 6);
  });

  it('a split line stays one straight line whose cut ends ride their cutters', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
      { objectKind: 'line', x1: 10, y1: -5, x2: 10, y2: 5 },
      { objectKind: 'line', x1: 20, y1: -5, x2: 20, y2: 5 }
    ]);
    const [target, left, right] = fixture.ids as [string, string, string];
    await fixture.commit(
      planSketchTrim(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        target,
        { x: 15, y: 0 },
        resolve
      )
    );
    const piece = fixture.sketch().objectIds.map(String).at(-1)!;
    expectGood(await fixture.solve());

    // Tilt the kept piece and move both cutters: the far piece stays on
    // the same line and both cut ends follow their cutters.
    fixture.constrain(lock(target, 'start', 0, 0));
    fixture.constrain({
      constraintKind: 'angle',
      a: target as EntityId,
      b: left as EntityId,
      valueDeg: 80
    });
    for (const [cutter, x] of [
      [left, 12],
      [right, 22]
    ] as const) {
      fixture.constrain(lock(cutter, 'start', x, -5));
      fixture.constrain(lock(cutter, 'end', x, 5));
    }
    const outcome = await fixture.solve();
    expectGood(outcome);
    const kept = solved(outcome, target);
    const far = solved(outcome, piece);
    expect(kept.x2).toBeCloseTo(12, 6);
    expect(far.x1).toBeCloseTo(22, 6);
    // Collinear: both far-piece points lie on the kept piece's line.
    const cross = (x: number, y: number) =>
      (kept.x2! - kept.x1!) * (y - kept.y1!) -
      (kept.y2! - kept.y1!) * (x - kept.x1!);
    expect(cross(far.x1!, far.y1!)).toBeCloseTo(0, 6);
    expect(cross(far.x2!, far.y2!)).toBeCloseTo(0, 6);
  });

  it('an extended line and arc end ride the boundary they reached', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
      { objectKind: 'line', x1: 10, y1: -8, x2: 10, y2: 8 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 6,
        startAngleDeg: 60,
        endAngleDeg: 120
      },
      { objectKind: 'line', x1: -9, y1: -2, x2: 9, y2: -2 }
    ]);
    const [line, wall, arc, floor] = fixture.ids as [
      string,
      string,
      string,
      string
    ];
    fixture.constrain({
      constraintKind: 'horizontal',
      objectId: line as EntityId
    });
    fixture.constrain(lock(line, 'start', 0, 0));
    await fixture.commit(
      planSketchExtend(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        line,
        { x: 4, y: 0 },
        resolve
      )
    );
    await fixture.commit(
      planSketchExtend(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        arc,
        { x: -3, y: 5.2 },
        resolve
      )
    );
    expectGood(await fixture.solve());

    // Move both boundaries: the line's end stays on the wall at its new x,
    // the arc's end stays on the floor's new height.
    for (const [cutter, a, b] of [
      [wall, { x: 13, y: -8 }, { x: 13, y: 8 }],
      [floor, { x: -9, y: -3 }, { x: 9, y: -3 }]
    ] as const) {
      fixture.constrain(lock(cutter, 'start', a.x, a.y));
      fixture.constrain(lock(cutter, 'end', b.x, b.y));
    }
    // Centre and start held: the radius is fixed by them.
    fixture.constrain(lock(arc, 'center', 0, 0));
    fixture.constrain(lock(arc, 'start', 3, 6 * Math.sin(Math.PI / 3)));
    const outcome = await fixture.solve();
    expectGood(outcome);
    expect(solved(outcome, line).x2).toBeCloseTo(13, 6);
    expect(solved(outcome, line).y2).toBeCloseTo(0, 6);
    const end = solved(outcome, arc).endAngleDeg!;
    expect(6 * Math.sin((end * Math.PI) / 180)).toBeCloseTo(-3, 6);
  });

  it('a trimmed circle keeps its radius relation as an arc', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      { objectKind: 'line', x1: 3, y1: -10, x2: 3, y2: 10 }
    ]);
    const [circle] = fixture.ids as [string];
    fixture.constrain({
      constraintKind: 'radius',
      objectId: circle as EntityId,
      value: 5
    });
    await fixture.commit(
      planSketchTrim(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        { x: 5, y: 0 },
        resolve
      )
    );
    const arc = fixture.sketch().objectIds.map(String).at(-1)!;
    const outcome = await fixture.solve();
    expectGood(outcome);
    expect(solved(outcome, arc).radius).toBeCloseTo(5, 9);
  });

  it('pattern instances resize with their source', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 20, y1: 0, x2: 20, y2: 4 }
    ]);
    const [circle, direction, bar] = fixture.ids as [string, string, string];
    await fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        5,
        3,
        resolve
      )
    );
    await fixture.commit(
      planSketchCircularPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        bar,
        { x: 0, y: 0 },
        4,
        360,
        resolve
      )
    );
    const copies = fixture.sketch().objectIds.map(String).slice(3);
    expect(copies).toHaveLength(5);
    expectGood(await fixture.solve());
    fixture.constrain({
      constraintKind: 'radius',
      objectId: circle as EntityId,
      value: 2
    });
    fixture.constrain(lock(bar, 'start', 20, 0));
    fixture.constrain({
      constraintKind: 'distance',
      a: { objectId: bar as EntityId, point: 'start' },
      b: { objectId: bar as EntityId, point: 'end' },
      value: 6
    });
    const outcome = await fixture.solve();
    expectGood(outcome);
    for (const copy of copies.slice(0, 2)) {
      expect(solved(outcome, copy).radius).toBeCloseTo(2, 6);
    }
    for (const copy of copies.slice(2)) {
      const line = solved(outcome, copy);
      expect(Math.hypot(line.x2! - line.x1!, line.y2! - line.y1!)).toBeCloseTo(
        6,
        6
      );
    }
  });
});

describe('S05 pattern settings on the pinned kernel', () => {
  it('uniform instances stay parallel to and as long as their source', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 9, y1: -1, x2: 11, y2: 1 }
    ]);
    const [bar] = fixture.ids as [string];
    await fixture.commit(
      planSketchCircularPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        bar,
        { x: 0, y: 0 },
        4,
        360,
        resolve,
        'uniform'
      )
    );
    const copies = fixture.sketch().objectIds.map(String).slice(1);
    expectGood(await fixture.solve());
    // Turn and stretch the source: every instance follows its direction and
    // length, not the rotated ones a turning pattern would hold.
    fixture.constrain(lock(bar, 'start', 10, 0));
    fixture.constrain(lock(bar, 'end', 10, 6));
    const outcome = await fixture.solve();
    expectGood(outcome);
    for (const copy of copies) {
      const line = solved(outcome, copy);
      expect(line.x2! - line.x1!).toBeCloseTo(0, 6);
      expect(Math.abs(line.y2! - line.y1!)).toBeCloseTo(6, 6);
    }
  });

  it('an extent-spaced pattern solves like the step-spaced one it equals', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    const [circle, direction] = fixture.ids as [string, string];
    await fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        10,
        3,
        resolve,
        'extent'
      )
    );
    const outcome = await fixture.solve();
    expectGood(outcome);
    const copies = fixture.sketch().objectIds.map(String).slice(2);
    expect(copies.map((copy) => solved(outcome, copy).centerX)).toEqual([
      expect.closeTo(5, 9),
      expect.closeTo(10, 9)
    ]);
  });
});

describe('S05 Mirror holds an on-axis joint only when the solver needs it', () => {
  type Fixture = ReturnType<typeof sketchWith>;
  const point = (objectId: string, name: 'start' | 'end' | 'center') => ({
    objectId: objectId as EntityId,
    point: name
  });
  const pointOns = (fixture: Fixture) =>
    (fixture.sketch().constraints ?? []).filter(
      (constraint) => constraint.data.constraintKind === 'point-on-object'
    ).length;
  const lockAxis = (fixture: Fixture, axis: string) => {
    fixture.constrain(lock(axis, 'start', 0, -10));
    fixture.constrain(lock(axis, 'end', 0, 10));
  };

  // The axis is x = 0 from y = -10 to 10; the source's start sits on it.
  const cases: {
    name: string;
    objects?: SketchObjectData[];
    setup: (fixture: Fixture, axis: string, source: string) => void;
    /** Which object to mirror, when not the line from (0, 2). */
    mirrored?: number;
    added: number;
  }[] = [
    {
      name: 'an axis fixed by vertical and a length, with the point locked',
      setup: (fixture, axis, source) => {
        fixture.constrain({
          constraintKind: 'vertical',
          objectId: axis as EntityId
        });
        fixture.constrain(lock(axis, 'start', 0, -10));
        fixture.constrain({
          constraintKind: 'distance',
          a: point(axis, 'start'),
          b: point(axis, 'end'),
          value: 20
        });
        fixture.constrain(lock(source, 'start', 0, 2));
      },
      added: 0
    },
    {
      name: 'an axis fixed by an angle to a locked line, with the point locked',
      objects: [{ objectKind: 'line', x1: -5, y1: -10, x2: 5, y2: -10 }],
      setup: (fixture, axis, source) => {
        const reference = fixture.ids[2]!;
        fixture.constrain(lock(reference, 'start', -5, -10));
        fixture.constrain(lock(reference, 'end', 5, -10));
        fixture.constrain(lock(axis, 'start', 0, -10));
        fixture.constrain({
          constraintKind: 'angle',
          a: reference as EntityId,
          b: axis as EntityId,
          valueDeg: 90
        });
        fixture.constrain({
          constraintKind: 'distance',
          a: point(axis, 'start'),
          b: point(axis, 'end'),
          value: 20
        });
        fixture.constrain(lock(source, 'start', 0, 2));
      },
      added: 0
    },
    {
      name: 'a point already held on the axis',
      setup: (fixture, axis, source) => {
        fixture.constrain({
          constraintKind: 'point-on-object',
          point: point(source, 'start'),
          objectId: axis as EntityId
        });
      },
      added: 0
    },
    {
      name: 'a point held at the axis midpoint',
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 6, y2: 5 }],
      setup: (fixture, axis) => {
        fixture.constrain({
          constraintKind: 'midpoint',
          point: point(fixture.ids[2]!, 'start'),
          line: axis as EntityId
        });
      },
      mirrored: 2,
      added: 0
    },
    {
      name: 'a point joined to an axis end',
      objects: [{ objectKind: 'line', x1: 0, y1: 10, x2: 6, y2: 5 }],
      setup: (fixture, axis) => {
        fixture.constrain({
          constraintKind: 'coincident',
          a: point(fixture.ids[2]!, 'start'),
          b: point(axis, 'end')
        });
      },
      mirrored: 2,
      added: 0
    },
    {
      name: 'a point held through a coincident neighbour',
      objects: [{ objectKind: 'line', x1: -3, y1: 6, x2: 0, y2: 2 }],
      setup: (fixture, axis, source) => {
        const neighbour = fixture.ids[2]!;
        fixture.constrain({
          constraintKind: 'coincident',
          a: point(source, 'start'),
          b: point(neighbour, 'end')
        });
        fixture.constrain({
          constraintKind: 'point-on-object',
          point: point(neighbour, 'end'),
          objectId: axis as EntityId
        });
      },
      added: 0
    },
    {
      name: 'a locked point on a locked axis',
      setup: (fixture, axis, source) => {
        lockAxis(fixture, axis);
        fixture.constrain(lock(source, 'start', 0, 2));
      },
      added: 0
    },
    {
      name: 'a locked point on a free axis',
      setup: (fixture, _axis, source) => {
        fixture.constrain(lock(source, 'start', 0, 2));
      },
      added: 1
    },
    {
      name: 'a free point on a locked axis',
      setup: (fixture, axis) => lockAxis(fixture, axis),
      added: 1
    }
  ];

  for (const { name, objects = [], setup, mirrored = 1, added } of cases) {
    it(`${added ? 'adds' : 'skips'} the axis hold for ${name}`, async () => {
      const fixture = sketchWith([
        { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
        { objectKind: 'line', x1: 0, y1: 2, x2: 6, y2: 5 },
        ...objects
      ]);
      const axis = fixture.ids[0]!;
      const source = fixture.ids[mirrored]!;
      setup(fixture, axis, fixture.ids[1]!);
      expectGood(await fixture.solve());
      const before = pointOns(fixture);
      await fixture.commit(
        planSketchMirror(
          fixture.manager.document,
          fixture.sketch(),
          fixture.sketchId,
          source,
          axis,
          resolve
        )
      );
      expect(pointOns(fixture) - before).toBe(added);
      expectGood(await fixture.solve());
    });
  }

  it('settles each end of an arc on the axis separately', async () => {
    // Where a radius-5 circle about (2, 0) crosses x = 0.
    const ON_AXIS_DEG = (Math.atan2(Math.sqrt(21), -2) * 180) / Math.PI;
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: -10, x2: 0, y2: 10 },
      // Centred off the axis: a semicircle's chord is a diameter, where an
      // equal radius stops fixing the image's centre and loses rank.
      {
        objectKind: 'arc',
        centerX: 2,
        centerY: 0,
        radius: 5,
        startAngleDeg: -ON_AXIS_DEG,
        endAngleDeg: ON_AXIS_DEG
      }
    ]);
    const [axis, arc] = fixture.ids as [string, string];
    lockAxis(fixture, axis);
    fixture.constrain({
      constraintKind: 'point-on-object',
      point: point(arc, 'start'),
      objectId: axis as EntityId
    });
    expectGood(await fixture.solve());
    await fixture.commit(
      planSketchMirror(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        arc,
        axis,
        resolve
      )
    );
    // The held start needs nothing more; the free end gets its hold.
    const holds = (fixture.sketch().constraints ?? []).flatMap(({ data }) =>
      data.constraintKind === 'point-on-object' ? [data.point.point] : []
    );
    expect(holds).toEqual(['start', 'end']);
    expectGood(await fixture.solve());
  });
});

describe('S05 Offset on the pinned kernel', () => {
  const offsetPlan = (
    fixture: ReturnType<typeof sketchWith>,
    seed: string,
    distance: number,
    pick: SketchOffsetPick
  ) =>
    planSketchOffset(
      fixture.manager.document,
      fixture.sketch(),
      fixture.sketchId,
      seed,
      distance,
      pick,
      resolve
    );

  for (const join of ['miter', 'round'] as const) {
    it(`links a ${join} offset of a drawn rectangle without a redundant relation`, async () => {
      const fixture = sketchWith([]);
      const shape = cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!;
      const drawn = compositeCommands(shape, {
        kind: 'sketch',
        sketchId: fixture.sketchId
      });
      fixture.manager.execute(composeCommands(drawn.label, drawn.commands));
      expectGood(await fixture.solve());
      await fixture.commit(
        offsetPlan(fixture, String(drawn.edgeIds[0]!), 1, {
          join,
          chain: true,
          side: 1
        })
      );
      const outcome = await fixture.solve();
      expectGood(outcome);
      // Every new line still sits 1 from its side: the solve moved nothing.
      const added = fixture
        .sketch()
        .objectIds.map(String)
        .filter((id) => !fixture.ids.includes(id))
        .filter((id) => !drawn.edgeIds.map(String).includes(id))
        .map((id) => solved(outcome, id));
      const xs = added.flatMap((object) =>
        'x1' in object ? [object.x1, object.x2!] : []
      );
      expect(Math.min(...xs)).toBeCloseTo(-1, 9);
      expect(Math.max(...xs)).toBeCloseTo(21, 9);
    });
  }

  /** Re-drive the one offset dimension, as editing its value does. */
  const setOffset = (
    fixture: ReturnType<typeof sketchWith>,
    value: number | string
  ) => {
    const existing = fixture
      .sketch()
      .constraints!.find(({ data }) => data.constraintKind === 'offset')!;
    if (existing.data.constraintKind !== 'offset') throw new Error('no offset');
    fixture.manager.execute(
      composeCommands('Edit offset dimension', [
        commandFactories.deleteSketchConstraint({
          sketchId: fixture.sketchId,
          constraintId: existing.constraintId
        }),
        commandFactories.addSketchConstraint({
          sketchId: fixture.sketchId,
          constraint: { ...existing.data, value },
          ids: { constraintId: existing.constraintId }
        })
      ])
    );
    return existing.data;
  };

  for (const join of ['miter', 'round'] as const) {
    it(`re-offsets a ${join} rectangle when its offset dimension changes`, async () => {
      const fixture = sketchWith([]);
      const shape = cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!;
      const drawn = compositeCommands(shape, {
        kind: 'sketch',
        sketchId: fixture.sketchId
      });
      fixture.manager.execute(composeCommands(drawn.label, drawn.commands));
      await fixture.commit(
        offsetPlan(fixture, String(drawn.edgeIds[0]!), 1, {
          join,
          chain: true,
          side: 1
        })
      );
      // Hold the source rectangle by two opposite corners (its four
      // freedoms), then drive the offset from 1 to 2.5.
      fixture.constrain(lock(String(drawn.edgeIds[0]!), 'start', 0, 0));
      fixture.constrain(lock(String(drawn.edgeIds[2]!), 'start', 20, 12));
      const data = setOffset(fixture, 2.5);
      expect(data.pairs).toHaveLength(4);
      const outcome = await fixture.solve();
      expectGood(outcome);
      const added = fixture
        .sketch()
        .objectIds.map(String)
        .filter((id) => !drawn.edgeIds.map(String).includes(id))
        .map((id) => solved(outcome, id));
      const lines = added.filter((object) => 'x1' in object);
      const xs = lines.flatMap((object) => [object.x1!, object.x2!]);
      const ys = lines.flatMap((object) => [object.y1!, object.y2!]);
      expect(Math.min(...xs)).toBeCloseTo(-2.5, 8);
      expect(Math.max(...xs)).toBeCloseTo(22.5, 8);
      expect(Math.min(...ys)).toBeCloseTo(-2.5, 8);
      expect(Math.max(...ys)).toBeCloseTo(14.5, 8);
      if (join === 'round') {
        // The round joins follow: radius-2.5 arcs about the source corners.
        const arcs = added.filter((object) => 'radius' in object);
        expect(arcs).toHaveLength(4);
        for (const arc of arcs) expect(arc.radius).toBeCloseTo(2.5, 8);
      }
    });
  }

  it('drives a circle and an arc offset, inward and outward, from their dimension', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      {
        objectKind: 'arc',
        centerX: 20,
        centerY: 0,
        radius: 4,
        startAngleDeg: 10,
        endAngleDeg: 150
      }
    ]);
    const [circle, arc] = fixture.ids as [string, string];
    await fixture.commit(
      offsetPlan(fixture, circle, -1, { join: 'miter', chain: true, side: 1 })
    );
    const circleCopy = fixture.sketch().objectIds.map(String).at(-1)!;
    fixture.constrain(lock(circle, 'center', 0, 0));
    fixture.constrain({
      constraintKind: 'radius',
      objectId: circle as EntityId,
      value: 5
    });
    expect(setOffset(fixture, 2).pairs).toEqual([
      { source: circle, copy: circleCopy, side: -1 }
    ]);
    let outcome = await fixture.solve();
    expectGood(outcome);
    expect(solved(outcome, circleCopy).radius).toBeCloseTo(3, 8);
    expect(solved(outcome, circleCopy).centerX).toBeCloseTo(0, 8);

    const arcFixture = sketchWith([
      {
        objectKind: 'arc',
        centerX: 20,
        centerY: 0,
        radius: 4,
        startAngleDeg: 10,
        endAngleDeg: 150
      }
    ]);
    const lone = arcFixture.ids[0]!;
    await arcFixture.commit(
      offsetPlan(arcFixture, lone, 1, { join: 'miter', chain: false, side: 1 })
    );
    const arcCopy = arcFixture.sketch().objectIds.map(String).at(-1)!;
    arcFixture.constrain(lock(lone, 'center', 20, 0));
    arcFixture.constrain({
      constraintKind: 'radius',
      objectId: lone as EntityId,
      value: 4
    });
    setOffset(arcFixture, 1.5);
    outcome = await arcFixture.solve();
    expectGood(outcome);
    // Offset outward of an arc picked on its outside: radius 4 + 1.5.
    const copied = solved(outcome, arcCopy);
    expect(Math.abs(copied.radius! - 4)).toBeCloseTo(1.5, 8);
    expect(copied.centerX).toBeCloseTo(20, 8);
    void arc;
  });

  it('needs schema v146: an older stamp refuses a document with an offset dimension', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
    ]);
    await fixture.commit(
      offsetPlan(fixture, fixture.ids[0]!, 1, {
        join: 'miter',
        chain: true,
        side: 1
      })
    );
    expect(
      fixture
        .sketch()
        .constraints!.some(({ data }) => data.constraintKind === 'offset')
    ).toBe(true);
    const saved = JSON.parse(
      JSON.stringify(fixture.manager.document)
    ) as ProjectDocument;
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(146);
    expect(normalizeDocument(saved)).toEqual(fixture.manager.document);
    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: 145 as typeof saved.schemaVersion
      })
    ).toThrow(/Sketch offset dimensions/);
  });

  it('a dragged source circle carries its offset copies, and a new value moves only the copies', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
    ]);
    const [circle] = fixture.ids as [string];
    await fixture.commit(
      offsetPlan(fixture, circle, 3, { join: 'miter', chain: true, side: 1 })
    );
    const copy = fixture.sketch().objectIds.map(String).at(-1)!;
    const data = (id: string) =>
      (
        fixture.manager.document.nodes[id as EntityId] as unknown as {
          data: Record<string, number>;
        }
      ).data;
    // Drag the source's centre to (10, 0).
    const commands = await sketchEntityEditCommands(
      fixture.manager.document,
      fixture.sketchId,
      circle as EntityId,
      { objectKind: 'circle', centerX: 10, centerY: 0, radius: 5 },
      (document, sketchId, anchor) =>
        adapter.solveSketch(document, sketchId, anchor ? { anchor } : {})
    );
    fixture.manager.runTransaction('Move circle', commands);
    expect(data(circle).centerX).toBe(10);
    expect(data(circle).radius).toBe(5);
    expect(data(copy).centerX).toBeCloseTo(10, 8);
    expect(data(copy).radius).toBeCloseTo(8, 8);

    // A new driving value moves the copy and leaves the free source alone.
    setOffset(fixture, 6);
    const outcome = await fixture.solve();
    expectGood(outcome);
    expect(solved(outcome, circle).radius).toBeCloseTo(5, 8);
    expect(solved(outcome, circle).centerX).toBeCloseTo(10, 8);
    expect(solved(outcome, copy).radius).toBeCloseTo(11, 8);
  });

  it('refuses a round copy on the wrong side of its source', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
    ]);
    const [circle] = fixture.ids as [string];
    await fixture.commit(
      offsetPlan(fixture, circle, 1, { join: 'miter', chain: true, side: 1 })
    );
    const copy = fixture.sketch().objectIds.map(String).at(-1)!;
    fixture.constrain(lock(circle, 'center', 0, 0));
    fixture.constrain({
      constraintKind: 'radius',
      objectId: circle as EntityId,
      value: 5
    });
    expectGood(await fixture.solve());
    // The copy edited inside: radius 4 is 1 from the source too, on the
    // side the relation does not record.
    const inside = structuredClone(fixture.manager.document);
    (
      inside.nodes[copy as EntityId] as unknown as {
        data: Record<string, number>;
      }
    ).data.radius = 4;
    const held = await adapter.solveSketch(inside, fixture.sketchId, {
      anchor: { objectIds: [copy] }
    });
    expect(held.converged).toBe(false);
    expect(held.classification).toBe('unsatisfied');
  });

  it('states a collinear chain corner once, so the offset adds no redundancy', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 5, y2: 0 },
      { objectKind: 'line', x1: 5, y1: 0, x2: 10, y2: 0 }
    ]);
    const [a, b] = fixture.ids as [string, string];
    fixture.constrain({
      constraintKind: 'coincident',
      a: { objectId: a as EntityId, point: 'end' },
      b: { objectId: b as EntityId, point: 'start' }
    });
    expectGood(await fixture.solve());
    await fixture.commit(
      offsetPlan(fixture, a, 1, { join: 'miter', chain: true, side: 1 })
    );
    expect(
      fixture
        .sketch()
        .constraints!.some(({ data }) => data.constraintKind === 'offset')
    ).toBe(true);
    expectGood(await fixture.solve());
  });

  it('re-states a collinear corner once its sources turn apart', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 5, y2: 0 },
      { objectKind: 'line', x1: 5, y1: 0, x2: 10, y2: 0 }
    ]);
    const [a, b] = fixture.ids as [string, string];
    fixture.constrain({
      constraintKind: 'coincident',
      a: { objectId: a as EntityId, point: 'end' },
      b: { objectId: b as EntityId, point: 'start' }
    });
    await fixture.commit(
      offsetPlan(fixture, a, 1, { join: 'miter', chain: true, side: 1 })
    );
    fixture.constrain(lock(a, 'start', 0, 0));
    fixture.constrain(lock(a, 'end', 5, 0));
    // The second source turns up off the first one's carrier.
    fixture.constrain(lock(b, 'end', 10, 5));
    const outcome = await fixture.solve();
    expect(outcome.converged).toBe(true);
    expect(outcome.classification).not.toBe('unsatisfied');
    const copies = fixture
      .sketch()
      .objectIds.map(String)
      .filter((id) => !fixture.ids.includes(id))
      .map((id) => solved(outcome, id))
      .filter((object) => 'x1' in object);
    // Each copy sits 1 to the left of its source at both ends.
    const left = (
      line: { x1: number; y1: number; x2: number; y2: number },
      x: number,
      y: number
    ) =>
      ((line.x2 - line.x1) * (y - line.y1) -
        (line.y2 - line.y1) * (x - line.x1)) /
      Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    const sources = [
      { x1: 0, y1: 0, x2: 5, y2: 0 },
      { x1: 5, y1: 0, x2: 10, y2: 5 }
    ];
    for (const [index, copy] of copies.entries()) {
      const line = copy as unknown as {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      };
      expect(left(sources[index]!, line.x1, line.y1)).toBeCloseTo(1, 7);
      expect(left(sources[index]!, line.x2, line.y2)).toBeCloseTo(1, 7);
    }
  });

  it('refuses a wrong-side round copy even for a tiny offset', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
    ]);
    const [circle] = fixture.ids as [string];
    await fixture.commit(
      offsetPlan(fixture, circle, 1, { join: 'miter', chain: true, side: 1 })
    );
    const copy = fixture.sketch().objectIds.map(String).at(-1)!;
    setOffset(fixture, 4e-8);
    const inside = structuredClone(fixture.manager.document);
    (
      inside.nodes[copy as EntityId] as unknown as {
        data: Record<string, number>;
      }
    ).data.radius = 5 - 4e-8;
    const held = await adapter.solveSketch(inside, fixture.sketchId, {
      anchor: { objectIds: [circle, copy] }
    });
    expect(held.converged).toBe(false);
  });

  it('offsets a full-turn arc to a circle and records the pair', async () => {
    const fixture = sketchWith([
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 360
      }
    ]);
    const [arc] = fixture.ids as [string];
    await fixture.commit(
      offsetPlan(fixture, arc, 1, { join: 'miter', chain: false, side: 1 })
    );
    const offset = fixture
      .sketch()
      .constraints!.find(({ data }) => data.constraintKind === 'offset')!;
    if (offset.data.constraintKind !== 'offset') throw new Error('no offset');
    expect(offset.data.pairs).toHaveLength(1);
    expect(offset.data.pairs[0]!.source).toBe(arc);
    expectGood(await fixture.solve());
  });

  it('follows a renamed parameter and refuses an expression that is not positive', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    const [line] = fixture.ids as [string];
    await fixture.commit(
      offsetPlan(fixture, line, 1, { join: 'miter', chain: false, side: 1 })
    );
    setOffset(fixture, 'gap');
    const sketch = structuredClone(fixture.sketch());
    rewriteNodeExpressions(sketch, (expression) =>
      expression === 'gap' ? 'clearance' : expression
    );
    const renamed = sketch.constraints!.find(
      ({ data }) => data.constraintKind === 'offset'
    )!.data as { value: unknown };
    expect(renamed.value).toBe('clearance');

    setOffset(fixture, '1 - 3');
    await expect(fixture.solve()).rejects.toThrow(
      /offset distance is positive/
    );
  });

  it('holds an offset circle concentric with its source through an edit', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
    ]);
    const source = fixture.ids[0]!;
    await fixture.commit(
      offsetPlan(fixture, source, 1, { join: 'miter', chain: true, side: 1 })
    );
    const copy = fixture.sketch().objectIds.map(String).at(-1)!;
    fixture.constrain(lock(source, 'center', 3, 4));
    const outcome = await fixture.solve();
    expectGood(outcome);
    expect(solved(outcome, copy).centerX).toBeCloseTo(3, 9);
    expect(solved(outcome, copy).centerY).toBeCloseTo(4, 9);
  });
});
