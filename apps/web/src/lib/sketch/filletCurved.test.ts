import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EntityId,
  type ParamValue,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import {
  listSketchFilletCorners,
  planSketchFilletBatch,
  sketchFilletBatchCommands,
  sketchFilletCandidateRefusal,
  type ReadySketchFilletBatchPlan
} from './filletBatch';

/**
 * S05 arc and circle inputs to the sketch Fillet: the fillet is exactly
 * tangent to each leg at the radius asked for, the arc legs are cut back to
 * their tangencies, a circle stays whole, and the committed sketch solves on
 * the pinned kernel without moving anything or a redundant equation.
 */

const resolve = (value: ParamValue) => Number(value);
let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => adapter.dispose());

function sketchOf(
  objects: SketchObjectData[],
  relate: (ids: EntityId[]) => SketchConstraintData[] = () => []
) {
  const { document: base, sketchId } = addSketchFeature(
    createProjectDocument('Curved fillet', toUserId('user_curved')),
    {
      name: 'Corner',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    }
  );
  const manager = new CommandManager(base);
  const ids = findSketch(base, sketchId)!.objectIds;
  for (const constraint of relate(ids)) {
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  }
  const sketch = () => findSketch(manager.document, sketchId)!;
  return { manager, sketchId, ids: ids.map(String), sketch };
}

function ready(
  plan: ReturnType<typeof planSketchFilletBatch>
): ReadySketchFilletBatchPlan {
  if (plan.status === 'refuse') throw new Error(plan.reason);
  return plan;
}

const join = (
  a: EntityId,
  pa: 'start' | 'end',
  b: EntityId,
  pb: 'start' | 'end'
) =>
  ({
    constraintKind: 'coincident',
    a: { objectId: a, point: pa },
    b: { objectId: b, point: pb }
  }) as const;

