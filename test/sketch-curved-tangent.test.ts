import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type EntityId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * S05 curve-to-curve tangency (schema v141): what a fillet against an arc or
 * a circle records. Two arcs touch where they are joined, in line with both
 * centres; an arc touches a circle at its end, on the circle and in line
 * with both centres. Checked on the pinned kernel against closed form.
 */

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

function sketchWith(objects: SketchObjectData[]) {
  const manager = new CommandManager(
    createProjectDocument('Tangent', toUserId('user_tangent'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Tangent',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds;
  const constrain = (
    constraint: Parameters<
      typeof commandFactories.addSketchConstraint
    >[0]['constraint']
  ) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  return { manager, sketchId, ids, constrain };
}

const lock = (
  objectId: EntityId,
  point: 'start' | 'end' | 'center',
  x: number,
  y: number
) => ({ constraintKind: 'lock', point: { objectId, point }, x, y }) as const;

describe('S05 curve-to-curve tangency', () => {
  it('turns a joined arc to touch the other, inside or outside', async () => {
    for (const inside of [false, true]) {
      // A locked radius-5 arc about the origin ending at (0, 5); a radius-1
      // arc starting there, centred off the common normal.
      const fixture = sketchWith([
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
          centerX: 0.4,
          centerY: inside ? 4 : 6,
          radius: 1,
          startAngleDeg: inside ? 110 : 250,
          endAngleDeg: inside ? 200 : 340
        }
      ]);
      const [big, small] = fixture.ids as [EntityId, EntityId];
      fixture.constrain(lock(big, 'center', 0, 0));
      fixture.constrain(lock(big, 'start', 5, 0));
      fixture.constrain(lock(big, 'end', 0, 5));
      fixture.constrain({
        constraintKind: 'coincident',
        a: { objectId: big, point: 'end' },
        b: { objectId: small, point: 'start' }
      });
      fixture.constrain({
        constraintKind: 'tangent',
        a: big,
        b: small,
        at: { objectId: small, point: 'start' }
      });
      fixture.constrain({
        constraintKind: 'radius',
        objectId: small,
        value: 1
      });
      const outcome = await adapter.solveSketch(
        fixture.manager.document,
        fixture.sketchId
      );
      expect(outcome.converged).toBe(true);
      const solved = outcome.objects[1]!;
      if (solved.kind !== 'arc') throw new Error('expected an arc');
      // Tangent at (0, 5): its centre on the y axis, 1 inside or outside.
      expect(solved.centerX).toBeCloseTo(0, 8);
      expect(solved.centerY).toBeCloseTo(inside ? 4 : 6, 8);
    }
  });

  it('needs the two arcs joined at the contact point', () => {
    const fixture = sketchWith([
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
        centerX: 0,
        centerY: 6,
        radius: 1,
        startAngleDeg: 250,
        endAngleDeg: 340
      }
    ]);
    const [big, small] = fixture.ids as [EntityId, EntityId];
    expect(() =>
      fixture.constrain({
        constraintKind: 'tangent',
        a: big,
        b: small,
        at: { objectId: small, point: 'start' }
      })
    ).toThrow(/join the contact point to an end of the other arc first/);
  });

  it('holds an arc end on a circle, touching it', async () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      {
        objectKind: 'arc',
        centerX: 0.5,
        centerY: 6.2,
        radius: 1,
        startAngleDeg: 240,
        endAngleDeg: 330
      }
    ]);
    const [circle, arc] = fixture.ids as [EntityId, EntityId];
    fixture.constrain(lock(circle, 'center', 0, 0));
    fixture.constrain({ constraintKind: 'radius', objectId: circle, value: 5 });
    fixture.constrain({ constraintKind: 'radius', objectId: arc, value: 1 });
    fixture.constrain({
      constraintKind: 'tangent',
      a: circle,
      b: arc,
      at: { objectId: arc, point: 'start' }
    });
    const outcome = await adapter.solveSketch(
      fixture.manager.document,
      fixture.sketchId
    );
    expect(outcome.converged).toBe(true);
    expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
    const solved = outcome.objects[1]!;
    if (solved.kind !== 'arc') throw new Error('expected an arc');
    const start = (solved.startAngleDeg * Math.PI) / 180;
    const sx = solved.centerX + Math.cos(start);
    const sy = solved.centerY + Math.sin(start);
    // On the circle, and the two centres in line with it: tangent.
    expect(Math.hypot(sx, sy)).toBeCloseTo(5, 8);
    expect(Math.hypot(solved.centerX, solved.centerY)).toBeCloseTo(6, 8);
  });

  it('needs schema v141: an older stamp refuses a document that holds one', () => {
    const fixture = sketchWith([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 6,
        radius: 1,
        startAngleDeg: 250,
        endAngleDeg: 340
      }
    ]);
    const [circle, arc] = fixture.ids as [EntityId, EntityId];
    fixture.constrain({
      constraintKind: 'tangent',
      a: circle,
      b: arc,
      at: { objectId: arc, point: 'start' }
    });
    const saved = JSON.parse(
      JSON.stringify(fixture.manager.document)
    ) as ProjectDocument;
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(141);
    expect(normalizeDocument(saved)).toEqual(fixture.manager.document);
    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: 140 as typeof saved.schemaVersion
      })
    ).toThrow(/Curve-to-curve tangency/);
  });
});
