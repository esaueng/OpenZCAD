import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  getNode
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import { settleOptionalRelations } from '../apps/web/src/lib/sketch/modify';
import {
  addedConstraintIds,
  drawnEntityCommands
} from '../apps/web/src/lib/sketch/inferenceCommit';
import type { SketchSnapHint } from '../apps/web/src/lib/sketch/inference';
import { cornerRectangleShape } from '../apps/web/src/lib/sketch/composites';

/**
 * S08 inference while drawing on the pinned kernel's solver: what a drawing
 * commit infers is satisfied by the drawn geometry (a solve moves nothing),
 * never redundant (rank equals equations after every commit), and is an
 * ordinary relation that undo removes with the entity.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const resolve = (value: unknown) => Number(value);

function drawing() {
  const manager = new CommandManager(
    createProjectDocument('S08', toUserId('user_s08'))
  );
  let sketchId: SketchId | null = null;
  const objects = () => {
    if (!sketchId) return [];
    return findSketch(manager.document, sketchId)!.objectIds.map((id) => {
      const node = getNode(manager.document, id);
      if (node?.kind !== 'sketch-object') throw new Error('not an object');
      return { id: String(id), data: node.data };
    });
  };
  const constraints = () =>
    sketchId ? (findSketch(manager.document, sketchId)!.constraints ?? []) : [];
  /** One drawing commit, the way the app runs it. */
  const draw = async (
    drawn:
      | SketchObjectData
      | {
          kind: 'composite';
          shape: NonNullable<ReturnType<typeof cornerRectangleShape>>;
        },
    options: { autoConstrain?: boolean; hints?: SketchSnapHint[] } = {}
  ) => {
    const plan = drawnEntityCommands(
      'kind' in drawn && drawn.kind === 'composite'
        ? drawn
        : { kind: 'object', data: drawn as SketchObjectData },
      sketchId
        ? { kind: 'sketch', sketchId }
        : {
            kind: 'new-sketch',
            name: 'Inference',
            planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
          },
      objects(),
      {
        autoConstrain: options.autoConstrain ?? true,
        hints: options.hints,
        resolve
      }
    );
    const commands = plan.optional.length
      ? await settleOptionalRelations(
          manager.document,
          plan.sketchId,
          plan.commands,
          plan.optional,
          (document, id) => adapter.solveSketch(document, id)
        )
      : plan.commands;
    manager.execute(composeCommands(plan.label, commands));
    sketchId = plan.sketchId;
    return {
      ids: plan.objectIds.map(String),
      kinds: commands.flatMap((command) => {
        const kind = plan.kinds.get(command);
        return kind ? [kind] : [];
      }),
      constraintIds: addedConstraintIds(commands)
    };
  };
  const solve = () => adapter.solveSketch(manager.document, sketchId!);
  return { manager, draw, solve, objects, constraints };
}

function expectStill(
  outcome: SketchSolveOutcome,
  objects: { id: string; data: SketchObjectData }[]
) {
  expect(outcome.converged).toBe(true);
  expect(outcome.rolledBack).toBe(false);
  expect(['solved', 'underConstrained']).toContain(outcome.classification);
  expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
  expect(outcome.maxResidual).toBeLessThan(1e-9);
  for (const object of objects) {
    const solvedObject = outcome.objects.find(
      (entry) => entry.objectId === object.id
    ) as unknown as Record<string, number> | undefined;
    if (!solvedObject || object.data.objectKind !== 'line') continue;
    for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
      expect(solvedObject[key]).toBeCloseTo(Number(object.data[key]), 9);
    }
  }
}

const segment = (x1: number, y1: number, x2: number, y2: number) =>
  ({ objectKind: 'line', x1, y1, x2, y2 }) as const;

