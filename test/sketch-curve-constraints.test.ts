import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  translateSketch,
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
import { solvedSketchCommands } from '../apps/web/src/lib/sketch/applySolve';

/**
 * I01 (schema v27) curve entities in the sketch solver. On the pinned
 * kernel an ellipse is a GCS ellipse held by its centre (coincident, lock,
 * point-on-ellipse, concentric, equal radii) and a spline is its points, an
 * open spline's ends being its constrainable `start` and `end`. Results are
 * checked against closed-form geometry, not the solver's own report.
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
    createProjectDocument('I01', toUserId('user_i01_constraints'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Curves',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds as string[];
  const constrain = (constraint: SketchConstraintData) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  return { manager, sketchId, ids, constrain };
}

const lock = (
  objectId: string,
  point: 'start' | 'end' | 'center',
  x: number,
  y: number
) =>
  ({
    constraintKind: 'lock',
    point: { objectId: objectId as never, point },
    x,
    y
  }) as const;

function solvedOf<K extends SketchSolveOutcome['objects'][number]['kind']>(
  outcome: SketchSolveOutcome,
  index: number,
  kind: K
): Extract<SketchSolveOutcome['objects'][number], { kind: K }> {
  const object = outcome.objects[index]!;
  if (object.kind !== kind) throw new Error(`expected a ${kind}`);
  return object as Extract<SketchSolveOutcome['objects'][number], { kind: K }>;
}

const ELLIPSE: SketchObjectData = {
  objectKind: 'ellipse',
  centerX: 3,
  centerY: -2,
  radiusX: 20,
  radiusY: 8,
  rotationDeg: 30
};

describe('I01 curves on the pinned GCS', () => {
  it('moves an ellipse by its centre onto a locked line end', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 10, y1: 10, x2: 40, y2: 10 },
      ELLIPSE
    ]);
    const [edge, ellipse] = ids as [string, string];
    constrain(lock(edge, 'start', 10, 10));
    constrain(lock(edge, 'end', 40, 10));
    constrain({
      constraintKind: 'coincident',
      a: { objectId: ellipse as never, point: 'center' },
      b: { objectId: edge as never, point: 'start' }
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    const solved = solvedOf(outcome, 1, 'ellipse');
    expect(solved.centerX).toBeCloseTo(10, 9);
    expect(solved.centerY).toBeCloseTo(10, 9);
    // Nothing held the shape, so the solve left it exactly as drawn.
    expect(solved.radiusX).toBeCloseTo(20, 9);
    expect(solved.radiusY).toBeCloseTo(8, 9);
    expect(solved.rotationDeg).toBeCloseTo(30, 9);

    // Writing back keeps the shape fields and moves only the centre.
    const commands = solvedSketchCommands(manager.document, sketchId, outcome);
    expect(commands).toHaveLength(1);
    manager.runTransaction('Solve sketch', commands);
    const node = manager.document.nodes[ellipse as never];
    expect(node?.kind === 'sketch-object' && node.data).toMatchObject({
      objectKind: 'ellipse',
      radiusX: 20,
      radiusY: 8
    });
  });

  it('holds a point on an ellipse', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      ELLIPSE,
      { objectKind: 'line', x1: 6, y1: 12, x2: 50, y2: 50 }
    ]);
    const [ellipse, mover] = ids as [string, string];
    constrain(lock(ellipse, 'center', 3, -2));
    constrain({
      constraintKind: 'point-on-object',
      point: { objectId: mover as never, point: 'start' },
      objectId: ellipse as never
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    const shape = solvedOf(outcome, 0, 'ellipse');
    const point = solvedOf(outcome, 1, 'line');
    // On the ellipse: (x'/a)² + (y'/b)² = 1 in its own frame.
    const angle = (shape.rotationDeg * Math.PI) / 180;
    const dx = point.x1 - shape.centerX;
    const dy = point.y1 - shape.centerY;
    const lx = dx * Math.cos(angle) + dy * Math.sin(angle);
    const ly = -dx * Math.sin(angle) + dy * Math.cos(angle);
    expect((lx / shape.radiusX) ** 2 + (ly / shape.radiusY) ** 2).toBeCloseTo(
      1,
      8
    );
  });

  it('makes two ellipses concentric and equal', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      ELLIPSE,
      {
        objectKind: 'ellipse',
        centerX: 5,
        centerY: 0,
        radiusX: 18,
        radiusY: 7,
        rotationDeg: 30
      }
    ]);
    const [ellipse, other] = ids as [string, string];
    constrain(lock(ellipse, 'center', 3, -2));
    constrain({
      constraintKind: 'concentric',
      a: ellipse as never,
      b: other as never
    });
    constrain({
      constraintKind: 'equal',
      a: ellipse as never,
      b: other as never
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    const shape = solvedOf(outcome, 0, 'ellipse');
    const twin = solvedOf(outcome, 1, 'ellipse');
    expect(twin.centerX).toBeCloseTo(3, 8);
    expect(twin.centerY).toBeCloseTo(-2, 8);
    expect(twin.radiusX).toBeCloseTo(shape.radiusX, 8);
    expect(twin.radiusY).toBeCloseTo(shape.radiusY, 8);
  });

  it('joins a line to an open spline end and keeps the untouched points', async () => {
    const { manager, sketchId, ids, constrain } = sketchWith([
      { objectKind: 'line', x1: 40, y1: -6, x2: 0, y2: -6 },
      {
        objectKind: 'spline',
        method: 'fit',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 12 },
          { x: 25, y: 4 },
          { x: 32, y: 0 }
        ]
      }
    ]);
    const [edge, spline] = ids as [string, string];
    constrain(lock(edge, 'start', 40, -6));
    constrain(lock(edge, 'end', 0, -6));
    constrain({
      constraintKind: 'coincident',
      a: { objectId: spline as never, point: 'end' },
      b: { objectId: edge as never, point: 'start' }
    });
    constrain({
      constraintKind: 'coincident',
      a: { objectId: spline as never, point: 'start' },
      b: { objectId: edge as never, point: 'end' }
    });
    const outcome = await adapter.solveSketch(manager.document, sketchId);
    expect(outcome.converged).toBe(true);
    const solved = solvedOf(outcome, 1, 'spline');
    expect(solved.points[0]!.x).toBeCloseTo(0, 9);
    expect(solved.points[0]!.y).toBeCloseTo(-6, 9);
    expect(solved.points[3]!.x).toBeCloseTo(40, 9);
    expect(solved.points[3]!.y).toBeCloseTo(-6, 9);
    // Interior points carry no relation, so the solver never moved them.
    expect(solved.points[1]).toEqual({ x: 10, y: 12 });
    expect(solved.points[2]).toEqual({ x: 25, y: 4 });

    const commands = solvedSketchCommands(manager.document, sketchId, outcome);
    manager.runTransaction('Solve sketch', commands);
    const node = manager.document.nodes[spline as never];
    if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'spline') {
      throw new Error('expected the spline');
    }
    expect(node.data.points[1]).toEqual({ x: 10, y: 12 });
    expect(node.data.points[0]!.y).toBeCloseTo(-6, 9);
  });
});

describe('I01 constraint validation', () => {
  it('refuses points a curve does not expose', () => {
    const { constrain, ids } = sketchWith([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      ELLIPSE,
      {
        objectKind: 'spline',
        method: 'fit',
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 5, y: 8 }
        ]
      }
    ]);
    const [edge, ellipse, loop] = ids as [string, string, string];
    expect(() =>
      constrain({
        constraintKind: 'coincident',
        a: { objectId: ellipse as never, point: 'start' },
        b: { objectId: edge as never, point: 'start' }
      })
    ).toThrow(/no 'start' point/);
    expect(() =>
      constrain({
        constraintKind: 'coincident',
        a: { objectId: loop as never, point: 'start' },
        b: { objectId: edge as never, point: 'start' }
      })
    ).toThrow(/no 'start' point/);
    expect(() =>
      constrain({
        constraintKind: 'equal',
        a: ellipse as never,
        b: edge as never
      })
    ).toThrow(/ellipse with an ellipse/);
    expect(() =>
      constrain({
        constraintKind: 'radius',
        objectId: ellipse as never,
        value: 4
      })
    ).toThrow(/cannot carry this constraint/);
  });
});

describe('I01 document model', () => {
  it('stamps schema v27, round-trips curves unchanged and refuses a newer schema', () => {
    const { manager } = sketchWith([
      { ...ELLIPSE, startParamDeg: 10, endParamDeg: '100 + 10' },
      {
        objectKind: 'spline',
        method: 'control',
        degree: 2,
        points: [
          { x: 0, y: 0 },
          { x: '20 / 2', y: 9 },
          { x: 20, y: 0 }
        ]
      }
    ]);
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(manager.document.schemaVersion).toBe(
      PROJECT_DOCUMENT_SCHEMA_VERSION
    );
    expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(normalizeDocument(saved)).toEqual(manager.document);
    // One past the current version, whatever later slices have taken.
    const newer = PROJECT_DOCUMENT_SCHEMA_VERSION + 1;
    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: newer as typeof saved.schemaVersion
      })
    ).toThrow(`Unsupported project schema (v${newer})`);
  });

  it('moves every spline point and the ellipse centre with the sketch', () => {
    const { manager, sketchId, ids } = sketchWith([
      ELLIPSE,
      {
        objectKind: 'spline',
        method: 'fit',
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
          { x: 10, y: 0 }
        ]
      }
    ]);
    const moved = translateSketch(manager.document, {
      sketchId,
      du: 2,
      dv: -3
    });
    const [ellipse, spline] = ids.map((id) => {
      const node = moved.nodes[id as never];
      if (node?.kind !== 'sketch-object') throw new Error('missing');
      return node.data;
    });
    expect(ellipse).toMatchObject({ centerX: 5, centerY: -5, radiusX: 20 });
    expect(spline).toMatchObject({
      points: [
        { x: 2, y: -3 },
        { x: 7, y: 2 },
        { x: 12, y: -3 }
      ]
    });
  });
});