/** Commit the plan and solve it: nothing may move, nothing is redundant. */
async function commitAndSolve(
  fixture: ReturnType<typeof sketchOf>,
  plan: ReadySketchFilletBatchPlan
) {
  // The driving radius stored is the one the plan was built at.
  const commands = sketchFilletBatchCommands(
    fixture.manager.document,
    fixture.sketch(),
    plan,
    plan.arcs[0]!.radius
  );
  const candidate = fixture.manager.runTransaction('Fillet', commands);
  const outcome = await adapter.solveSketch(candidate, fixture.sketchId);
  expect(outcome.converged).toBe(true);
  expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
  expect(
    sketchFilletCandidateRefusal(candidate, fixture.sketchId, outcome)
  ).toBeNull();
  return { candidate, outcome };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('Fillet with arc and circle inputs (S05)', () => {
  it('rounds a line meeting an arc, tangent to both', async () => {
    // A line along +x into (10, 0), the start of a quarter arc about
    // (15, 0) turning down to (15, -5): a right-angle kink.
    const fixture = sketchOf(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        {
          objectKind: 'arc',
          centerX: 15,
          centerY: 0,
          radius: 5,
          startAngleDeg: 180,
          endAngleDeg: 270
        }
      ],
      ([line, arc]) => [join(line!, 'end', arc!, 'start')]
    );
    const corners = listSketchFilletCorners(
      fixture.manager.document,
      fixture.sketch(),
      resolve
    );
    expect(corners).toHaveLength(1);
    const plan = ready(
      planSketchFilletBatch(
        fixture.manager.document,
        fixture.sketch(),
        [corners[0]!.id],
        1,
        resolve
      )
    );
    const [fillet] = plan.arcs;
    // Tangent to the line (y = 0) on the side the arc turns to, and to the
    // radius-5 circle about (15, 0) from outside it: the corner between
    // "back along the line" and "down along the arc" lies outside the arc.
    expect(fillet!.center.y).toBeCloseTo(-1, 9);
    expect(dist(fillet!.center, { x: 15, y: 0 })).toBeCloseTo(6, 9);
    // The catalogue orders a corner's legs by id, so either tangency may be
    // the line's: one lies on y = 0, the other on the arc's circle.
    const [line] = fixture.ids;
    const onLine = corners[0]!.a.objectId === line ? fillet!.a : fillet!.b;
    const onArc = corners[0]!.a.objectId === line ? fillet!.b : fillet!.a;
    expect(onLine.y).toBeCloseTo(0, 9);
    expect(dist(onArc, { x: 15, y: 0 })).toBeCloseTo(5, 9);
    expect(dist(onArc, fillet!.center)).toBeCloseTo(1, 9);
    expect(plan.trimmedArcs).toHaveLength(1);
    await commitAndSolve(fixture, plan);
  });

  it('rounds two arcs meeting at a kink, and records their tangency', async () => {
    const fixture = sketchOf(
      [
        // Ends at (0, 5).
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        // Starts at (0, 5), sweeping down and away (to 240°, short of the
        // first arc's other end).
        {
          objectKind: 'arc',
          centerX: 5,
          centerY: 5,
          radius: 5,
          startAngleDeg: 180,
          endAngleDeg: 240
        }
      ],
      ([a, b]) => [join(a!, 'end', b!, 'start')]
    );
    const corners = listSketchFilletCorners(
      fixture.manager.document,
      fixture.sketch(),
      resolve
    );
    expect(corners).toHaveLength(1);
    const plan = ready(
      planSketchFilletBatch(
        fixture.manager.document,
        fixture.sketch(),
        [corners[0]!.id],
        0.5,
        resolve
      )
    );
    const [fillet] = plan.arcs;
    for (const [center, radius] of [
      [{ x: 0, y: 0 }, 5],
      [{ x: 5, y: 5 }, 5]
    ] as const) {
      const reach = dist(fillet!.center, center);
      expect(
        [radius - 0.5, radius + 0.5].some((r) => Math.abs(reach - r) < 1e-9)
      ).toBe(true);
    }
    expect(plan.trimmedArcs).toHaveLength(2);
    const { candidate } = await commitAndSolve(fixture, plan);
    const kinds = findSketch(candidate, fixture.sketchId)!
      .constraints!.map(({ data }) => data.constraintKind)
      .sort();
    expect(kinds.filter((kind) => kind === 'tangent')).toHaveLength(2);
  });

  it('refuses cuts that overlap on a long arc (review case)', () => {
    // A radius-5 arc 0°–330°, a line leaving each end radially; a radius-15
    // fillet at both ends would cut past each other along the arc.
    const fixture = sketchOf(
      [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 330
        },
        {
          objectKind: 'line',
          x1: 5,
          y1: 0,
          x2: 5 + 10 * Math.cos(Math.PI / 6),
          y2: 10 * Math.sin(Math.PI / 6)
        },
        {
          objectKind: 'line',
          x1: 5 * Math.cos((-30 * Math.PI) / 180),
          y1: 5 * Math.sin((-30 * Math.PI) / 180),
          x2: 25 * Math.cos((-30 * Math.PI) / 180),
          y2: 25 * Math.sin((-30 * Math.PI) / 180)
        }
      ],
      ([arc, a, b]) => [
        join(arc!, 'start', a!, 'start'),
        join(arc!, 'end', b!, 'start')
      ]
    );
    const corners = listSketchFilletCorners(
      fixture.manager.document,
      fixture.sketch(),
      resolve
    );
    const plan = planSketchFilletBatch(
      fixture.manager.document,
      fixture.sketch(),
      corners.map(({ id }) => id),
      15,
      resolve
    );
    expect(plan.status).toBe('refuse');
  });

  it('never returns a fillet that doubles back on a leg (review case)', () => {
    // A quarter arc about the origin from (5, 0), and a 5-long line leaving
    // (5, 0) at 120°: a fillet must continue both legs smoothly.
    const fixture = sketchOf(
      [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        {
          objectKind: 'line',
          x1: 5,
          y1: 0,
          x2: 5 + 5 * Math.cos((120 * Math.PI) / 180),
          y2: 5 * Math.sin((120 * Math.PI) / 180)
        }
      ],
      ([arc, line]) => [join(arc!, 'start', line!, 'start')]
    );
    const corners = listSketchFilletCorners(
      fixture.manager.document,
      fixture.sketch(),
      resolve
    );
    for (const corner of corners) {
      const plan = planSketchFilletBatch(
        fixture.manager.document,
        fixture.sketch(),
        [corner.id],
        2,
        resolve
      );
      if (plan.status !== 'ready') continue;
      const [fillet] = plan.arcs;
      // Leaving the fillet at each end, the direction is the leg's own:
      // the fillet's end tangent is parallel to the leg there.
      const along = (angleDeg: number) => ({
        x: -Math.sin((angleDeg * Math.PI) / 180),
        y: Math.cos((angleDeg * Math.PI) / 180)
      });
      const lineDir = {
        x: Math.cos((120 * Math.PI) / 180),
        y: Math.sin((120 * Math.PI) / 180)
      };
      const onLineEnd =
        Math.abs(
          (fillet!.a.y - 0) * lineDir.x - (fillet!.a.x - 5) * lineDir.y
        ) < 1e-9
          ? fillet!.startsAt === 'a'
            ? fillet!.startAngleDeg
            : fillet!.endAngleDeg
          : fillet!.startsAt === 'b'
            ? fillet!.startAngleDeg
            : fillet!.endAngleDeg;
      const tangent = along(onLineEnd);
      expect(
        Math.abs(tangent.x * lineDir.y - tangent.y * lineDir.x)
      ).toBeLessThan(1e-9);
      expect(fillet!.endAngleDeg - fillet!.startAngleDeg).toBeLessThan(180);
    }
  });

  it('gives each side of a circle joint its own fillet (review case)', () => {
    // A radius-5 circle and a 1-long line leaving (5, 0) at 30°.
    const fixture = sketchOf([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      {
        objectKind: 'line',
        x1: 5,
        y1: 0,
        x2: 5 + Math.cos(Math.PI / 6),
        y2: Math.sin(Math.PI / 6)
      }
    ]);
    const corners = listSketchFilletCorners(
      fixture.manager.document,
      fixture.sketch(),
      resolve
    );
    expect(corners).toHaveLength(2);
    const contacts = corners.flatMap((corner) => {
      const plan = planSketchFilletBatch(
        fixture.manager.document,
        fixture.sketch(),
        [corner.id],
        1,
        resolve
      );
      return plan.status === 'ready' ? [plan.arcs[0]!.b] : [];
    });
    // Never the same contact from both markers.
    if (contacts.length === 2) {
      expect(dist(contacts[0]!, contacts[1]!)).toBeGreaterThan(1e-6);
    }
  });

  it('drops an arc tangency with the join it depends on', async () => {
    const fixture = sketchOf(
      [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        {
          objectKind: 'arc',
          centerX: 5,
          centerY: 5,
          radius: 5,
          startAngleDeg: 180,
          endAngleDeg: 240
        }
      ],
      ([a, b]) => [join(a!, 'end', b!, 'start')]
    );
    const corners = listSketchFilletCorners(
      fixture.manager.document,
      fixture.sketch(),
      resolve
    );
    const plan = ready(
      planSketchFilletBatch(
        fixture.manager.document,
        fixture.sketch(),
        [corners[0]!.id],
        0.5,
        resolve
      )
    );
    const { candidate } = await commitAndSolve(fixture, plan);
    const manager = new CommandManager(candidate);
    const constraints = () =>
      findSketch(manager.document, fixture.sketchId)!.constraints!;
    const tangents = () =>
      constraints().filter(({ data }) => data.constraintKind === 'tangent');
    expect(tangents()).toHaveLength(2);
    const join1 = constraints().find(
      ({ data }) => data.constraintKind === 'coincident'
    )!;
    manager.execute(
      commandFactories.deleteSketchConstraint({
        sketchId: fixture.sketchId,
        constraintId: join1.constraintId
      })
    );
    expect(tangents()).toHaveLength(1);
    manager.undo();
    expect(tangents()).toHaveLength(2);
  });

  it('offers no corner where a line runs smoothly into an arc', () => {
    const fixture = sketchOf(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        // Tangent at (10, 0): the arc about (10, 5) leaves along +x.
        {
          objectKind: 'arc',
          centerX: 10,
          centerY: 5,
          radius: 5,
          startAngleDeg: -90,
          endAngleDeg: -30
        }
      ],
      ([line, arc]) => [join(line!, 'end', arc!, 'start')]
    );
    expect(
      listSketchFilletCorners(
        fixture.manager.document,
        fixture.sketch(),
        resolve
      )
    ).toEqual([]);
  });

  it('rounds a line into a circle on either side, keeping the circle whole', async () => {
    // A line from (15, 0) ending on the radius-5 circle about the origin
    // at (5, 0); a fillet either side of it.
    for (const side of [0, 1]) {
      const fixture = sketchOf(
        [
          { objectKind: 'line', x1: 15, y1: 0, x2: 5, y2: 0 },
          { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
        ],
        ([line, circle]) => [
          {
            constraintKind: 'point-on-object',
            point: { objectId: line!, point: 'end' },
            objectId: circle!
          }
        ]
      );
      const [line, circle] = fixture.ids as [string, string];
      const corners = listSketchFilletCorners(
        fixture.manager.document,
        fixture.sketch(),
        resolve
      );
      expect(corners).toHaveLength(2);
      // Both sides of one joint at once is refused by name.
      expect(
        planSketchFilletBatch(
          fixture.manager.document,
          fixture.sketch(),
          corners.map(({ id }) => id),
          1,
          resolve
        )
      ).toMatchObject({
        status: 'refuse',
        reason:
          'Two selected corners round the same end. Pick one side of the joint.'
      });
      const plan = ready(
        planSketchFilletBatch(
          fixture.manager.document,
          fixture.sketch(),
          [corners[side]!.id],
          1,
          resolve
        )
      );
      const [fillet] = plan.arcs;
      expect(Math.abs(fillet!.center.y)).toBeCloseTo(1, 9);
      expect(dist(fillet!.center, { x: 0, y: 0 })).toBeCloseTo(6, 9);
      // The circle is never cut.
      expect(plan.trimmedArcs).toEqual([]);
      const { candidate } = await commitAndSolve(fixture, plan);
      const after = findSketch(candidate, fixture.sketchId)!;
      const circleNode = candidate.nodes[circle as EntityId];
      expect(
        circleNode?.kind === 'sketch-object' && circleNode.data
      ).toMatchObject({
        objectKind: 'circle',
        radius: 5
      });
      // The end's hold on the circle went with it; the fillet touches it.
      expect(
        after.constraints!.some(
          ({ data }) =>
            data.constraintKind === 'point-on-object' &&
            data.point.objectId === line
        )
      ).toBe(false);
      expect(
        after.constraints!.some(
          ({ data }) => data.constraintKind === 'tangent' && data.a === circle
        )
      ).toBe(true);
    }
  });
});
