import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type {
  SketchChamferGeometry,
  SketchFilletGeometry,
  SketchOffsetCurve
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchId,
  type SketchNode,
  type SketchObjectData
} from '@openzcad/shared';
import {
  SKETCH_EDIT_TOOL_SPECS,
  advanceSketchEditPick,
  planSketchEdit,
  refuseEditPick,
  resolveSketchCorner,
  resolveSketchLoop,
  sketchChamferCommands,
  sketchEditToolSpec,
  sketchFilletCommands,
  sketchOffsetCommands
} from './edits';

const resolve = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);

/**
 * An L of two lines meeting at the origin, a closed square, and one
 * rectangle: enough to exercise every refusal and both corner tools.
 */
function fixture() {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Sketch edits', toUserId('user_edits')),
    {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 40,
          centerY: 0
        },
        { objectKind: 'circle', radius: 2, centerX: 60, centerY: 0 },
        { objectKind: 'line', x1: 100, y1: 0, x2: 110, y2: 0 },
        { objectKind: 'line', x1: 110, y1: 0, x2: 110, y2: 10 },
        { objectKind: 'line', x1: 110, y1: 10, x2: 100, y2: 10 },
        { objectKind: 'line', x1: 100, y1: 10, x2: 100, y2: 0 }
      ]
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const ids = sketch.objectIds;
  return {
    document,
    sketchId,
    sketch,
    legA: String(ids[0]!),
    legB: String(ids[1]!),
    rectangle: String(ids[2]!),
    circle: String(ids[3]!),
    loopSeed: String(ids[4]!)
  };
}

function apply(
  document: ProjectDocument,
  commands: ReturnType<typeof sketchFilletCommands>
): ProjectDocument {
  return commands.reduce((current, command) => {
    command.validate(current);
    return command.apply(current);
  }, document);
}

function sketchObject(
  document: ProjectDocument,
  objectId: string
): SketchObjectData {
  const node = document.nodes[objectId as EntityId];
  if (node?.kind !== 'sketch-object') {
    throw new Error(`No sketch object ${objectId}.`);
  }
  return node.data;
}

async function withAdapter<T>(
  run: (
    adapter: Awaited<ReturnType<typeof createExactKernelAdapter>>
  ) => Promise<T>
): Promise<T> {
  const adapter = await createExactKernelAdapter();
  try {
    return await run(adapter);
  } finally {
    adapter.dispose();
  }
}

async function filletGeometry(
  document: ProjectDocument,
  sketch: SketchNode,
  legA: string,
  legB: string,
  radius: number
): Promise<SketchFilletGeometry> {
  const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
  if ('error' in resolved) {
    throw new Error(resolved.error);
  }
  const result = await withAdapter((adapter) =>
    adapter.sketchPlanarOperation({
      kind: 'fillet',
      corner: resolved.corner,
      radius
    })
  );
  if (result.kind !== 'fillet') {
    throw new Error('Expected a fillet result.');
  }
  return result.fillet;
}

async function chamferGeometry(
  document: ProjectDocument,
  sketch: SketchNode,
  legA: string,
  legB: string,
  distance: number
): Promise<SketchChamferGeometry> {
  const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
  if ('error' in resolved) {
    throw new Error(resolved.error);
  }
  const result = await withAdapter((adapter) =>
    adapter.sketchPlanarOperation({
      kind: 'chamfer',
      corner: resolved.corner,
      distance
    })
  );
  if (result.kind !== 'chamfer') {
    throw new Error('Expected a chamfer result.');
  }
  return result.chamfer;
}

