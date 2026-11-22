import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { solvedSketchCommands } from './applySolve';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type EntityId,
  type SketchObjectData
} from '@openzcad/shared';
import { planSketchEdit, refuseEditPick } from './edits';

const resolve = (value: unknown) =>
  typeof value === 'number' ? value : Number(value);

function sketchOf(objects: SketchObjectData[], join = true) {
  const { document: base, sketchId } = addSketchFeature(
    createProjectDocument('Chamfer', toUserId('user_chamfer')),
    {
      name: 'Corner',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    }
  );
  const manager = new CommandManager(base);
  const ids = findSketch(base, sketchId)!.objectIds.map(String);
  void join;
  const sketch = () => findSketch(manager.document, sketchId)!;
  const object = (id: string) => {
    const node = manager.document.nodes[id as EntityId];
    if (node?.kind !== 'sketch-object') throw new Error(`no ${id}`);
    return node.data;
  };
  const chamfer = (a: string, b: string, distance: number) =>
    planSketchEdit(
      manager.document,
      sketch(),
      sketchId,
      'chamfer',
      [a, b],
      distance,
      String(distance),
      resolve
    );
  return { manager, sketchId, ids, sketch, object, chamfer };
}

// A line along +x into (10, 0), and a quarter arc about (10, 5) leaving
// (10, 0) — its start, at -90° — counter-clockwise to (15, 5).
const corner: SketchObjectData[] = [
  { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
  {
    objectKind: 'arc',
    centerX: 10,
    centerY: 5,
    radius: 5,
    startAngleDeg: -90,
    endAngleDeg: 0
  }
];

describe('Chamfer at a corner with an arc (S05)', () => {
  it('accepts an arc pick for Chamfer, still not for Fillet', () => {
    const { manager, sketch, ids } = sketchOf(corner);
    expect(
      refuseEditPick(manager.document, sketch(), 'chamfer', [ids[0]!], ids[1]!)
    ).toBeNull();
    expect(
      refuseEditPick(manager.document, sketch(), 'fillet', [ids[0]!], ids[1]!)
    ).toBe(
      'Fillet between an arc and another entity is not available yet. Pick two lines.'
    );
  });

  it('cuts a line and an arc back by the same straight setback, in one step', () => {
    const { manager, ids, sketch, object, chamfer } = sketchOf(corner);
    const [line, arc] = ids as [string, string];
    const plan = chamfer(line, arc, 2);
    if (plan.status !== 'commands') throw new Error('expected commands');
    manager.execute(composeCommands(plan.label, plan.commands));
    expect(object(line)).toEqual({
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: 8,
      y2: 0
    });
    // The arc's new start is the arc point 2 from (10, 0): central angle
    // 2·asin(2 / 10).
    const turn = (2 * Math.asin(0.2) * 180) / Math.PI;
    const trimmed = object(arc) as Extract<
      SketchObjectData,
      { objectKind: 'arc' }
    >;
    expect(Number(trimmed.startAngleDeg)).toBeCloseTo(-90 + turn, 9);
    expect(Number(trimmed.endAngleDeg)).toBeCloseTo(0, 9);
    const bevelId = sketch().objectIds.map(String).at(-1)!;
    const bevel = object(bevelId) as Extract<
      SketchObjectData,
      { objectKind: 'line' }
    >;
    expect(bevel.x1).toBeCloseTo(8, 9);
    expect(bevel.y1).toBeCloseTo(0, 9);
    const start = (-90 + turn) * (Math.PI / 180);
    expect(bevel.x2).toBeCloseTo(10 + 5 * Math.cos(start), 9);
    expect(bevel.y2).toBeCloseTo(5 + 5 * Math.sin(start), 9);
    expect(Math.hypot(Number(bevel.x2) - 10, Number(bevel.y2))).toBeCloseTo(
      2,
      9
    );
    // Joined at both ends, one undo step.
    expect(
      (sketch().constraints ?? []).map(({ data }) => data.constraintKind)
    ).toEqual(['coincident', 'coincident']);
    manager.undo();
    expect(object(line)).toMatchObject({ x2: 10 });
    expect(sketch().objectIds).toHaveLength(2);
  });

  it('cuts two arcs at their shared end, either pick order', () => {
    const arcs: SketchObjectData[] = [
      // Ends at (0, 5) (90°).
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      // Starts at (0, 5) (180° about (5, 5)), short of the first's other end.
      {
        objectKind: 'arc',
        centerX: 5,
        centerY: 5,
        radius: 5,
        startAngleDeg: 180,
        endAngleDeg: 240
      }
    ];
    for (const order of [0, 1]) {
      const { manager, ids, object, chamfer } = sketchOf(arcs);
      const [a, b] = (order === 0 ? ids : [...ids].reverse()) as [
        string,
        string
      ];
      const plan = chamfer(a, b, 1);
      if (plan.status !== 'commands')
        throw new Error(plan.status === 'refuse' ? plan.reason : plan.status);
      manager.execute(composeCommands(plan.label, plan.commands));
      const turn = (2 * Math.asin(0.1) * 180) / Math.PI;
      const first = object(ids[0]!) as Extract<
        SketchObjectData,
        { objectKind: 'arc' }
      >;
      const second = object(ids[1]!) as Extract<
        SketchObjectData,
        { objectKind: 'arc' }
      >;
      expect(Number(first.endAngleDeg)).toBeCloseTo(90 - turn, 9);
      expect(Number(second.startAngleDeg)).toBeCloseTo(180 + turn, 9);
    }
  });

  it('meets a circle on the clicked side, keeping the circle whole', async () => {
    // A line from (15, 0) ending on the radius-5 circle about the origin.
    const fixture = sketchOf([
      { objectKind: 'line', x1: 15, y1: 0, x2: 5, y2: 0 },
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 }
    ]);
    const [line, circle] = fixture.ids as [string, string];
    fixture.manager.execute(
      commandFactories.addSketchConstraint({
        sketchId: fixture.sketchId,
        constraint: {
          constraintKind: 'point-on-object',
          point: { objectId: line as EntityId, point: 'end' },
          objectId: circle as EntityId
        }
      })
    );
    for (const [click, sign] of [
      [{ x: 0, y: 5 }, 1],
      [{ x: 0, y: -5 }, -1]
    ] as const) {
      const plan = fixture.chamfer(line, `${circle}@${click.x},${click.y}`, 2);
      if (plan.status !== 'commands')
        throw new Error(plan.status === 'refuse' ? plan.reason : plan.status);
      const manager = new CommandManager(fixture.manager.document);
      manager.execute(composeCommands(plan.label, plan.commands));
      const after = findSketch(manager.document, fixture.sketchId)!;
      const bevelId = after.objectIds.map(String).at(-1)!;
      const node = manager.document.nodes[bevelId as EntityId];
      const bevel = (
        node?.kind === 'sketch-object' ? node.data : null
      ) as Extract<SketchObjectData, { objectKind: 'line' }>;
      // Cut 2 back along the line, and 2 (a chord) round the circle on the
      // clicked side.
      expect(Number(bevel.x1)).toBeCloseTo(7, 9);
      expect(Number(bevel.y1)).toBeCloseTo(0, 9);
      const turn = 2 * Math.asin(0.2);
      expect(Number(bevel.x2)).toBeCloseTo(5 * Math.cos(turn), 9);
      expect(Number(bevel.y2)).toBeCloseTo(sign * 5 * Math.sin(turn), 9);
      const circleNode = manager.document.nodes[circle as EntityId];
      expect(
        circleNode?.kind === 'sketch-object' && circleNode.data
      ).toMatchObject({ objectKind: 'circle', radius: 5 });
      expect(
        after.constraints!.map(({ data }) => data.constraintKind).sort()
      ).toEqual(['coincident', 'point-on-object']);
      const adapter = await createExactKernelAdapter();
      try {
        const outcome = await adapter.solveSketch(
          manager.document,
          fixture.sketchId
        );
        expect(outcome.converged).toBe(true);
        expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
        expect(
          solvedSketchCommands(
            manager.document,
            fixture.sketchId,
            outcome,
            1e-6
          )
        ).toEqual([]);
      } finally {
        adapter.dispose();
      }
    }
  });

  it('refuses to cut a corner a relation holds (review case)', () => {
    const fixture = sketchOf(corner);
    const [line, arc] = fixture.ids as [string, string];
    fixture.manager.execute(
      commandFactories.addSketchConstraint({
        sketchId: fixture.sketchId,
        constraint: {
          constraintKind: 'lock',
          point: { objectId: line as EntityId, point: 'end' },
          x: 10,
          y: 0
        }
      })
    );
    expect(fixture.chamfer(line, arc, 2)).toEqual({
      status: 'refuse',
      reason:
        'A lock relation holds the corner, so cutting it back would break it. Remove the relation first.'
    });
  });

  it('refuses by name what does not fit, changing nothing', () => {
    const { chamfer, ids } = sketchOf(corner);
    const [line, arc] = ids as [string, string];
    expect(chamfer(line, arc, 0)).toEqual({
      status: 'refuse',
      reason: 'A chamfer distance must be a positive number.'
    });
    expect(chamfer(line, arc, 12)).toEqual({
      status: 'refuse',
      reason: 'A 12 setback does not fit a 10 line.'
    });
    // 8 is shorter than the line but the quarter arc's chord is about 7.07.
    expect(chamfer(line, arc, 8)).toEqual({
      status: 'refuse',
      reason: 'A 8 setback runs past the far end of the arc.'
    });
    const apart = sketchOf([
      corner[0]!,
      { ...(corner[1] as object), centerX: 20 } as SketchObjectData
    ]);
    expect(apart.chamfer(apart.ids[0]!, apart.ids[1]!, 1)).toEqual({
      status: 'refuse',
      reason:
        'Those two do not meet at an endpoint. Join them first — this tool does not extend geometry.'
    });
  });
});
