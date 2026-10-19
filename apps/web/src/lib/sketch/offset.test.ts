import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type EntityId,
  type ParamValue,
  type SketchObjectData
} from '@openzcad/shared';
import {
  centerRectangleShape,
  compositeCommands,
  cornerRectangleShape
} from './composites';
import { planSketchConstructionToggle } from './modify';
import {
  offsetClickSide,
  planSketchOffset,
  resolveOffsetSource,
  type SketchOffsetPick
} from './offset';

const resolve = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);

const MITER: SketchOffsetPick = { join: 'miter', chain: true, side: 1 };
const ROUND: SketchOffsetPick = { join: 'round', chain: true, side: 1 };

function sketchWith(objects: SketchObjectData[]) {
  const manager = new CommandManager(
    createProjectDocument('Offset', toUserId('user_offset'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Offset',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const sketch = () => findSketch(manager.document, sketchId)!;
  const ids = sketch().objectIds.map(String);
  const object = (id: string) => {
    const node = manager.document.nodes[id as EntityId];
    if (node?.kind !== 'sketch-object') throw new Error(`no object ${id}`);
    return node.data;
  };
  /** The objects the last transaction added. */
  const addedSince = (before: readonly string[]) =>
    sketch()
      .objectIds.map(String)
      .filter((id) => !before.includes(id))
      .map(object);
  const plan = (seed: string, distance: number, pick: SketchOffsetPick) =>
    planSketchOffset(
      manager.document,
      sketch(),
      sketchId,
      seed,
      distance,
      pick,
      resolve
    );
  /** Run a plan as one transaction, every optional link kept. */
  const commit = (seed: string, distance: number, pick: SketchOffsetPick) => {
    const planned = plan(seed, distance, pick);
    if (planned.status !== 'commands') throw new Error(planned.reason);
    const before = sketch().objectIds.map(String);
    manager.execute(
      composeCommands(planned.label, [
        ...planned.commands,
        ...(planned.optional ?? [])
      ])
    );
    return { planned, added: addedSince(before) };
  };
  return { manager, sketchId, sketch, ids, object, plan, commit };
}

function lines(objects: readonly SketchObjectData[]) {
  return objects.flatMap((object) =>
    object.objectKind === 'line'
      ? [
          {
            x1: Number(object.x1),
            y1: Number(object.y1),
            x2: Number(object.x2),
            y2: Number(object.y2)
          }
        ]
      : []
  );
}

function bounds(objects: readonly SketchObjectData[]) {
  const ls = lines(objects);
  const xs = ls.flatMap((line) => [line.x1, line.x2]);
  const ys = ls.flatMap((line) => [line.y1, line.y2]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

/** A 20 × 12 rectangle drawn with the Rectangle tool: four held lines. */
function rectangleFixture() {
  const fixture = sketchWith([
    { objectKind: 'circle', centerX: 100, centerY: 0, radius: 5 }
  ]);
  const shape = cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!;
  const commit = compositeCommands(shape, {
    kind: 'sketch',
    sketchId: fixture.sketchId
  });
  fixture.manager.execute(composeCommands(commit.label, commit.commands));
  return { ...fixture, edgeIds: commit.edgeIds.map(String) };
}

describe('sketch offset: chains and joins (ZC-015)', () => {
  it('offsets a 20 × 12 rectangle outward by 1 with a miter to exactly 22 × 14', () => {
    const { commit, edgeIds, manager, sketch, sketchId } = rectangleFixture();
    const { added, planned } = commit(edgeIds[0]!, 1, MITER);
    expect(added).toHaveLength(4);
    expect(added.every((object) => object.objectKind === 'line')).toBe(true);
    const size = bounds(added);
    expect(size.width).toBeCloseTo(22, 12);
    expect(size.height).toBeCloseTo(14, 12);
    // The corners are exact: every new line ends on another one.
    for (const line of lines(added)) {
      expect([-1, 21]).toContainEqual(
        expect.closeTo(Math.min(line.x1, line.x2), 12)
      );
    }
    expect(planned.label).toBe('Offset');
    manager.undo();
    expect(sketch().objectIds).toHaveLength(5);
    expect(findSketch(manager.document, sketchId)!.composites).toHaveLength(1);
  });

  it('rounds the corners with radius-1 arcs about the source corners', () => {
    const { commit, edgeIds } = rectangleFixture();
    const { added } = commit(edgeIds[2]!, 1, ROUND);
    const arcs = added.filter((object) => object.objectKind === 'arc');
    expect(arcs).toHaveLength(4);
    expect(added.filter((object) => object.objectKind === 'line')).toHaveLength(
      4
    );
    const centres = arcs.map((arc) =>
      arc.objectKind === 'arc'
        ? `${Number(arc.centerX)},${Number(arc.centerY)},${Number(arc.radius)}`
        : ''
    );
    expect(centres.sort()).toEqual(['0,0,1', '0,12,1', '20,0,1', '20,12,1']);
    // The lines keep the source's length; the arcs carry the corners.
    expect(bounds(added)).toEqual({ width: 22, height: 14 });
  });

  it('offsets inward without corner arcs, and refuses once the loop collapses', () => {
    const { commit, plan, edgeIds } = rectangleFixture();
    const inward = plan(edgeIds[1]!, -6, ROUND);
    expect(inward.status).toBe('refuse');
    expect(inward.status === 'refuse' && inward.reason).toMatch(
      /smaller distance/
    );
    const { added } = commit(edgeIds[1]!, -2, ROUND);
    expect(added.every((object) => object.objectKind === 'line')).toBe(true);
    expect(bounds(added)).toEqual({ width: 16, height: 8 });
  });

  it('follows an open chain to the side of the click, mitered or round', () => {
    // An L: up the y axis, then along x.
    const { commit, ids, manager, sketch } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    ]);
    // The first line runs downward, so the click at x = -0.1 is its right.
    const side = offsetClickSide(
      manager.document,
      sketch(),
      ids[0]!,
      { x: -0.1, y: 5 },
      resolve
    );
    expect(side).toBe(-1);
    const outside = commit(ids[0]!, 1, { ...MITER, side });
    expect(lines(outside.added)).toEqual([
      { x1: -1, y1: 10, x2: -1, y2: -1 },
      { x1: -1, y1: -1, x2: 10, y2: -1 }
    ]);
    const inside = commit(ids[1]!, 1, { ...ROUND, side: 1 });
    // Inside the corner the two offsets overlap and are trimmed: no arc.
    expect(lines(inside.added)).toEqual([
      { x1: 1, y1: 10, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 10, y2: 1 }
    ]);
  });

  it('offsets a slot, a loop with arcs, along concentric arcs', () => {
    const { commit, plan, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: -2, x2: 10, y2: -2 },
      {
        objectKind: 'arc',
        centerX: 10,
        centerY: 0,
        radius: 2,
        startAngleDeg: -90,
        endAngleDeg: 90
      },
      { objectKind: 'line', x1: 10, y1: 2, x2: 0, y2: 2 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 2,
        startAngleDeg: 90,
        endAngleDeg: 270
      }
    ]);
    const { added } = commit(ids[0]!, 0.5, MITER);
    expect(added).toHaveLength(4);
    const radii = added.flatMap((object) =>
      object.objectKind === 'arc' ? [Number(object.radius)] : []
    );
    expect(radii).toEqual([2.5, 2.5]);
    expect(commit(ids[1]!, -1.5, MITER).added).toHaveLength(4);
    expect(plan(ids[2]!, -2, MITER)).toEqual({
      status: 'refuse',
      reason:
        'That offset shrinks a radius-2 arc to nothing. Use a distance under 2.'
    });
  });

  it('refuses an offset that passes too near the source between its ends', () => {
    // A hook whose last leg stops 1.5 above the first: the first leg's
    // offset at y = 1 runs 0.5 from that leg's end at (10, 1.5), though
    // every point a fixed sampling would check stays 1 away.
    const { plan, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 100, y2: 0 },
      { objectKind: 'line', x1: 100, y1: 0, x2: 100, y2: 10 },
      { objectKind: 'line', x1: 100, y1: 10, x2: 10, y2: 10 },
      { objectKind: 'line', x1: 10, y1: 10, x2: 10, y2: 1.5 }
    ]);
    expect(plan(ids[0]!, 1, MITER)).toEqual({
      status: 'refuse',
      reason: 'That offset collapses through the chain. Use a smaller distance.'
    });
    // Half the gap clears it.
    expect(plan(ids[0]!, 0.7, MITER).status).toBe('commands');
  });

  it('stops a chain where it branches, and offsets one curve with Chain off', () => {
    const { manager, sketch, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 10, y1: 0, x2: 20, y2: 0 },
      { objectKind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
      { objectKind: 'line', x1: 20, y1: 0, x2: 20, y2: 10 }
    ]);
    const branching = resolveOffsetSource(
      manager.document,
      sketch(),
      ids[0]!,
      true,
      resolve
    );
    if ('error' in branching) throw new Error(branching.error);
    expect(
      branching.source.kind === 'chain' && branching.source.members.length
    ).toBe(1);
    const run = resolveOffsetSource(
      manager.document,
      sketch(),
      ids[3]!,
      true,
      resolve
    );
    if ('error' in run) throw new Error(run.error);
    // Up the right side and back along to the branch at x = 10.
    expect(run.source.kind === 'chain' && run.source.members.length).toBe(2);
    const single = resolveOffsetSource(
      manager.document,
      sketch(),
      ids[3]!,
      false,
      resolve
    );
    if ('error' in single) throw new Error(single.error);
    expect(single.source.kind === 'chain' && single.source.members.length).toBe(
      1
    );
  });

  it("walks a centre rectangle's outline past its construction diagonals", () => {
    const fixture = sketchWith([]);
    const shape = centerRectangleShape({ x: 0, y: 0 }, { x: 5, y: 3 })!;
    const commit = compositeCommands(shape, {
      kind: 'sketch',
      sketchId: fixture.sketchId
    });
    fixture.manager.execute(composeCommands(commit.label, commit.commands));
    const { added } = fixture.commit(String(commit.edgeIds[0]!), 1, MITER);
    expect(added).toHaveLength(4);
    expect(bounds(added)).toEqual({ width: 12, height: 8 });
  });
});