describe('sketch modify tool picking', () => {
  it('offers one spec per rail tool', () => {
    expect(SKETCH_EDIT_TOOL_SPECS.map((spec) => spec.kind)).toEqual([
      'fillet',
      'chamfer',
      'offset'
    ]);
    expect(sketchEditToolSpec('fillet').picks).toBe(2);
    expect(sketchEditToolSpec('offset').picks).toBe(1);
  });

  it('refuses a rectangle by name, for every tool', () => {
    const { document, sketch, rectangle } = fixture();
    for (const kind of ['fillet', 'chamfer', 'offset'] as const) {
      const refusal = refuseEditPick(document, sketch, kind, [], rectangle);
      expect(refusal).toBe(
        'A rectangle is one object, and its corners carry no constraints. Draw the profile as lines to modify a corner.'
      );
    }
  });

  it('refuses a circle, a repeat pick, and a foreign object', () => {
    const { document, sketch, circle, legA } = fixture();
    expect(refuseEditPick(document, sketch, 'fillet', [], circle)).toMatch(
      /two lines that meet at a corner/
    );
    expect(refuseEditPick(document, sketch, 'fillet', [legA], legA)).toBe(
      'That entity is already part of this operation.'
    );
    expect(refuseEditPick(document, sketch, 'fillet', [], 'ent_nope')).toBe(
      'That object is not part of this sketch.'
    );
  });

  it('accepts two lines and finds the endpoint they share', () => {
    const { document, sketch, legA, legB } = fixture();
    expect(refuseEditPick(document, sketch, 'fillet', [], legA)).toBeNull();
    expect(refuseEditPick(document, sketch, 'fillet', [legA], legB)).toBeNull();
    const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
    expect(resolved).toEqual({
      corner: {
        corner: { x: 0, y: 0 },
        farA: { x: 0, y: 10 },
        farB: { x: 10, y: 0 },
        aPoint: 'end',
        bPoint: 'start'
      }
    });
  });

  it('refuses two lines that do not meet, rather than extending them', () => {
    const { document, sketch, legA, loopSeed } = fixture();
    const resolved = resolveSketchCorner(
      document,
      sketch,
      legA,
      loopSeed,
      resolve
    );
    expect(resolved).toEqual({
      error:
        'Those two lines do not meet at an endpoint. Join them first — this tool does not extend geometry.'
    });
  });
});

