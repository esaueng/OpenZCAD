import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ParamValue,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';
import { centerRectangleShape, compositeCommands } from './composites';
import { solvedSketchCommands } from './applySolve';
import {
  listSketchFilletCorners,
  planSketchFilletBatch,
  sketchFilletBatchCommands,
  sketchFilletCandidateRefusal,
  type SketchFilletBatchPlan
} from './filletBatch';

const owner = toUserId('user_batch_fillet');
const planeRef = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const resolve = (value: ParamValue) => Number(value);

function centeredRectangle(units: UnitSystem = 'mm') {
  const manager = new CommandManager(
    createProjectDocument('Fillets', owner, units)
  );
  const shape = centerRectangleShape({ x: 0, y: 0 }, { x: 40, y: 25 })!;
  const rectangle = compositeCommands(shape, {
    kind: 'new-sketch',
    name: 'Rectangle',
    planeRef
  });
  manager.runTransaction(rectangle.label, rectangle.commands);
  const { document } = manager;
  const sketch = findSketch(document, rectangle.sketchId)!;
  const corners = listSketchFilletCorners(document, sketch, resolve);
  const plan = (radius: number, ids = corners.map(({ id }) => id)) =>
    planSketchFilletBatch(document, sketch, ids, radius, resolve);
  return { document, manager, rectangle, sketch, corners, plan };
}

function ready(plan: SketchFilletBatchPlan) {
  if (plan.status === 'refuse') throw new Error(plan.reason);
  return plan;
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData {
  return { objectKind: 'line', x1, y1, x2, y2 };
}

function sketchOf(objects: SketchObjectData[]) {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Lines', owner),
    { name: 'Lines', planeRef, objects }
  );
  return { document, sketch: findSketch(document, sketchId)! };
}