describe('sketch offset: single curves (ZC-014)', () => {
  it('grows and shrinks a radius-5 circle, and refuses -5 with nothing changed', () => {
    const { commit, plan, ids, manager } = rectangleFixture();
    const circle = ids[0]!;
    const radiusOf = (objects: readonly SketchObjectData[]) =>
      objects[0]!.objectKind === 'circle' ? Number(objects[0]!.radius) : NaN;
    expect(radiusOf(commit(circle, 1, MITER).added)).toBe(6);
    expect(radiusOf(commit(circle, -1, MITER).added)).toBe(4);
    const before = manager.document;
    expect(plan(circle, -5, MITER)).toEqual({
      status: 'refuse',
      reason:
        'A radius-5 circle offset by -5 would have no radius left. Use an offset smaller than 5.'
    });
    expect(manager.document).toBe(before);
    // One undo removes one offset.
    manager.undo();
    expect(manager.document.nodes).not.toBe(before.nodes);
  });

  it('copies one line at its own length, and a lone arc outward', () => {
    const { commit, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 8, y2: 0 },
      {
        objectKind: 'arc',
        centerX: 20,
        centerY: 0,
        radius: 3,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    expect(lines(commit(ids[0]!, 2, { ...MITER, side: 1 }).added)).toEqual([
      { x1: 0, y1: 2, x2: 8, y2: 2 }
    ]);
    expect(lines(commit(ids[0]!, 2, { ...MITER, side: -1 }).added)).toEqual([
      { x1: 0, y1: -2, x2: 8, y2: -2 }
    ]);
    const arc = commit(ids[1]!, 1, MITER).added[0]!;
    expect(arc).toMatchObject({
      objectKind: 'arc',
      centerX: 20,
      centerY: 0,
      radius: 4,
      startAngleDeg: 0,
      endAngleDeg: 90
    });
  });

  it('keeps construction geometry construction', () => {
    const { commit, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 8, y2: 0, construction: true }
    ]);
    expect(commit(ids[0]!, 1, MITER).added[0]!.construction).toBe(true);
  });
});