describe('sketch fillet', () => {
  it('trims both lines, adds the arc, and states the joint to the solver', async () => {
    const { document, sketch, sketchId, legA, legB } = fixture();
    const fillet = await filletGeometry(document, sketch, legA, legB, 2);
    const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
    if ('error' in resolved) throw new Error(resolved.error);
    const commands = sketchFilletCommands(
      document,
      sketch,
      sketchId,
      { a: legA, b: legB },
      resolved.corner,
      fillet,
      2
    );
    const next = apply(document, commands);
    const nextSketch = findSketch(next, sketchId)!;

    const trimmedA = sketchObject(next, legA);
    const trimmedB = sketchObject(next, legB);
    if (trimmedA.objectKind !== 'line' || trimmedB.objectKind !== 'line') {
      throw new Error('Expected both legs to stay lines.');
    }
    expect(trimmedA.x2).toBeCloseTo(0, 9);
    expect(trimmedA.y2).toBeCloseTo(2, 9);
    expect(trimmedB.x1).toBeCloseTo(2, 9);
    expect(trimmedB.y1).toBeCloseTo(0, 9);

    const arcId = nextSketch.objectIds.find(
      (id) => !sketch.objectIds.includes(id)
    );
    expect(arcId).toBeDefined();
    const arc = sketchObject(next, String(arcId));
    if (arc.objectKind !== 'arc') {
      throw new Error('Expected an arc.');
    }
    expect(arc.centerX).toBeCloseTo(2, 9);
    expect(arc.centerY).toBeCloseTo(2, 9);
    expect(arc.radius).toBe(2);
    expect(Number(arc.endAngleDeg) - Number(arc.startAngleDeg)).toBeCloseTo(
      90,
      9
    );

    const kinds = (nextSketch.constraints ?? []).map(
      (constraint) => constraint.data.constraintKind
    );
    expect(kinds.filter((kind) => kind === 'coincident')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'tangent')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'radius')).toHaveLength(1);
    // Every new constraint names the arc: the fillet is in the graph, not
    // beside it.
    for (const constraint of nextSketch.constraints ?? []) {
      expect(JSON.stringify(constraint.data)).toContain(String(arcId));
    }
  });

  it('is one undo step', async () => {
    const { document, sketch, sketchId, legA, legB } = fixture();
    const fillet = await filletGeometry(document, sketch, legA, legB, 2);
    const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
    if ('error' in resolved) throw new Error(resolved.error);
    const manager = new CommandManager(document);
    const before = findSketch(manager.document, sketchId)!;
    manager.runTransaction(
      'Fillet',
      sketchFilletCommands(
        manager.document,
        sketch,
        sketchId,
        { a: legA, b: legB },
        resolved.corner,
        fillet,
        2
      )
    );
    const after = findSketch(manager.document, sketchId)!;
    expect(after.objectIds).toHaveLength(before.objectIds.length + 1);
    expect(after.constraints ?? []).toHaveLength(5);

    expect(manager.undoLabel).toBe('Fillet');
    manager.undo();
    const restored = findSketch(manager.document, sketchId)!;
    expect(restored.objectIds).toEqual(before.objectIds);
    expect(restored.constraints ?? []).toHaveLength(0);
    const restoredLeg = sketchObject(manager.document, legA);
    if (restoredLeg.objectKind !== 'line') throw new Error('Expected a line.');
    expect(restoredLeg.y2).toBe(0);
    // One step, not five: a second undo leaves the sketch alone.
    expect(manager.canUndo).toBe(false);
  });

  it('survives a driving-dimension change on either source line', async () => {
    for (const drivenLeg of ['a', 'b'] as const) {
      const { document, sketchId, legA, legB } = fixture();
      // The corner starts square, as a drawn profile would.
      let base = apply(document, [
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: { constraintKind: 'vertical', objectId: legA as EntityId }
        }),
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: {
            constraintKind: 'horizontal',
            objectId: legB as EntityId
          }
        })
      ]);
      const fillet = await filletGeometry(
        base,
        findSketch(base, sketchId)!,
        legA,
        legB,
        2
      );
      const resolved = resolveSketchCorner(
        base,
        findSketch(base, sketchId)!,
        legA,
        legB,
        resolve
      );
      if ('error' in resolved) throw new Error(resolved.error);
      base = apply(
        base,
        sketchFilletCommands(
          base,
          findSketch(base, sketchId)!,
          sketchId,
          { a: legA, b: legB },
          resolved.corner,
          fillet,
          2
        )
      );
      const driven = drivenLeg === 'a' ? legA : legB;
      const withDimension = apply(base, [
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: {
            constraintKind: 'distance',
            a: { objectId: driven as EntityId, point: 'start' },
            b: { objectId: driven as EntityId, point: 'end' },
            // Both source lines start 8 long after the fillet; drive one to 5.
            value: 5
          }
        })
      ]);

      const outcome = await withAdapter((adapter) =>
        adapter.solveSketch(withDimension, sketchId)
      );
      expect(outcome.converged).toBe(true);
      expect(outcome.rolledBack).toBe(false);

      const solvedArc = outcome.objects.find((object) => object.kind === 'arc');
      const solvedA = outcome.objects.find(
        (object) => String(object.objectId) === legA
      );
      const solvedB = outcome.objects.find(
        (object) => String(object.objectId) === legB
      );
      if (
        solvedArc?.kind !== 'arc' ||
        solvedA?.kind !== 'line' ||
        solvedB?.kind !== 'line'
      ) {
        throw new Error('Expected the fillet and both legs back.');
      }
      // The dimension moved.
      const drivenSolved = drivenLeg === 'a' ? solvedA : solvedB;
      expect(
        Math.hypot(
          drivenSolved.x2 - drivenSolved.x1,
          drivenSolved.y2 - drivenSolved.y1
        )
      ).toBeCloseTo(5, 6);
      // And the fillet came with it: still radius 2, still meeting both legs,
      // still perpendicular-distance 2 from each of them.
      expect(solvedArc.radius).toBeCloseTo(2, 6);
      for (const [line, corner] of [
        [solvedA, { x: solvedA.x2, y: solvedA.y2 }],
        [solvedB, { x: solvedB.x1, y: solvedB.y1 }]
      ] as const) {
        const dx = line.x2 - line.x1;
        const dy = line.y2 - line.y1;
        const length = Math.hypot(dx, dy);
        const lateral = Math.abs(
          ((solvedArc.centerX - line.x1) * dy -
            (solvedArc.centerY - line.y1) * dx) /
            length
        );
        expect(lateral).toBeCloseTo(2, 5);
        expect(
          Math.hypot(corner.x - solvedArc.centerX, corner.y - solvedArc.centerY)
        ).toBeCloseTo(2, 5);
      }
    }
  });
});

