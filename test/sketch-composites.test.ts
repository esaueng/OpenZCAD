import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  composeCommands,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  resolveSketchComposite,
  toUserId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import {
  centerRectangleShape,
  compositeCommands,
  compositeMemberUpdates,
  cornerRectangleShape,
  inscribedPolygonShape,
  isCompositeShape,
  rectangleSize,
  resizedPolygon,
  resizedRectangleCorners,
  threePointRectangleShape,
  THREE_POINT_COLLINEAR_REFUSAL,
  type CompositeShape
} from '../apps/web/src/lib/sketch/composites';
import { sketchEntitiesEditCommands } from '../apps/web/src/lib/sketch/editing';

/**
 * S04 composite identity on the pinned kernel's solver: each drawing tool's
 * relations must solve without redundancy, leave exactly the shape's own
 * freedom, hold the shape through an edit, and replay from the document.
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

function draw(shape: CompositeShape | null | { refusal: string }) {
  if (!shape || !isCompositeShape(shape)) throw new Error('no shape');
  const initial = createProjectDocument('S04', toUserId('user_s04'));
  const manager = new CommandManager(initial);
  const commit = compositeCommands(shape, {
    kind: 'new-sketch',
    name: 'Composite',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
  });
  manager.execute(composeCommands(commit.label, commit.commands));
  const sketchId = commit.sketchId;
  const sketch = () => findSketch(manager.document, sketchId)!;
  const objects = (document: ProjectDocument = manager.document) =>
    new Map(
      findSketch(document, sketchId)!.objectIds.flatMap((id) => {
        const node = document.nodes[id];
        return node?.kind === 'sketch-object'
          ? [[String(id), node.data] as const]
          : [];
      })
    );
  const corners = (document: ProjectDocument = manager.document) => {
    const composite = findSketch(document, sketchId)!.composites![0]!;
    const resolved = resolveSketchComposite(
      composite,
      objects(document),
      resolve
    );
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    return resolved.corners;
  };
  const solve = () => adapter.solveSketch(manager.document, sketchId);
  return {
    initial,
    manager,
    sketchId,
    commit,
    sketch,
    objects,
    corners,
    solve
  };
}

function expectShapeFreedom(outcome: SketchSolveOutcome, freedom: number) {
  expect(outcome.converged).toBe(true);
  expect(outcome.rolledBack).toBe(false);
  expect(outcome.classification).toBe('underConstrained');
  // No relation the tool wrote is redundant, and what is left free is the
  // shape's own freedom, nothing more.
  expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
  expect(outcome.dof.dof).toBe(freedom);
}

function regions(objects: Map<string, SketchObjectData>) {
  return computeSketchRegions(
    [...objects].map(([id, data]) => ({ id, data })),
    resolve
  );
}

const close = (actual: { x: number; y: number }[], expected: number[][]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index]![0]!, 9);
    expect(point.y).toBeCloseTo(expected[index]![1]!, 9);
  });
};

async function resize(
  fixture: ReturnType<typeof draw>,
  corners: { x: number; y: number }[],
  circle?: { center: { x: number; y: number }; radius: number }
) {
  const composite = fixture.sketch().composites![0]!;
  const commands = await sketchEntitiesEditCommands(
    fixture.manager.document,
    fixture.sketchId,
    compositeMemberUpdates(composite, corners, fixture.objects(), circle),
    (document, id) => adapter.solveSketch(document, id),
    'Resize'
  );
  fixture.manager.execute(composeCommands('Resize', commands));
}

describe('S04 composite drawing on the pinned kernel', () => {
  it('a diagonal rectangle (0,0)–(20,12) is four held lines bounding 240 with perimeter 64', async () => {
    const fixture = draw(
      cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })
    );
    const sketch = fixture.sketch();
    expect(sketch.objectIds).toHaveLength(4);
    expect(
      sketch.objectIds.map((id) => fixture.manager.document.nodes[id]?.kind)
    ).toEqual([
      'sketch-object',
      'sketch-object',
      'sketch-object',
      'sketch-object'
    ]);
    expect(sketch.composites).toEqual([
      {
        compositeId: fixture.commit.compositeId,
        compositeKind: 'rectangle',
        method: 'corner',
        edgeIds: fixture.commit.edgeIds
      }
    ]);
    // Four corners and four horizontal/vertical sides, nothing else.
    expect(
      sketch.constraints!.map((constraint) => constraint.data.constraintKind)
    ).toEqual([
      'coincident',
      'coincident',
      'coincident',
      'coincident',
      'horizontal',
      'vertical',
      'horizontal',
      'vertical'
    ]);
    close(fixture.corners(), [
      [0, 0],
      [20, 0],
      [20, 12],
      [0, 12]
    ]);
    const [region] = regions(fixture.objects());
    expect(region!.area).toBeCloseTo(240, 9);
    const perimeter = fixture.commit.edgeIds.reduce((sum, id) => {
      const line = fixture.objects().get(id)!;
      if (line.objectKind !== 'line') throw new Error('not a line');
      return (
        sum +
        Math.hypot(
          resolve(line.x2) - resolve(line.x1),
          resolve(line.y2) - resolve(line.y1)
        )
      );
    }, 0);
    expect(perimeter).toBeCloseTo(64, 9);
    // Position and size: four degrees of freedom.
    expectShapeFreedom(await fixture.solve(), 4);
  });

  it('an edit that would tilt a side is held by the rectangle’s relations, and nothing is saved', async () => {
    const fixture = draw(
      cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })
    );
    const side0 = fixture.commit.edgeIds[0]!;
    const before = fixture.manager.document;
    const line = fixture.objects().get(side0)!;
    if (line.objectKind !== 'line') throw new Error('not a line');
    await expect(
      sketchEntitiesEditCommands(
        before,
        fixture.sketchId,
        [{ objectId: side0, data: { ...line, y2: 3 } }],
        (document, id) => adapter.solveSketch(document, id)
      )
    ).rejects.toThrow('A constraint controls a value you changed');
    expect(fixture.manager.document).toBe(before);
    close(fixture.corners(), [
      [0, 0],
      [20, 0],
      [20, 12],
      [0, 12]
    ]);
  });

  it('a centre rectangle at (5,7), 20×12, has corners (−5,1)/(15,13) and keeps its centre on resize', async () => {
    const fixture = draw(
      centerRectangleShape({ x: 5, y: 7 }, { x: 15, y: 13 })
    );
    const corners = fixture.corners();
    close(corners, [
      [-5, 1],
      [15, 1],
      [15, 13],
      [-5, 13]
    ]);
    const composite = fixture.sketch().composites![0]!;
    expect(composite.method).toBe('center');
    // Two construction diagonals, whose crossing is the centre.
    expect(composite.helperIds).toHaveLength(2);
    for (const id of composite.helperIds!) {
      expect(fixture.objects().get(id)).toMatchObject({
        objectKind: 'line',
        construction: true
      });
    }
    // The diagonals are construction: one region, the rectangle itself.
    expect(regions(fixture.objects())).toHaveLength(1);
    expectShapeFreedom(await fixture.solve(), 4);

    const resized = resizedRectangleCorners(corners, 'center', 30, 10)!;
    await resize(fixture, resized);
    close(fixture.corners(), [
      [-10, 2],
      [20, 2],
      [20, 12],
      [-10, 12]
    ]);
    const after = fixture.corners();
    expect((after[0]!.x + after[2]!.x) / 2).toBeCloseTo(5, 9);
    expect((after[0]!.y + after[2]!.y) / 2).toBeCloseTo(7, 9);
  });

  it('a corner rectangle resizes about corner 0', async () => {
    const fixture = draw(
      cornerRectangleShape({ x: 2, y: 3 }, { x: 22, y: 15 })
    );
    await resize(
      fixture,
      resizedRectangleCorners(fixture.corners(), 'corner', 8, 4)!
    );
    close(fixture.corners(), [
      [2, 3],
      [10, 3],
      [10, 7],
      [2, 7]
    ]);
  });

  it('a three-point rectangle is rotated, held square and refuses a collinear third point', async () => {
    expect(
      threePointRectangleShape(
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 4, y: 0.1 }
      )
    ).toHaveProperty('refusal', THREE_POINT_COLLINEAR_REFUSAL);
    const shape = threePointRectangleShape(
      { x: 0, y: 0 },
      { x: 8, y: 6 },
      { x: 5, y: 10 }
    );
    const fixture = draw(shape);
    const corners = fixture.corners();
    // Side 0 is the first two clicks; the height is the third point's
    // distance from that side's line, 5 along its left normal.
    close(corners, [
      [0, 0],
      [8, 6],
      [5, 10],
      [-3, 4]
    ]);
    const size = rectangleSize(corners);
    expect(size.width).toBeCloseTo(10, 9);
    expect(size.height).toBeCloseTo(5, 9);
    const [region] = regions(fixture.objects());
    expect(region!.area).toBeCloseTo(50, 9);
    expect(
      fixture
        .sketch()
        .constraints!.map((c) => c.data.constraintKind)
        .slice(4)
    ).toEqual(['perpendicular', 'parallel', 'parallel']);
    // Rotation as well as position and size: five.
    expectShapeFreedom(await fixture.solve(), 5);
    // A third point on the clockwise side still walks counter-clockwise,
    // and side 0 is still the picked side: width 10 along it, height 4.
    const below = threePointRectangleShape(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 3, y: -4 }
    );
    expect(isCompositeShape(below) && below.corners).toEqual([
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: -4 },
      { x: 10, y: -4 }
    ]);
    expect(isCompositeShape(below) && rectangleSize(below.corners)).toEqual({
      width: 10,
      height: 4
    });
    // Resizing keeps the rotation and corner 0.
    await resize(
      fixture,
      resizedRectangleCorners(corners, 'three-point', 5, 5)!
    );
    close(fixture.corners(), [
      [0, 0],
      [4, 3],
      [1, 7],
      [-3, 4]
    ]);
  });

  it('a hexagon of circumradius 10 has sides of 10 and solves with four degrees of freedom', async () => {
    const fixture = draw(
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 10, y: 0 }, 6)
    );
    const composite = fixture.sketch().composites![0]!;
    expect(composite).toMatchObject({
      compositeKind: 'polygon',
      method: 'inscribed'
    });
    expect(composite.edgeIds).toHaveLength(6);
    const circle = fixture.objects().get(composite.helperIds![0]!);
    expect(circle).toMatchObject({
      objectKind: 'circle',
      radius: 10,
      construction: true
    });
    const corners = fixture.corners();
    expect(corners[0]).toEqual({ x: 10, y: 0 });
    for (let index = 0; index < 6; index += 1) {
      const a = corners[index]!;
      const b = corners[(index + 1) % 6]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(10, 9);
    }
    const [region] = regions(fixture.objects());
    expect(region!.area).toBeCloseTo((3 * Math.sqrt(3) * 100) / 2, 9);
    // Centre, circumradius and rotation.
    expectShapeFreedom(await fixture.solve(), 4);
    const grown = resizedPolygon(corners, { x: 0, y: 0 }, 12)!;
    await resize(fixture, grown.corners, grown);
    for (const [index, corner] of fixture.corners().entries()) {
      const angle = (index * Math.PI) / 3;
      expect(corner.x).toBeCloseTo(12 * Math.cos(angle), 9);
      expect(corner.y).toBeCloseTo(12 * Math.sin(angle), 9);
    }
  });

  it.each([3, 5, 8, 64])(
    'a %i-sided polygon solves without a redundant relation',
    async (sides) => {
      const fixture = draw(
        inscribedPolygonShape({ x: 1, y: 2 }, { x: 1, y: 42 }, sides)
      );
      expectShapeFreedom(await fixture.solve(), 4);
    }
  );

  it('stops naming a loop a rectangle or polygon once its shape no longer holds', () => {
    const rectangle = draw(
      cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })
    );
    const composite = rectangle.sketch().composites![0]!;
    const moved = (
      objects: Map<string, SketchObjectData>,
      changes: Record<
        string,
        Partial<Record<'x1' | 'y1' | 'x2' | 'y2', number>>
      >
    ) =>
      new Map(
        [...objects].map(([id, data]) => [
          id,
          { ...data, ...(changes[id] ?? {}) }
        ])
      );
    const [, s1, s2] = composite.edgeIds;
    // Corner 2 pulled off square: still a closed loop, no longer a rectangle.
    const skewed = resolveSketchComposite(
      composite,
      moved(rectangle.objects(), { [s1!]: { x2: 25 }, [s2!]: { x1: 25 } }),
      resolve
    );
    expect(skewed).toEqual({
      status: 'broken',
      reason: expect.stringContaining('no longer square') as unknown
    });
    // Rotated as a whole: square, but a corner rectangle is axis-aligned.
    const turn = (x: number, y: number) => ({ x: -y, y: x });
    const rotated = new Map(
      [...rectangle.objects()].map(([id, data]) => {
        const line = data as Extract<SketchObjectData, { objectKind: 'line' }>;
        const a = turn(Number(line.x1), Number(line.y1));
        const b = turn(Number(line.x2), Number(line.y2));
        return [id, { ...line, x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
      })
    );
    expect(resolveSketchComposite(composite, rotated, resolve)).toMatchObject({
      status: 'broken',
      reason: 'The rectangle is no longer axis-aligned.'
    });

    const polygon = draw(
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)
    );
    const square = polygon.sketch().composites![0]!;
    const [p0, p1] = square.edgeIds as [EntityId, EntityId];
    // One vertex pushed outward: sides unequal, off the circumcircle.
    const pushed = moved(polygon.objects(), {
      [p0]: { x2: 0, y2: 12 },
      [p1]: { x1: 0, y1: 12 }
    });
    expect(resolveSketchComposite(square, pushed, resolve)).toMatchObject({
      status: 'broken',
      reason: 'The polygon’s sides are no longer equal.'
    });
    // A pentagram: equal sides, every vertex on the circle, centred, and
    // still not a pentagon.
    const pentagon = draw(
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 10, y: 0 }, 5)
    );
    const ring = pentagon.sketch().composites![0]!;
    const star = new Map(pentagon.objects());
    for (const [index, id] of ring.edgeIds.entries()) {
      const at = (step: number) => {
        const angle = (step * 2 * 2 * Math.PI) / 5;
        return { x: 10 * Math.cos(angle), y: 10 * Math.sin(angle) };
      };
      const a = at(index);
      const b = at(index + 1);
      star.set(id, { objectKind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    expect(resolveSketchComposite(ring, star, resolve)).toMatchObject({
      status: 'broken',
      reason:
        'The polygon’s sides no longer run round its circumcircle in order.'
    });
    const withoutCircle = new Map(polygon.objects());
    withoutCircle.delete(square.helperIds![0]!);
    expect(
      resolveSketchComposite(square, withoutCircle, resolve)
    ).toMatchObject({
      status: 'broken',
      reason: 'The polygon’s circumcircle is missing.'
    });
  });

  it('replays, reloads and undoes as one object with the same identities', () => {
    const fixture = draw(
      inscribedPolygonShape({ x: 0, y: 0 }, { x: 0, y: 10 }, 5)
    );
    const document = fixture.manager.document;
    const replayed = replayCommands(fixture.initial, document.commandLog);
    expect(findSketch(replayed, fixture.sketchId)).toEqual(fixture.sketch());
    const reloaded = normalizeDocument(
      JSON.parse(JSON.stringify(document)) as ProjectDocument
    );
    expect(findSketch(reloaded, fixture.sketchId)!.composites).toEqual(
      fixture.sketch().composites
    );
    expect(findSketch(reloaded, fixture.sketchId)!.constraints).toEqual(
      fixture.sketch().constraints
    );
    fixture.manager.undo();
    expect(fixture.manager.document.sketchOrder).toEqual([]);
    fixture.manager.redo();
    expect(fixture.sketch().composites).toEqual(
      findSketch(document, fixture.sketchId)!.composites
    );
    expect(fixture.sketch().objectIds).toEqual(
      findSketch(document, fixture.sketchId)!.objectIds
    );
  });

  it('a second shape joins an existing sketch, and deleting a side dissolves only its own record', () => {
    const fixture = draw(
      cornerRectangleShape({ x: 0, y: 0 }, { x: 10, y: 10 })
    );
    const second = compositeCommands(
      centerRectangleShape({ x: 30, y: 0 }, { x: 35, y: 5 })!,
      { kind: 'sketch', sketchId: fixture.sketchId }
    );
    fixture.manager.execute(composeCommands(second.label, second.commands));
    expect(fixture.sketch().composites).toHaveLength(2);
    const before = fixture.sketch();
    fixture.manager.execute(
      commandFactories.deleteSketchObject({
        sketchId: fixture.sketchId,
        objectId: fixture.commit.edgeIds[1]!
      })
    );
    const after = fixture.sketch();
    expect(after.composites!.map((c) => c.compositeId)).toEqual([
      second.compositeId
    ]);
    // The other three sides stay, as ordinary lines with their relations.
    expect(after.objectIds).toHaveLength(before.objectIds.length - 1);
    expect(after.constraints!.length).toBeLessThan(before.constraints!.length);
    fixture.manager.undo();
    expect(fixture.sketch()).toEqual(before);
  });

  it('a construction shape keeps its sides construction', () => {
    const shape = cornerRectangleShape({ x: 0, y: 0 }, { x: 4, y: 4 })!;
    const commit = compositeCommands(
      shape,
      { kind: 'sketch', sketchId: 'sketch_x' as SketchId },
      { construction: true }
    );
    const add = commit.commands[0]!.payload as {
      objects: SketchObjectData[];
      ids: { objectNodeIds: EntityId[] };
    };
    expect(add.objects.every((object) => object.construction)).toBe(true);
    expect(add.ids.objectNodeIds).toEqual(commit.edgeIds);
  });
});