describe('make construction / make regular (ZC-024)', () => {
  it('removes a closed profile when one side turns construction, and undo restores it', () => {
    const { manager, sketch, sketchId, edgeIds } = rectangleFixture();
    const profiles = () =>
      computeSketchProfileAnalysis(
        sketch().objectIds.flatMap((id) => {
          const node = manager.document.nodes[id];
          return node?.kind === 'sketch-object'
            ? [{ id: String(id), data: node.data }]
            : [];
        }),
        (value) => resolve(value) ?? Number.NaN
      ).profiles.length;
    // The rectangle and the circle.
    expect(profiles()).toBe(2);
    const plan = planSketchConstructionToggle(
      manager.document,
      sketch(),
      sketchId,
      edgeIds[1]!
    );
    if (plan.status !== 'commands') throw new Error(plan.reason);
    expect(plan.label).toBe('Make construction');
    manager.execute(composeCommands(plan.label, plan.commands));
    expect(profiles()).toBe(1);
    const node = manager.document.nodes[edgeIds[1]! as EntityId];
    expect(node?.kind === 'sketch-object' && node.data.construction).toBe(true);
    // The side stays a composite member and keeps its relations.
    expect(sketch().composites?.[0]?.edgeIds.map(String)).toEqual(edgeIds);
    manager.undo();
    expect(profiles()).toBe(2);
    expect(manager.canUndo).toBe(true);
  });

  it('makes construction geometry regular again, dropping the flag', () => {
    const { manager, sketch, sketchId, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 8, y2: 0, construction: true }
    ]);
    const plan = planSketchConstructionToggle(
      manager.document,
      sketch(),
      sketchId,
      ids[0]!
    );
    if (plan.status !== 'commands') throw new Error(plan.reason);
    expect(plan.label).toBe('Make regular');
    manager.execute(composeCommands(plan.label, plan.commands));
    const node = manager.document.nodes[ids[0]! as EntityId];
    expect(node?.kind === 'sketch-object' && 'construction' in node.data).toBe(
      false
    );
  });
});