describe('sketch chamfer', () => {
  it('trims both lines to the kernel setback and joins them with a bevel', async () => {
    const { document, sketch, sketchId, legA, legB } = fixture();
    const chamfer = await chamferGeometry(document, sketch, legA, legB, 3);
    expect(chamfer.a).toEqual({ x: 0, y: 3 });
    expect(chamfer.b).toEqual({ x: 3, y: 0 });
    const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
    if ('error' in resolved) throw new Error(resolved.error);
    const manager = new CommandManager(document);
    manager.runTransaction(
      'Chamfer',
      sketchChamferCommands(
        document,
        sketch,
        sketchId,
        { a: legA, b: legB },
        resolved.corner,
        chamfer
      )
    );
    const next = findSketch(manager.document, sketchId)!;
    const bevelId = next.objectIds.find((id) => !sketch.objectIds.includes(id));
    const bevel = sketchObject(manager.document, String(bevelId));
    if (bevel.objectKind !== 'line') throw new Error('Expected a bevel line.');
    expect([bevel.x1, bevel.y1, bevel.x2, bevel.y2]).toEqual([0, 3, 3, 0]);
    expect(next.constraints ?? []).toHaveLength(2);
    expect(
      (next.constraints ?? []).every(
        (constraint) => constraint.data.constraintKind === 'coincident'
      )
    ).toBe(true);
    expect(manager.undoLabel).toBe('Chamfer');
    manager.undo();
    expect(manager.canUndo).toBe(false);
  });

  it('refuses a setback the legs cannot carry, and says by how much', async () => {
    const { document, sketch, legA, legB } = fixture();
    await expect(
      chamferGeometry(document, sketch, legA, legB, 12)
    ).rejects.toThrow(/only 10\.000 long/);
  });
});

describe('sketch offset', () => {
  it('walks the closed loop the picked line belongs to', () => {
    const { document, sketch, loopSeed } = fixture();
    const result = resolveSketchLoop(document, sketch, loopSeed, resolve);
    if ('error' in result) throw new Error(result.error);
    expect(result.loop.objectIds).toHaveLength(4);
    expect(result.loop.points).toHaveLength(4);
    expect(result.loop.points[0]).toEqual({ x: 100, y: 0 });
  });

  it('refuses an open run of lines', () => {
    const { document, sketch, legA } = fixture();
    expect(resolveSketchLoop(document, sketch, legA, resolve)).toEqual({
      error:
        'That run of lines is not closed. Offset needs a closed loop; close the profile first.'
    });
  });

  it('refuses a rectangle object and a circle', () => {
    const { document, sketch, rectangle, circle } = fixture();
    expect(refuseEditPick(document, sketch, 'offset', [], rectangle)).toMatch(
      /A rectangle is one object/
    );
    expect(refuseEditPick(document, sketch, 'offset', [], circle)).toBe(
      'Offset works on a closed loop of lines. Pick one of its lines.'
    );
  });

  it('adds the offset curves and chains them into a loop, in one undo step', async () => {
    const { document, sketch, sketchId, loopSeed } = fixture();
    const loop = resolveSketchLoop(document, sketch, loopSeed, resolve);
    if ('error' in loop) throw new Error(loop.error);
    const result = await withAdapter((adapter) =>
      adapter.sketchPlanarOperation({
        kind: 'offset',
        loop: loop.loop.points,
        distance: 2,
        join: 'arc'
      })
    );
    if (result.kind !== 'offset') throw new Error('Expected an offset result.');
    const curves: SketchOffsetCurve[] = result.curves;
    expect(curves.filter((curve) => curve.kind === 'arc')).toHaveLength(4);

    const manager = new CommandManager(document);
    manager.runTransaction('Offset', sketchOffsetCommands(sketchId, curves));
    const next = findSketch(manager.document, sketchId)!;
    expect(next.objectIds).toHaveLength(sketch.objectIds.length + 8);
    // Eight curves chained end to end is eight coincidences, including the
    // one that closes the loop.
    expect(next.constraints ?? []).toHaveLength(8);
    expect(manager.undoLabel).toBe('Offset');
    manager.undo();
    expect(findSketch(manager.document, sketchId)!.objectIds).toEqual(
      sketch.objectIds
    );
    expect(manager.canUndo).toBe(false);
  });

  it('offsets inward without the corner arcs that would cross the result', async () => {
    const { document, sketch, loopSeed } = fixture();
    const loop = resolveSketchLoop(document, sketch, loopSeed, resolve);
    if ('error' in loop) throw new Error(loop.error);
    const result = await withAdapter((adapter) =>
      adapter.sketchPlanarOperation({
        kind: 'offset',
        loop: loop.loop.points,
        distance: -2,
        join: 'arc'
      })
    );
    if (result.kind !== 'offset') throw new Error('Expected an offset result.');
    expect(result.curves).toHaveLength(4);
    expect(result.curves.every((curve) => curve.kind === 'line')).toBe(true);
  });
});

