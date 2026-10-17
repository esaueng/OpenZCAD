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
