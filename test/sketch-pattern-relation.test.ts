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
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  planSketchCircularPattern,
  planSketchLinearPattern,
  resolvePatternPivot,
  type SketchModifyPlan
} from '../apps/web/src/lib/sketch/modify';
import { sketchEntityEditCommands } from '../apps/web/src/lib/sketch/editing';

/**
 * S05 persistent pattern relation on the pinned kernel: the one relation a
 * pattern writes holds every instance's position as well as its size, so
 * moving or resizing the source carries each instance to its own step, an
 * instance moved alone conflicts, and deleting one leaves the others held.
 * Checked against closed-form positions.
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
      name: 'Pattern',
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

function expectSettled(outcome: SketchSolveOutcome) {
  expect(outcome.converged).toBe(true);
  expect(outcome.rolledBack).toBe(false);
  expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
}

const lock = (
  objectId: string,
  point: 'start' | 'end' | 'center',
  x: number,
  y: number
): SketchConstraintData => ({
  constraintKind: 'lock',
  point: { objectId: objectId as EntityId, point },
  x,
  y
});

describe('S05 pattern relation on the pinned kernel', () => {
  it('adds no freedom: instances move only with the source', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: -3, x2: 10, y2: -3 }
    ]);
    const [circle, direction] = fixture.ids as [string, string];
    const before = await fixture.solve();
    fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        4,
        4,
        resolve
      )
    );
    const after = await fixture.solve();
    expectSettled(after);
    // Three new circles, no new freedom: 3 + 4 before and after.
    expect(before.dof.dof).toBe(7);
    expect(after.dof.dof).toBe(7);
  });

  it('carries every instance to its own step when the source moves and grows', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: -3, x2: 10, y2: -3 }
    ]);
    const [circle, direction] = fixture.ids as [string, string];
    fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        4,
        3,
        resolve
      )
    );
    const copies = fixture.sketch().objectIds.map(String).slice(2);
    fixture.constrain(lock(direction, 'start', 0, -3));
    fixture.constrain(lock(direction, 'end', 10, -3));
    fixture.constrain(lock(circle, 'center', 1, 2));
    fixture.constrain({
      constraintKind: 'radius',
      objectId: circle as EntityId,
      value: 1.5
    });
    const outcome = await fixture.solve();
    expectSettled(outcome);
    expect(outcome.dof.dof).toBe(0);
    copies.forEach((copy, index) => {
      const at = solved(outcome, copy);
      expect(at.centerX).toBeCloseTo(1 + 4 * (index + 1), 8);
      expect(at.centerY).toBeCloseTo(2, 8);
      expect(at.radius).toBeCloseTo(1.5, 8);
    });
  });

  it('an edit that moves the source holds it there and carries every instance', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: -3, x2: 10, y2: -3 }
    ]);
    const [circle, direction] = fixture.ids as [string, string];
    fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        4,
        3,
        resolve
      )
    );
    const copies = fixture.sketch().objectIds.map(String).slice(2);
    fixture.constrain(lock(direction, 'start', 0, -3));
    fixture.constrain(lock(direction, 'end', 10, -3));
    // A drag of the source: a free solve would pull it back toward its
    // instances, so the edit holds what was moved and lets the rest follow.
    const commands = await sketchEntityEditCommands(
      fixture.manager.document,
      fixture.sketchId,
      circle as EntityId,
      { objectKind: 'circle', centerX: 0, centerY: 5, radius: 1 },
      (document, sketchId, anchor) =>
        adapter.solveSketch(document, sketchId, anchor ? { anchor } : {})
    );
    fixture.manager.runTransaction('Move circle', commands);
    const node = (id: string) =>
      fixture.manager.document.nodes[id as EntityId] as unknown as {
        data: Record<string, number>;
      };
    expect(node(circle).data.centerY).toBe(5);
    copies.forEach((copy, index) => {
      expect(node(copy).data.centerX).toBeCloseTo(4 * (index + 1), 8);
      expect(node(copy).data.centerY).toBeCloseTo(5, 8);
    });
    expectSettled(await fixture.solve());
  });

  it('turns rotated line instances with the source, and keeps uniform ones parallel', async () => {
    for (const orientation of ['rotate', 'uniform'] as const) {
      const fixture = sketchWith([
        { objectKind: 'circle', centerX: 0, centerY: 0, radius: 2 },
        { objectKind: 'line', x1: 8, y1: -1, x2: 12, y2: 1 }
      ]);
      const [hub, bar] = fixture.ids as [string, string];
      const pivot = resolvePatternPivot(
        fixture.manager.document,
        fixture.sketch(),
        hub,
        resolve
      );
      if ('error' in pivot) throw new Error(pivot.error);
      fixture.commit(
        planSketchCircularPattern(
          fixture.manager.document,
          fixture.sketch(),
          fixture.sketchId,
          bar,
          pivot.pivot,
          4,
          360,
          resolve,
          orientation,
          pivot.ref
        )
      );
      const copies = fixture.sketch().objectIds.map(String).slice(2);
      expectSettled(await fixture.solve());
      // Hold the hub and set the bar radially from (9, 0) to (13, 0).
      fixture.constrain(lock(hub, 'center', 0, 0));
      fixture.constrain(lock(bar, 'start', 9, 0));
      fixture.constrain(lock(bar, 'end', 13, 0));
      const outcome = await fixture.solve();
      expectSettled(outcome);
      copies.forEach((copy, index) => {
        const turn = ((index + 1) * Math.PI) / 2;
        const line = solved(outcome, copy);
        // The start always turns about the hub; the end turns with it, or
        // keeps the source's +x direction.
        expect(line.x1).toBeCloseTo(9 * Math.cos(turn), 7);
        expect(line.y1).toBeCloseTo(9 * Math.sin(turn), 7);
        const ex =
          orientation === 'rotate'
            ? 13 * Math.cos(turn)
            : 9 * Math.cos(turn) + 4;
        const ey =
          orientation === 'rotate' ? 13 * Math.sin(turn) : 9 * Math.sin(turn);
        expect(line.x2).toBeCloseTo(ex, 7);
        expect(line.y2).toBeCloseTo(ey, 7);
      });
    }
  });

  it('holds a rotated arc pattern’s sweep at every step', async () => {
    const fixture = sketchWith([
      {
        objectKind: 'arc',
        centerX: 10,
        centerY: 0,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      { objectKind: 'point', x: 0, y: 0 }
    ]);
    const [arc, hub] = fixture.ids as [string, string];
    fixture.commit(
      planSketchCircularPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        arc,
        { x: 0, y: 0 },
        3,
        360,
        resolve,
        'rotate',
        { objectId: hub as EntityId, point: 'center' }
      )
    );
    const copies = fixture.sketch().objectIds.map(String).slice(2);
    fixture.constrain(lock(hub, 'center', 0, 0));
    fixture.constrain(lock(arc, 'center', 10, 0));
    fixture.constrain(lock(arc, 'start', 13, 0));
    fixture.constrain({
      constraintKind: 'distance',
      a: { objectId: arc as EntityId, point: 'end' },
      b: { objectId: arc as EntityId, point: 'start' },
      value: 3 * Math.SQRT2
    });
    const outcome = await fixture.solve();
    expectSettled(outcome);
    copies.forEach((copy, index) => {
      const turnDeg = 120 * (index + 1);
      const turn = (turnDeg * Math.PI) / 180;
      const at = solved(outcome, copy);
      expect(at.centerX).toBeCloseTo(10 * Math.cos(turn), 7);
      expect(at.centerY).toBeCloseTo(10 * Math.sin(turn), 7);
      expect(at.radius).toBeCloseTo(3, 7);
      const start = (((at.startAngleDeg! - turnDeg) % 360) + 360) % 360;
      expect(Math.min(start, 360 - start)).toBeCloseTo(0, 5);
      expect(at.endAngleDeg! - at.startAngleDeg!).toBeCloseTo(90, 5);
    });
  });

  it('refuses an instance moved alone, and keeps the others when one is deleted', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: -3, x2: 10, y2: -3 }
    ]);
    const [circle, direction] = fixture.ids as [string, string];
    fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        4,
        4,
        resolve
      )
    );
    const [first, second, third] = fixture
      .sketch()
      .objectIds.map(String)
      .slice(2);
    fixture.constrain(lock(direction, 'start', 0, -3));
    fixture.constrain(lock(direction, 'end', 10, -3));
    fixture.constrain(lock(circle, 'center', 0, 0));
    fixture.constrain({
      constraintKind: 'radius',
      objectId: circle as EntityId,
      value: 1
    });
    // The middle instance pulled off its step: a conflict.
    const blocked = structuredClone(fixture.manager.document);
    const lockOff = commandFactories.addSketchConstraint({
      sketchId: fixture.sketchId,
      constraint: lock(second!, 'center', 8, 1)
    });
    const conflicted = await adapter.solveSketch(
      lockOff.apply(blocked),
      fixture.sketchId
    );
    expect(conflicted.converged && conflicted.classification === 'solved').toBe(
      false
    );
    // Deleting the first instance leaves the others at steps 2 and 3.
    fixture.manager.execute(
      commandFactories.deleteSketchObject({
        sketchId: fixture.sketchId,
        objectId: first as EntityId
      })
    );
    const relation = fixture
      .sketch()
      .constraints!.find(({ data }) => data.constraintKind === 'pattern')!;
    expect(
      relation.data.constraintKind === 'pattern' && relation.data.instances
    ).toEqual([
      { objectId: second, step: 2 },
      { objectId: third, step: 3 }
    ]);
    const outcome = await fixture.solve();
    expectSettled(outcome);
    expect(solved(outcome, second!).centerX).toBeCloseTo(8, 8);
    expect(solved(outcome, third!).centerX).toBeCloseTo(12, 8);
  });

  it('needs schema v139: an older stamp refuses a document that holds one', () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 },
      { objectKind: 'line', x1: 0, y1: -3, x2: 10, y2: -3 }
    ]);
    const [circle, direction] = fixture.ids as [string, string];
    fixture.commit(
      planSketchLinearPattern(
        fixture.manager.document,
        fixture.sketch(),
        fixture.sketchId,
        circle,
        direction,
        4,
        2,
        resolve
      )
    );
    const saved = JSON.parse(
      JSON.stringify(fixture.manager.document)
    ) as ProjectDocument;
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(139);
    expect(normalizeDocument(saved)).toEqual(fixture.manager.document);
    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: 138 as typeof saved.schemaVersion
      })
    ).toThrow(/Sketch pattern relations/);
  });
});