describe('the arc form of the tangent constraint the fillet records', () => {
  function addTangent(
    document: ProjectDocument,
    sketchId: SketchId,
    constraint: Parameters<
      typeof commandFactories.addSketchConstraint
    >[0]['constraint']
  ) {
    const command = commandFactories.addSketchConstraint({
      sketchId,
      constraint
    });
    command.validate(document);
    return command.apply(document);
  }

  it('requires the contact point, and requires it to be on the arc', async () => {
    const { document, sketch, sketchId, legA, legB } = fixture();
    const fillet = await filletGeometry(document, sketch, legA, legB, 2);
    const resolved = resolveSketchCorner(document, sketch, legA, legB, resolve);
    if ('error' in resolved) throw new Error(resolved.error);
    const next = apply(
      document,
      sketchFilletCommands(
        document,
        sketch,
        sketchId,
        { a: legA, b: legB },
        resolved.corner,
        fillet,
        2
      )
    );
    const arcId = findSketch(next, sketchId)!.objectIds.find(
      (id) => !sketch.objectIds.includes(id)
    )!;

    expect(() =>
      addTangent(next, sketchId, {
        constraintKind: 'tangent',
        a: legA as EntityId,
        b: arcId
      })
    ).toThrow(/must name the arc point it touches/);
    expect(() =>
      addTangent(next, sketchId, {
        constraintKind: 'tangent',
        a: legA as EntityId,
        b: arcId,
        at: { objectId: legA as EntityId, point: 'start' }
      })
    ).toThrow(/must belong to the arc/);
    expect(() =>
      addTangent(next, sketchId, {
        constraintKind: 'tangent',
        a: legA as EntityId,
        b: arcId,
        at: { objectId: arcId, point: 'center' }
      })
    ).toThrow(/arc start or end/);
  });

  it('leaves the point-free line-to-circle form exactly as it was', () => {
    const { document, sketchId, legA, circle } = fixture();
    expect(() =>
      addTangent(document, sketchId, {
        constraintKind: 'tangent',
        a: legA as EntityId,
        b: circle as EntityId
      })
    ).not.toThrow();
    expect(() =>
      addTangent(document, sketchId, {
        constraintKind: 'tangent',
        a: legA as EntityId,
        b: circle as EntityId,
        at: { objectId: circle as EntityId, point: 'center' }
      })
    ).toThrow(/no contact point/);
  });
});