describe('batch sketch fillet', () => {
  it.each(['authored', 'resolved'] as const)(
    'keeps %s high-degree joints bounded without hiding ordinary corners',
    (geometry) => {
      const dense = Array.from({ length: 128 }, (_, i) => line(0, 0, 1, i + 1));
      const { document: original, sketch } = sketchOf([
        ...(geometry === 'authored'
          ? dense
          : dense.map((_, i) => line(10 + i * 3, 0, 11 + i * 3, 1))),
        line(1000, 0, 1020, 0),
        line(1020, 0, 1020, 20),
        line(1020, 20, 1000, 20),
        line(1000, 20, 1000, 0)
      ]);
      const document =
        geometry === 'authored'
          ? original
          : {
              ...original,
              derived: {
                ...original.derived,
                sketchGeometry: {
                  projectId: original.projectId,
                  documentVersion: original.version,
                  objects: Object.fromEntries(
                    dense.map((data, i) => [sketch.objectIds[i]!, data])
                  )
                }
              }
            };
      // Stop the vulnerable implementation long before it can retain a
      // large graph. The catalog must not need all neighbors of a branch.
      const push = Array.prototype.push;
      let retained = 0;
      Array.prototype.push = function (...items: unknown[]) {
        const item = items[0];
        if (
          items.length === 1 &&
          item !== null &&
          typeof item === 'object' &&
          'ref' in item &&
          'position' in item &&
          ++retained > 2048
        ) {
          throw new Error('Finite endpoint-retention guard exceeded.');
        }
        return Reflect.apply<unknown[], unknown[], number>(push, this, items);
      };
      try {
        const corners = listSketchFilletCorners(document, sketch, resolve);
        expect(corners).toHaveLength(4);
        expect(
          planSketchFilletBatch(
            document,
            sketch,
            corners.map(({ id }) => id),
            2,
            resolve
          ).status
        ).toBe('ready');
      } finally {
        Array.prototype.push = push;
      }
    }
  );

  it('refuses excessive candidate work even when no endpoints touch', () => {
    const { document, sketch } = sketchOf(
      Array.from({ length: 1500 }, (_, i) => line(0, i * 10, 0, i * 10 + 1))
    );
    const hypot = Math.hypot;
    let calls = 0;
    Math.hypot = (...values: number[]) => {
      // Bounds a regression without relying on a timer or a browser hang.
      if (++calls > 1_100_000) {
        throw new Error('Finite endpoint-comparison guard exceeded.');
      }
      return hypot(...values);
    };
    try {
      expect(() => listSketchFilletCorners(document, sketch, resolve)).toThrow(
        'This sketch has too many nearby endpoints to check safely.'
      );
      calls = 0;
      const plan = planSketchFilletBatch(
        document,
        sketch,
        ['not-a-corner'],
        2,
        resolve
      );
      expect(plan.status).toBe('refuse');
      if (plan.status !== 'refuse')
        throw new Error('Expected catalog refusal.');
      expect(plan.reason).toContain(
        'This sketch has too many nearby endpoints to check safely.'
      );
    } finally {
      Math.hypot = hypot;
    }
  });

  it('catalogs all four rectangle corners and plans identical tangent geometry in either pick order', () => {
    const { corners, rectangle, document, sketch, plan } = centeredRectangle();
    expect(corners).toHaveLength(4);
    expect(new Set(corners.map(({ id }) => id)).size).toBe(4);
    for (const { a, b } of corners) {
      expect(rectangle.edgeIds).toContain(a.objectId);
      expect(rectangle.edgeIds).toContain(b.objectId);
    }
    const reversed = listSketchFilletCorners(
      document,
      {
        ...sketch,
        objectIds: [...sketch.objectIds].reverse()
      },
      resolve
    );
    expect(reversed.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...corners].sort((a, b) => a.id.localeCompare(b.id))
    );

    const preview = ready(plan(5));
    expect(
      plan(
        5,
        [...corners].reverse().map(({ id }) => id)
      )
    ).toEqual(preview);
    expect(preview.lines).toHaveLength(4);
    expect(preview.arcs).toHaveLength(4);
    for (const [index, objectId] of rectangle.edgeIds.entries()) {
      const { start, end } = preview.lines.find(
        (entry) => entry.objectId === objectId
      )!;
      expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(
        index % 2 === 0 ? 70 : 40,
        9
      );
    }
    for (const arc of preview.arcs) {
      expect(arc.radius).toBe(5);
      expect(arc.endAngleDeg - arc.startAngleDeg).toBeCloseTo(90, 9);
      for (const side of ['a', 'b'] as const) {
        const ref = arc.corner[side];
        const leg = preview.lines.find(
          (entry) => entry.objectId === ref.objectId
        )!;
        const tangent = arc[side];
        expect(leg[ref.point]).toEqual(tangent);
        const angle =
          ((arc.startsAt === side ? arc.startAngleDeg : arc.endAngleDeg) *
            Math.PI) /
          180;
        expect(arc.center.x + arc.radius * Math.cos(angle)).toBeCloseTo(
          tangent.x,
          9
        );
        expect(arc.center.y + arc.radius * Math.sin(angle)).toBeCloseTo(
          tangent.y,
          9
        );
        expect(
          (leg.end.x - leg.start.x) * (tangent.x - arc.center.x) +
            (leg.end.y - leg.start.y) * (tangent.y - arc.center.y)
        ).toBeCloseTo(0, 9);
      }
    }
  });

  it('resolves slightly rounded legacy line endpoints and constructs a true non-right-angle fillet', () => {
    const { document: authored, sketch } = sketchOf([
      line(0, 0, 20, 0),
      line(3, 5, 10, 10 * Math.sqrt(3)),
      { ...line(0, 0, 3, -5), construction: true },
      { objectKind: 'rectangle', centerX: 0, centerY: 0, width: 10, height: 10 }
    ]);
    const document = {
      ...authored,
      derived: {
        ...authored.derived,
        sketchGeometry: {
          projectId: authored.projectId,
          documentVersion: authored.version,
          objects: {
            [sketch.objectIds[1]!]: line(0, 3e-7, 10, 10 * Math.sqrt(3) + 3e-7)
          }
        }
      }
    };
    expect(listSketchFilletCorners(authored, sketch, resolve)).toEqual([]);
    const [corner] = listSketchFilletCorners(document, sketch, resolve);
    expect(corner).toBeDefined();
    const {
      arcs: [arc],
      lines
    } = ready(
      planSketchFilletBatch(document, sketch, [corner!.id], 3, resolve)
    );
    expect(arc!.endAngleDeg - arc!.startAngleDeg).toBeCloseTo(120, 8);
    expect(
      Math.hypot(arc!.a.x - corner!.point.x, arc!.a.y - corner!.point.y)
    ).toBeCloseTo(3 * Math.sqrt(3), 8);
    for (const { start, end } of lines) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const distance =
        Math.abs(
          dx * (arc!.center.y - start.y) - dy * (arc!.center.x - start.x)
        ) / Math.hypot(dx, dy);
      expect(distance).toBeCloseTo(3, 9);
    }
  });

  it('omits branched joints and straight continuations', () => {
    const { document, sketch } = sketchOf([
      line(0, 0, 20, 0),
      line(0, 0, 0, 20),
      line(0, 0, -5, 7),
      line(20, 0, 30, 0)
    ]);
    expect(listSketchFilletCorners(document, sketch, resolve)).toEqual([]);
  });

  it.each([
    {
      radius: 25,
      reason:
        'Radius 25 mm leaves no straight segment on a 50 mm line. Use a smaller radius.'
    },
    {
      radius: 26,
      reason:
        'Radius 26 mm overlaps the trims by 2 mm on a 50 mm line. Use a smaller radius.'
    }
  ])(
    'refuses R$radius across two corners sharing a short edge',
    ({ radius, reason }) => {
      const { corners, rectangle, plan } = centeredRectangle();
      const lineId = rectangle.edgeIds[1]!;
      const cornerIds = corners
        .filter(({ a, b }) => a.objectId === lineId || b.objectId === lineId)
        .map(({ id }) => id);
      expect(cornerIds).toHaveLength(2);
      expect(plan(radius, [cornerIds[0]!]).status).toBe('ready');
      const two = plan(radius, cornerIds);
      const all = plan(radius);
      if (two.status !== 'refuse' || all.status !== 'refuse') {
        throw new Error('Expected overlapping trims to be refused.');
      }
      expect(two.reason).toBe(reason);
      expect(two.lineIds).toEqual([lineId]);
      expect([...two.cornerIds].sort()).toEqual(cornerIds.sort());
      expect([...all.lineIds].sort()).toEqual(
        [rectangle.edgeIds[1], rectangle.edgeIds[3]].sort()
      );
      expect([...all.cornerIds].sort()).toEqual(
        corners.map(({ id }) => id).sort()
      );
    }
  );

  it('reports conflicts in the document unit', () => {
    expect(centeredRectangle('inch').plan(26)).toMatchObject({
      status: 'refuse',
      reason:
        'Radius 26 in overlaps the trims by 2 in on a 50 in line. Use a smaller radius.'
    });
  });

  it('explains a dimension holding a selected edge before the solve', () => {
    const { manager, rectangle, corners } = centeredRectangle();
    const id = rectangle.edgeIds[0]!;
    const corner = corners.find(
      ({ a, b }) => a.objectId === id || b.objectId === id
    )!;
    const document = manager.runTransaction('Dimension line', [
      commandFactories.addSketchConstraint({
        sketchId: rectangle.sketchId,
        constraint: {
          constraintKind: 'distance',
          a: { objectId: id, point: 'start' },
          b: { objectId: id, point: 'end' },
          value: 80
        }
      })
    ]);
    const sketch = findSketch(document, rectangle.sketchId)!;
    expect(
      planSketchFilletBatch(document, sketch, [corner.id], 5, resolve)
    ).toEqual({
      status: 'refuse',
      lineIds: [id],
      cornerIds: [corner.id],
      reason:
        'A driving dimension holds this line at 80 mm. Change or remove the dimension before applying the fillet.'
    });
  });

  it('accepts one rounded corner with a sub-tolerance legacy gap on an unrelated pair of lines', async () => {
    const { manager, rectangle, corners } = centeredRectangle();
    const { sketchId } = rectangle;
    const extended = manager.runTransaction('Add old sketch geometry', [
      commandFactories.addSketchObjects({
        sketchId,
        objects: [line(60, 0, 80, 0), line(80.0000005, 0, 80, 20)]
      })
    ]);
    const [first, second] = findSketch(extended, sketchId)!.objectIds.slice(-2);
    const base = manager.runTransaction('Hold the old joint', [
      commandFactories.addSketchConstraint({
        sketchId,
        constraint: {
          constraintKind: 'coincident',
          a: { objectId: first!, point: 'end' },
          b: { objectId: second!, point: 'start' }
        }
      })
    ]);
    const sketch = findSketch(base, sketchId)!;
    const plan = ready(
      planSketchFilletBatch(base, sketch, [corners[0]!.id], 5, resolve)
    );
    const candidate = manager.runTransaction(
      'Fillet one corner',
      sketchFilletBatchCommands(base, sketch, plan, 5)
    );
    const adapter = await createExactKernelAdapter();
    try {
      const solved = await adapter.solveSketch(candidate, sketchId);
      expect(solved.converged).toBe(true);
      expect(
        solvedSketchCommands(candidate, sketchId, solved).length
      ).toBeGreaterThan(0);
      expect(
        sketchFilletCandidateRefusal(candidate, sketchId, solved)
      ).toBeNull();
    } finally {
      adapter.dispose();
    }
  });

  it('refuses an invalid radius or a selection missing from the base geometry', () => {
    const { plan, corners } = centeredRectangle();
    const selected = [corners[0]!.id];
    expect(plan(0, selected)).toEqual({
      status: 'refuse',
      reason: 'Enter a positive fillet radius in mm.',
      lineIds: [],
      cornerIds: selected
    });
    expect(plan(1e-20, selected).status).toBe('refuse');
    expect(plan(5, ['missing'])).toMatchObject({
      status: 'refuse',
      cornerIds: ['missing']
    });
  });

  it('solves the centered rectangle candidate, preserves relations, and replays the same IDs', async () => {
    const { document, manager, rectangle, sketch, plan } = centeredRectangle();
    const candidatePlan = ready(plan(5));
    const commands = sketchFilletBatchCommands(
      document,
      sketch,
      candidatePlan,
      '2 + 3'
    );
    const updatedIds = commands
      .filter(({ kind }) => kind === 'sketch.object.update')
      .map(({ payload }) => (payload as { objectId: string }).objectId);
    expect(updatedIds.sort()).toEqual(
      [...rectangle.edgeIds, ...rectangle.helperIds].sort()
    );
    expect(
      commands.filter(({ kind }) => kind === 'sketch.constraint.delete')
    ).toHaveLength(4);
    const candidate = manager.runTransaction('Fillet four corners', commands);
    const after = findSketch(candidate, rectangle.sketchId)!;
    expect(after.objectIds.slice(0, sketch.objectIds.length)).toEqual(
      sketch.objectIds
    );
    expect(after.objectIds).toHaveLength(sketch.objectIds.length + 4);
    expect(after.composites).toEqual(sketch.composites);
    const kept = sketch.constraints!.slice(4);
    expect(after.constraints?.slice(0, kept.length)).toEqual(kept);
    expect(
      after.constraints
        ?.filter(({ data }) => data.constraintKind === 'radius')
        .map(({ data }) => data)
    ).toEqual(
      after.objectIds.slice(sketch.objectIds.length).map((objectId) => ({
        constraintKind: 'radius',
        objectId,
        value: '2 + 3'
      }))
    );

    const adapter = await createExactKernelAdapter();
    try {
      const solved = await adapter.solveSketch(candidate, rectangle.sketchId);
      expect(solved.converged).toBe(true);
      expect(solved.rolledBack).toBe(false);
      expect(solved.classification).toBe('underConstrained');
      expect(solved.maxResidual).toBeLessThan(1e-8);
      for (const [index, objectId] of rectangle.edgeIds.entries()) {
        const object = solved.objects.find(
          (entry) => entry.objectId === objectId
        );
        if (object?.kind !== 'line') throw new Error('Expected a solved line.');
        expect(
          Math.hypot(object.x2 - object.x1, object.y2 - object.y1)
        ).toBeCloseTo(index % 2 === 0 ? 70 : 40, 6);
        const line = candidatePlan.lines.find(
          (entry) => entry.objectId === objectId
        )!;
        expect(object.x1).toBeCloseTo(line.start.x, 8);
        expect(object.y1).toBeCloseTo(line.start.y, 8);
        expect(object.x2).toBeCloseTo(line.end.x, 8);
        expect(object.y2).toBeCloseTo(line.end.y, 8);
      }
    } finally {
      adapter.dispose();
    }

    expect(manager.undoLabel).toBe('Fillet four corners');
    manager.undo();
    expect(findSketch(manager.document, rectangle.sketchId)?.objectIds).toEqual(
      sketch.objectIds
    );
    expect(
      findSketch(manager.document, rectangle.sketchId)?.constraints
    ).toEqual(sketch.constraints);
    manager.redo();
    expect(findSketch(manager.document, rectangle.sketchId)?.objectIds).toEqual(
      after.objectIds
    );
    expect(
      findSketch(manager.document, rectangle.sketchId)?.constraints
    ).toEqual(after.constraints);
  });
});