describe('S08 inference on the pinned kernel', () => {
  it('a hand-drawn rectangle is joined and squared without redundancy', async () => {
    const sketch = drawing();
    const first = await sketch.draw(segment(0, 0, 20, 0), {
      hints: [{ x: 0, y: 0, kind: 'origin' }]
    });
    expect(first.kinds).toEqual(['origin', 'horizontal']);
    expect((await sketch.draw(segment(20, 0, 20, 12))).kinds).toEqual([
      'coincident',
      'vertical'
    ]);
    expect((await sketch.draw(segment(20, 12, 0, 12))).kinds).toEqual([
      'coincident',
      'horizontal'
    ]);
    expect((await sketch.draw(segment(0, 12, 0, 0))).kinds).toEqual([
      'coincident',
      'coincident',
      'vertical'
    ]);
    // Corner locked, four sides joined and squared: width and height remain.
    const outcome = await sketch.solve();
    expectStill(outcome, sketch.objects());
    expect(outcome.dof.dof).toBe(2);
  });

  it('a rotated rectangle drawn by perpendicular locks keeps one closing perpendicular', async () => {
    const sketch = drawing();
    await sketch.draw(segment(0, 0, 8, 6));
    expect((await sketch.draw(segment(8, 6, 5, 10))).kinds).toEqual([
      'coincident',
      'perpendicular'
    ]);
    expect((await sketch.draw(segment(5, 10, -3, 4))).kinds).toEqual([
      'coincident',
      'perpendicular'
    ]);
    expect((await sketch.draw(segment(-3, 4, 0, 0))).kinds).toEqual([
      'coincident',
      'coincident',
      'perpendicular'
    ]);
    const outcome = await sketch.solve();
    expectStill(outcome, sketch.objects());
    // Position (2), rotation, width and height.
    expect(outcome.dof.dof).toBe(5);
  });

  it('drops an inferred relation the sketch already implies', async () => {
    const sketch = drawing();
    await sketch.draw(segment(0, 0, 10, 0));
    // A second line over the first: both ends join it, so its horizontal
    // would restate the first line's and is left out.
    const over = await sketch.draw(segment(0, 0, 10, 0));
    expect(over.kinds).toEqual(['coincident', 'coincident']);
    expectStill(await sketch.solve(), sketch.objects());
  });

  it('a line leaving an arc end along its tangent stays tangent', async () => {
    const sketch = drawing();
    await sketch.draw({
      objectKind: 'arc',
      centerX: 0,
      centerY: 0,
      radius: 10,
      startAngleDeg: 0,
      endAngleDeg: 90
    });
    const end = (await sketch.draw(segment(0, 10, -15, 10))).kinds;
    expect(end).toEqual(['coincident', 'horizontal', 'tangent']);
    expectStill(await sketch.solve(), sketch.objects());
  });

  it('with auto-constrain off only joined ends and midpoints are kept', async () => {
    const sketch = drawing();
    await sketch.draw(segment(0, 0, 10, 0), { autoConstrain: false });
    expect(
      (await sketch.draw(segment(10, 0, 10, 5), { autoConstrain: false })).kinds
    ).toEqual(['coincident']);
    expect(
      (await sketch.draw(segment(5, 0, 5, -7), { autoConstrain: false })).kinds
    ).toEqual(['midpoint']);
    expectStill(await sketch.solve(), sketch.objects());
  });

  it('a rectangle composite drawn on an end is joined to it', async () => {
    const sketch = drawing();
    await sketch.draw(segment(-10, 0, 0, 0));
    const shape = cornerRectangleShape({ x: 0, y: 0 }, { x: 6, y: 4 })!;
    const result = await sketch.draw({ kind: 'composite', shape });
    expect(result.kinds).toEqual(['coincident']);
    expectStill(await sketch.solve(), sketch.objects());
  });

  it('undo removes the entity and every relation inferred with it', async () => {
    const sketch = drawing();
    await sketch.draw(segment(0, 0, 10, 0));
    const before = sketch.constraints().length;
    const second = await sketch.draw(segment(10, 0, 10, 5));
    expect(second.constraintIds).toHaveLength(2);
    expect(sketch.constraints().map((c) => String(c.constraintId))).toEqual(
      expect.arrayContaining(second.constraintIds)
    );
    sketch.manager.undo();
    expect(sketch.constraints()).toHaveLength(before);
    expect(sketch.objects()).toHaveLength(1);
  });

  it('an inferred relation deletes like any other, leaving the entity', async () => {
    const sketch = drawing();
    await sketch.draw(segment(0, 0, 10, 0));
    const second = await sketch.draw(segment(10, 0, 10, 5));
    const sketchId = findSketch(
      sketch.manager.document,
      sketch.manager.document.sketchOrder[0]!
    )!.sketchId;
    sketch.manager.execute(
      commandFactories.deleteSketchConstraint({
        sketchId,
        constraintId: sketch
          .constraints()
          .find((c) => c.data.constraintKind === 'vertical')!.constraintId
      })
    );
    expect(sketch.objects()).toHaveLength(2);
    expect(sketch.constraints().map((c) => c.data.constraintKind)).toEqual([
      'horizontal',
      'coincident'
    ]);
    expect(second.ids).toHaveLength(1);
  });
});
