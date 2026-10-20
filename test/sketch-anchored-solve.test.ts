import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * S03 anchored solve (ZC-041), on the pinned kernel and against closed-form
 * geometry: a relation applied as it is added holds its first pick, so
 * reversing the pick order of Equal reverses which side keeps its size.
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
    createProjectDocument('Anchor', toUserId('user_anchor'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Anchored',
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

function geometry(outcome: SketchSolveOutcome, index: number) {
  return outcome.objects[index]!;
}

function length(outcome: SketchSolveOutcome, index: number) {
  const object = geometry(outcome, index);
  if (object.kind !== 'line') throw new Error('expected a line');
  return Math.hypot(object.x2 - object.x1, object.y2 - object.y1);
}

const TOL = 1e-9;

describe('anchored sketch solve on the pinned kernel', () => {
  it('Equal keeps the first pick and resizes the second, in either order', async () => {
    const lines: SketchObjectData[] = [
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 0, y1: 5, x2: 4, y2: 5 }
    ];
    for (const [first, second, kept] of [
      [0, 1, 10],
      [1, 0, 4]
    ] as const) {
      const { manager, sketchId, ids, constrain } = sketchWith(lines);
      constrain({ constraintKind: 'equal', a: ids[first]!, b: ids[second]! });
      const outcome = await adapter.solveSketch(manager.document, sketchId, {
        anchor: { objectIds: [ids[first]!] }
      });
      expect(outcome.converged).toBe(true);
      expect(outcome.rolledBack).toBe(false);
      // The anchor is exactly where it was; the other line took its length.
      const held = geometry(outcome, first);
      const source = lines[first]!;
      if (held.kind !== 'line' || source.objectKind !== 'line') {
        throw new Error('expected lines');
      }
      expect([held.x1, held.y1, held.x2, held.y2]).toEqual([
        source.x1,
        source.y1,
        source.x2,
        source.y2
      ]);
      expect(Math.abs(length(outcome, first) - kept)).toBeLessThan(TOL);
      expect(Math.abs(length(outcome, second) - kept)).toBeLessThan(TOL);
    }
  });

  it('a held point stays put and the other point comes to it', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 12, y1: 3, x2: 20, y2: 9 }
    ]);
    constrain({
      constraintKind: 'coincident',
      a: { objectId: ids[0]!, point: 'end' },
      b: { objectId: ids[1]!, point: 'start' }
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId, {
      anchor: { points: [{ objectId: ids[0]!, point: 'end' }] }
    });
    expect(outcome.converged).toBe(true);
    const held = geometry(outcome, 0);
    const moved = geometry(outcome, 1);
    if (held.kind !== 'line' || moved.kind !== 'line') throw new Error();
    expect(held.x2).toBe(10);
    expect(held.y2).toBe(0);
    expect(Math.abs(moved.x1 - 10)).toBeLessThan(TOL);
    expect(Math.abs(moved.y1)).toBeLessThan(TOL);
  });

  it('a held circle keeps its radius, and the hold is not a document residual', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 7 },
      { objectKind: 'circle', centerX: 20, centerY: 0, radius: 2 }
    ]);
    constrain({ constraintKind: 'equal', a: ids[0]!, b: ids[1]! });
    const outcome = await adapter.solveSketch(manager.document, sketchId, {
      anchor: { objectIds: [ids[0]!] }
    });
    expect(outcome.converged).toBe(true);
    const held = geometry(outcome, 0);
    const resized = geometry(outcome, 1);
    if (held.kind !== 'circle' || resized.kind !== 'circle') throw new Error();
    expect(Math.abs(held.radius - 7)).toBeLessThan(TOL);
    expect(held.centerX).toBe(0);
    expect(Math.abs(resized.radius - 7)).toBeLessThan(TOL);
    const constraintIds = findSketch(
      manager.document,
      sketchId
    )!.constraints!.map((constraint) => String(constraint.constraintId));
    expect(
      outcome.constraintResiduals.map((entry) => entry.constraintId).sort()
    ).toEqual([...constraintIds].sort());
  });

  it('does not converge when only the held pick could satisfy the relation', async () => {
    // The second line is locked at both ends, so Equal can only be met by
    // resizing the first, which the anchor forbids: the caller falls back.
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 0, y1: 5, x2: 4, y2: 5 }
    ]);
    constrain({
      constraintKind: 'lock',
      point: { objectId: ids[1]!, point: 'start' },
      x: 0,
      y: 5
    });
    constrain({
      constraintKind: 'lock',
      point: { objectId: ids[1]!, point: 'end' },
      x: 4,
      y: 5
    });
    constrain({ constraintKind: 'equal', a: ids[0]!, b: ids[1]! });
    const held = await adapter.solveSketch(manager.document, sketchId, {
      anchor: { objectIds: [ids[0]!] }
    });
    expect(held.converged && !held.rolledBack).toBe(false);
    const free = await adapter.solveSketch(manager.document, sketchId);
    expect(free.converged).toBe(true);
    expect(Math.abs(length(free, 0) - 4)).toBeLessThan(TOL);
  });
});
