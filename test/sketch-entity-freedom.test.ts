import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EntityId,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  fixedEntityIds,
  freeEntityRows,
  MAX_FREEDOM_ENTITIES,
  measureSketchEntityFreedom
} from '../apps/web/src/lib/sketch/entityFreedom';

/**
 * S03 per-entity freedom on the pinned kernel's solver, checked against
 * freedoms counted by hand: a held entity's DOF drop is how far it can
 * still move, so a free line keeps 4, a circle 3, an arc 5, a point 2, and
 * relations take exactly what they fix — wherever else the sketch is free.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

function sketchWith(
  objects: SketchObjectData[],
  relate: (ids: EntityId[]) => SketchConstraintData[] = () => []
) {
  const manager = new CommandManager(
    createProjectDocument('S03', toUserId('user_s03'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Freedom',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds;
  for (const constraint of relate(ids)) {
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  }
  const measure = () =>
    measureSketchEntityFreedom(
      (document, anchor) =>
        adapter.solveSketch(
          document,
          sketchId,
          anchor ? { anchor } : undefined
        ),
      manager.document,
      sketchId,
      ids.map(String)
    );
  return { ids: ids.map(String), measure };
}

const lock = (
  objectId: EntityId,
  point: 'start' | 'end' | 'center',
  x: number,
  y: number
): SketchConstraintData => ({
  constraintKind: 'lock',
  point: { objectId, point },
  x,
  y
});

describe('S03 per-entity freedom on the pinned kernel', () => {
  it('counts every free entity’s own freedoms', async () => {
    const { ids, measure } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 1 },
      { objectKind: 'circle', centerX: 10, centerY: 0, radius: 2 },
      {
        objectKind: 'arc',
        centerX: 20,
        centerY: 0,
        radius: 3,
        startAngleDeg: 10,
        endAngleDeg: 120
      },
      { objectKind: 'point', x: 30, y: 4 }
    ]);
    const report = (await measure())!;
    expect(report.dof).toBe(14);
    expect(ids.map((id) => report.freedom[id])).toEqual([4, 3, 5, 2]);
    expect(report.unmeasured).toEqual([]);
  });

  it('finds the fixed entity in a sketch that is free elsewhere', async () => {
    // A locked line, a second line joined to its end and held horizontal
    // (only its far end's x is free), and a circle centred on a lock (only
    // its radius is free).
    const { ids, measure } = sketchWith(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
        { objectKind: 'line', x1: 4, y1: 0, x2: 9, y2: 0 },
        { objectKind: 'circle', centerX: 0, centerY: 10, radius: 2 }
      ],
      ([fixed, joined, circle]) => [
        lock(fixed!, 'start', 0, 0),
        lock(fixed!, 'end', 4, 0),
        {
          constraintKind: 'coincident',
          a: { objectId: fixed!, point: 'end' },
          b: { objectId: joined!, point: 'start' }
        },
        { constraintKind: 'horizontal', objectId: joined! },
        lock(circle!, 'center', 0, 10)
      ]
    );
    const report = (await measure())!;
    expect(report.dof).toBe(2);
    expect(ids.map((id) => report.freedom[id])).toEqual([0, 1, 1]);
    expect(fixedEntityIds(report)).toEqual([ids[0]]);
    expect(freeEntityRows(report, ids, (id) => `#${ids.indexOf(id)}`)).toEqual([
      { objectId: ids[1], label: '#1', freedom: 1 },
      { objectId: ids[2], label: '#2', freedom: 1 }
    ]);
  });

  it('reads a shared freedom on each entity it moves', async () => {
    // Two lines joined end to start, the first's start locked: the joint
    // moves both, so each line's own count includes it.
    const { ids, measure } = sketchWith(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
        { objectKind: 'line', x1: 4, y1: 0, x2: 4, y2: 3 }
      ],
      ([a, b]) => [
        lock(a!, 'start', 0, 0),
        {
          constraintKind: 'coincident',
          a: { objectId: a!, point: 'end' },
          b: { objectId: b!, point: 'start' }
        }
      ]
    );
    const report = (await measure())!;
    expect(report.dof).toBe(4);
    expect(ids.map((id) => report.freedom[id])).toEqual([2, 4]);
  });

  it('holds each entity where the solve puts it, not where it is stored', async () => {
    // Review case: a stored sloped line under a horizontal relation. The
    // solve levels it; held at its stored slope it could not be solved.
    const { ids, measure } = sketchWith(
      [{ objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 1 }],
      ([line]) => [{ constraintKind: 'horizontal', objectId: line! }]
    );
    const report = (await measure())!;
    expect(report.dof).toBe(3);
    expect(report.freedom[ids[0]!]).toBe(3);
    expect(report.unmeasured).toEqual([]);
  });

  it('calls a zero-DOF sketch fixed without holding anything', async () => {
    const { ids, measure } = sketchWith(
      [{ objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 }],
      ([line]) => [lock(line!, 'start', 0, 0), lock(line!, 'end', 4, 0)]
    );
    const report = (await measure())!;
    expect(report.dof).toBe(0);
    expect(fixedEntityIds(report)).toEqual(ids);
  });

  it('counts splines towards the entity limit', async () => {
    const objects: SketchObjectData[] = [
      ...Array.from({ length: MAX_FREEDOM_ENTITIES }, (_, index) => ({
        objectKind: 'point' as const,
        x: index,
        y: 0
      })),
      {
        objectKind: 'spline',
        method: 'fit',
        points: [
          { x: 0, y: 5 },
          { x: 3, y: 7 },
          { x: 6, y: 5 }
        ]
      }
    ];
    const { measure } = sketchWith(objects);
    expect(await measure()).toBeNull();
  });

  it('declines a sketch past the entity limit, leaving the sketch-wide status', async () => {
    const objects: SketchObjectData[] = Array.from(
      { length: MAX_FREEDOM_ENTITIES + 1 },
      (_, index) => ({
        objectKind: 'point',
        x: index,
        y: 0
      })
    );
    const { measure } = sketchWith(objects);
    expect(await measure()).toBeNull();
  });

  it('leaves splines and non-solver geometry unmeasured', async () => {
    const { ids, measure } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
      {
        objectKind: 'spline',
        method: 'fit',
        points: [
          { x: 0, y: 5 },
          { x: 3, y: 7 },
          { x: 6, y: 5 }
        ]
      }
    ]);
    const report = (await measure())!;
    expect(report.freedom[ids[0]!]).toBe(4);
    expect(report.unmeasured).toEqual([ids[1]]);
    expect(fixedEntityIds(report)).toEqual([]);
  });
});
