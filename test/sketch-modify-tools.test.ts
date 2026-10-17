import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EntityId,
  type ParamValue,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  planSketchCircularPattern,
  planSketchLinearPattern,
  planSketchMirror,
  planSketchTrim,
  type SketchModifyPlan
} from '../apps/web/src/lib/sketch/modify';

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
  const commit = (plan: SketchModifyPlan) => {
    if (plan.status !== 'commands') throw new Error(plan.reason);
    manager.execute(composeCommands(plan.label, plan.commands));
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
      fixture.commit(
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

  it('a split line stays one straight line whose cut ends ride their cutters', async () => {
    const fixture = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
      { objectKind: 'line', x1: 10, y1: -5, x2: 10, y2: 5 },
      { objectKind: 'line', x1: 20, y1: -5, x2: 20, y2: 5 }
    ]);
    const [target, left, right] = fixture.ids as [string, string, string];
    fixture.commit(
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
    fixture.commit(
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
    fixture.commit(
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
    fixture.commit(
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