describe('the pick sequence and plan the rail drives', () => {
  it('walks a corner tool from first pick to a prefilled value', () => {
    const { document, sketch, legA, legB } = fixture();
    expect(
      advanceSketchEditPick(document, sketch, 'fillet', [], null, resolve)
    ).toEqual({
      status: 'hint',
      message: 'Click two lines that meet, then enter the radius.'
    });
    expect(
      advanceSketchEditPick(document, sketch, 'fillet', [], legA, resolve)
    ).toEqual({ status: 'pick', message: 'Fillet: pick 2 of 2.' });
    // A quarter of the shorter 10-long leg, so the prefill always fits.
    expect(
      advanceSketchEditPick(document, sketch, 'fillet', [legA], legB, resolve)
    ).toEqual({
      status: 'value',
      label: 'Fillet radius',
      initial: 2.5,
      message: 'Fillet: enter the value.'
    });
  });

  it('refuses at the pick, before the value is asked for', () => {
    const { document, sketch, legA, loopSeed, rectangle } = fixture();
    expect(
      advanceSketchEditPick(
        document,
        sketch,
        'chamfer',
        [legA],
        loopSeed,
        resolve
      )
    ).toEqual({
      status: 'refuse',
      reason:
        'Those two lines do not meet at an endpoint. Join them first — this tool does not extend geometry.'
    });
    expect(
      advanceSketchEditPick(document, sketch, 'offset', [], legA, resolve)
    ).toEqual({
      status: 'refuse',
      reason:
        'That run of lines is not closed. Offset needs a closed loop; close the profile first.'
    });
    expect(
      advanceSketchEditPick(document, sketch, 'offset', [], rectangle, resolve)
        .status
    ).toBe('refuse');
    expect(
      advanceSketchEditPick(document, sketch, 'offset', [], loopSeed, resolve)
    ).toEqual({
      status: 'value',
      label: 'Offset distance',
      initial: 1,
      message: 'Offset: enter the distance. Positive is outward.'
    });
  });

  it('plans each tool as one kernel request and the commands its answer becomes', async () => {
    const { document, sketch, sketchId, legA, legB, loopSeed } = fixture();
    const fillet = planSketchEdit(
      document,
      sketch,
      sketchId,
      'fillet',
      [legA, legB],
      2,
      '2',
      resolve
    );
    if (fillet.status !== 'operation') throw new Error(fillet.reason);
    expect(fillet.operation).toEqual({
      kind: 'fillet',
      corner: {
        corner: { x: 0, y: 0 },
        farA: { x: 0, y: 10 },
        farB: { x: 10, y: 0 },
        aPoint: 'end',
        bPoint: 'start'
      },
      radius: 2
    });

    const chamfer = planSketchEdit(
      document,
      sketch,
      sketchId,
      'chamfer',
      [legA, legB],
      3,
      '3',
      resolve
    );
    if (chamfer.status !== 'operation') throw new Error(chamfer.reason);
    expect(chamfer.operation.kind).toBe('chamfer');

    const offset = planSketchEdit(
      document,
      sketch,
      sketchId,
      'offset',
      [loopSeed],
      2,
      '2',
      resolve
    );
    if (offset.status !== 'operation') throw new Error(offset.reason);
    expect(offset.operation).toMatchObject({
      kind: 'offset',
      distance: 2,
      join: 'arc'
    });

    // The plan refuses to build a fillet out of a chamfer answer rather than
    // reading whatever fields happen to line up.
    const result = await withAdapter((adapter) =>
      adapter.sketchPlanarOperation(chamfer.operation)
    );
    expect(() => fillet.commit(result)).toThrow(/different operation/);
    // Two trims, the bevel, and the two coincidences that hold it on.
    expect(chamfer.commit(result)).toHaveLength(5);
  });

  it('refuses a plan whose picks no longer make a corner', () => {
    const { document, sketch, sketchId, legA } = fixture();
    expect(
      planSketchEdit(
        document,
        sketch,
        sketchId,
        'fillet',
        [legA],
        2,
        '2',
        resolve
      )
    ).toEqual({ status: 'refuse', reason: 'Fillet needs 2 pick(s).' });
  });
});
