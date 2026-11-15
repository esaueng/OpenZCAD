import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  addSketchObjects,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getNode
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  resolveSketchComposite,
  toUserId,
  type EntityId,
  type SketchObjectData
} from '@openzcad/shared';
import {
  compositeCommands,
  slotShape
} from '../apps/web/src/lib/sketch/composites';

/**
 * I01 (schema v59): the point and slot sketch entities. A slot is two lines
 * and two half-circle arcs held tangent and named as one composite; on the
 * pinned kernel its relations leave exactly position, rotation, centre
 * distance and radius free, with none redundant, its region is the exact
 * stadium area and it extrudes to that area times the height. A point is
 * one solver point every point relation holds, bounding no profile.
 */

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
}, 60_000);

afterAll(() => kernel.dispose());

const resolve = (value: unknown) => Number(value);

function sketchFixture(objects: SketchObjectData[] = []) {
  const manager = new CommandManager(
    createProjectDocument('I01', toUserId('user_i01'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Entities',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects:
        objects.length > 0
          ? objects
          : [{ objectKind: 'line', x1: -50, y1: -50, x2: -40, y2: -50 }]
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const sketch = () => findSketch(manager.document, sketchId)!;
  const objectsOf = () =>
    sketch().objectIds.map((id) => {
      const node = getNode(manager.document, id);
      if (node?.kind !== 'sketch-object') throw new Error('not an object');
      return { id: String(id), data: node.data };
    });
  const solve = () => kernel.solveSketch(manager.document, sketchId);
  return { manager, sketchId, sketch, objectsOf, solve };
}

function addSlot(
  fixture: ReturnType<typeof sketchFixture>,
  first = { x: 0, y: 0 },
  second = { x: 30, y: 10 },
  radius = 6
) {
  const shape = slotShape(first, second, radius)!;
  const commit = compositeCommands(shape, {
    kind: 'sketch',
    sketchId: fixture.sketchId
  });
  fixture.manager.execute(composeCommands(commit.label, commit.commands));
  return commit;
}

describe('I01 slot', () => {
  it('is two lines and two half circles, resolved as one slot', () => {
    const fixture = sketchFixture();
    const commit = addSlot(fixture);
    const objects = new Map(
      fixture.objectsOf().map((object) => [object.id, object.data])
    );
    expect(commit.edgeIds.map((id) => objects.get(id)!.objectKind)).toEqual([
      'line',
      'arc',
      'line',
      'arc'
    ]);
    expect(objects.get(commit.helperIds[0]!)).toMatchObject({
      objectKind: 'line',
      construction: true,
      x1: 0,
      y1: 0,
      x2: 30,
      y2: 10
    });
    const composite = fixture.sketch().composites![0]!;
    expect(composite).toMatchObject({
      compositeKind: 'slot',
      method: 'center-to-center'
    });
    const resolved = resolveSketchComposite(composite, objects, (value) =>
      typeof value === 'number' ? value : Number(value)
    );
    expect(resolved.status).toBe('resolved');
  });

  it('leaves position, rotation, length and radius free with nothing redundant', async () => {
    const fixture = sketchFixture();
    addSlot(fixture);
    const outcome = await fixture.solve();
    expect(outcome.converged).toBe(true);
    expect(outcome.classification).toBe('underConstrained');
    expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
    // The seed line is free (4) and the slot keeps 5.
    expect(outcome.dof.dof).toBe(4 + 5);
    expect(outcome.maxResidual).toBeLessThan(1e-9);
  });

  it('a radius and a centre distance drive it, staying a slot', async () => {
    const fixture = sketchFixture();
    const commit = addSlot(fixture);
    const sketchId = fixture.sketchId;
    const [line0, arc1, , arc3] = commit.edgeIds as [
      EntityId,
      EntityId,
      EntityId,
      EntityId
    ];
    const centreLine = commit.helperIds[0]!;
    for (const constraint of [
      { constraintKind: 'radius', objectId: arc1, value: 4 },
      {
        constraintKind: 'distance',
        a: { objectId: centreLine, point: 'start' },
        b: { objectId: centreLine, point: 'end' },
        value: 40
      }
    ] as const) {
      fixture.manager.execute(
        commandFactories.addSketchConstraint({ sketchId, constraint })
      );
    }
    const outcome = await fixture.solve();
    expect(outcome.converged).toBe(true);
    expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
    const solved = new Map(
      outcome.objects.map((object) => [String(object.objectId), object])
    );
    const radius = (id: string) =>
      (solved.get(id) as unknown as { radius: number }).radius;
    expect(radius(arc1!)).toBeCloseTo(4, 9);
    expect(radius(arc3!)).toBeCloseTo(4, 9);
    const line = solved.get(line0!) as unknown as Record<string, number>;
    expect(Math.hypot(line.x2! - line.x1!, line.y2! - line.y1!)).toBeCloseTo(
      40,
      9
    );
  });

  it('bounds the stadium region and extrudes to its exact area times the height', async () => {
    const fixture = sketchFixture();
    addSlot(fixture, { x: 0, y: 0 }, { x: 30, y: 10 }, 6);
    const length = Math.hypot(30, 10);
    const area = 2 * 6 * length + Math.PI * 36;
    const regions = computeSketchRegions(fixture.objectsOf(), resolve);
    const slotRegion = regions.find(
      (region) => Math.abs(region.area - area) < 1e-6
    );
    expect(slotRegion).toBeDefined();
    const extruded = extrudeSketch(fixture.manager.document, {
      name: 'Extrude',
      sketchId: fixture.sketchId,
      distance: 5,
      profiles: [
        {
          profileId: slotRegion!.profileId,
          regionFingerprint: slotRegion!.regionFingerprint,
          samplePoint: slotRegion!.samplePoint,
          sourceArea: slotRegion!.area,
          sourceEntityIds: slotRegion!.sourceEntityIds
        }
      ]
    });
    const derived = await kernel.syncDocument(extruded.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[extruded.bodyId]!;
    expect(Math.abs(body.volume - area * 5) / (area * 5)).toBeLessThan(1e-6);
  }, 120_000);

  it('undo removes the whole slot in one step', () => {
    const fixture = sketchFixture();
    const before = fixture.objectsOf().length;
    addSlot(fixture);
    expect(fixture.objectsOf()).toHaveLength(before + 5);
    fixture.manager.undo();
    expect(fixture.objectsOf()).toHaveLength(before);
    expect(fixture.sketch().composites ?? []).toEqual([]);
    expect(fixture.sketch().constraints ?? []).toEqual([]);
  });

  it('refuses a slot record whose sides are not line, arc, line, arc', () => {
    const fixture = sketchFixture([
      { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 },
      { objectKind: 'line', x1: 1, y1: 0, x2: 1, y2: 1 },
      { objectKind: 'line', x1: 1, y1: 1, x2: 0, y2: 1 },
      { objectKind: 'line', x1: 0, y1: 1, x2: 0, y2: 0 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, construction: true }
    ]);
    const ids = fixture.sketch().objectIds;
    expect(() =>
      fixture.manager.execute(
        commandFactories.addSketchComposite({
          sketchId: fixture.sketchId,
          composite: {
            compositeKind: 'slot',
            method: 'center-to-center',
            edgeIds: ids.slice(0, 4),
            helperIds: [ids[4]!]
          }
        })
      )
    ).toThrow('Side 2 of a slot must be an arc, not a line.');
  });
});

describe('I01 point', () => {
  it('is held by point relations and bounds no profile', async () => {
    const fixture = sketchFixture([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'point', x: 4, y: 3 }
    ]);
    const [line, point] = fixture.sketch().objectIds as [EntityId, EntityId];
    const sketchId = fixture.sketchId;
    const ref = { objectId: point, point: 'center' as const };
    for (const constraint of [
      {
        constraintKind: 'lock',
        point: { objectId: line, point: 'start' },
        x: 0,
        y: 0
      },
      { constraintKind: 'horizontal', objectId: line },
      {
        constraintKind: 'distance',
        a: { objectId: line, point: 'start' },
        b: { objectId: line, point: 'end' },
        value: 10
      },
      { constraintKind: 'midpoint', point: ref, line }
    ] as const) {
      fixture.manager.execute(
        commandFactories.addSketchConstraint({ sketchId, constraint })
      );
    }
    const outcome = await fixture.solve();
    expect(outcome.converged).toBe(true);
    expect(outcome.dof.rank).toBe(outcome.dof.numEquations);
    expect(outcome.dof.dof).toBe(0);
    const solved = outcome.objects.find((object) => object.objectId === point);
    expect(solved).toMatchObject({ kind: 'point' });
    expect((solved as { x: number }).x).toBeCloseTo(5, 9);
    expect((solved as { y: number }).y).toBeCloseTo(0, 9);
    expect(computeSketchRegions(fixture.objectsOf(), resolve)).toEqual([]);
  });

  it('takes coincident, on-curve and lock relations, and refuses curve-only ones', () => {
    const fixture = sketchFixture([
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 5 },
      { objectKind: 'point', x: 5, y: 0 }
    ]);
    const [circle, point] = fixture.sketch().objectIds as [EntityId, EntityId];
    const sketchId = fixture.sketchId;
    const add = (constraint: object) =>
      fixture.manager.execute(
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: constraint as never
        })
      );
    add({
      constraintKind: 'point-on-object',
      point: { objectId: point, point: 'center' },
      objectId: circle
    });
    add({
      constraintKind: 'lock',
      point: { objectId: point, point: 'center' },
      x: 5,
      y: 0
    });
    expect(() =>
      add({ constraintKind: 'horizontal', objectId: point })
    ).toThrow('A point object cannot carry this constraint');
    expect(() =>
      add({
        constraintKind: 'coincident',
        a: { objectId: point, point: 'start' },
        b: { objectId: circle, point: 'center' }
      })
    ).toThrow("A point object has no 'start' point.");
  });

  it('needs schema v59, and a current document is at least that', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(59);
    const fixture = sketchFixture();
    const old = { ...fixture.manager.document, schemaVersion: 57 } as never;
    expect(() =>
      addSketchObjects(old, {
        sketchId: fixture.sketchId,
        objects: [{ objectKind: 'point', x: 1, y: 1 }]
      })
    ).toThrow('Sketch points require project schema v59 or newer.');
  });
});
