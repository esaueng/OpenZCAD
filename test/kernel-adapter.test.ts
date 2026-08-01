import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId,
  getLatestSketchId
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toBodyId, toUserId, type FeatureNode } from '@openzcad/shared';

/**
 * The document-to-kernel contract: what a rebuild publishes for a document,
 * how it reports a feature it cannot build, and what the export paths emit.
 * One kernel builds every body, so these are absolute expectations rather than
 * a comparison against a second implementation.
 */
function newManager(name = 'Kernel Test'): CommandManager {
  return new CommandManager(createProjectDocument(name, toUserId('user_test')));
}

function managerWithTwoBoxes(): CommandManager {
  const manager = newManager();
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box A',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box B',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    })
  );
  manager.execute(
    commandFactories.transformBody({
      name: 'Move B',
      targetBodyId: getLatestBodyId(manager.document)!,
      translation: { x: 5, y: 0, z: 0 }
    })
  );
  return manager;
}

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
});

afterAll(() => {
  kernel.dispose();
});

// Real-kernel suites: WASM startup alone can exceed the 5 s default when the
// whole test pool is contending for CPU.
describe('kernel sync', { timeout: 30_000 }, () => {
  it('derives real meshes with volume and bounds', async () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      })
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const body =
      derived.bodyRepresentations[getLatestBodyId(manager.document)!]!;
    expect(body.mesh.indices.length).toBeGreaterThan(0);
    expect(body.volume).toBeCloseTo(6000, 4);
    expect(body.faceCount).toBe(6);
    // Corner on the origin, not centred on it.
    expect(body.bbox.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(body.bbox.max).toEqual({ x: 10, y: 20, z: 30 });
    expect(body.exportableStep).toBe(true);
    expect(body.consumed).toBe(false);
  });

  it('drives feature dimensions from parameters and regenerates on edits', async () => {
    const manager = newManager();
    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '30' })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Param Box',
        primitiveKind: 'box',
        dimensions: { width: 'w', height: 'w / 2', depth: 10 }
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    const first = await kernel.syncDocument(manager.document);
    expect(first.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      30 * 15 * 10,
      4
    );

    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '40' })
    );
    const second = await kernel.syncDocument(manager.document);
    expect(second.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      40 * 20 * 10,
      4
    );
  });

  it('surfaces parameter errors as warnings instead of dropping geometry silently', async () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Broken Box',
        primitiveKind: 'box',
        dimensions: { width: 'missing_param', height: 1, depth: 1 }
      })
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings.join(' ')).toMatch(/Broken Box/);
    expect(derived.warnings.join(' ')).toMatch(/missing_param/);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(0);
  });

  it('bakes transforms into world-space vertices', async () => {
    const manager = managerWithTwoBoxes();
    const derived = await kernel.syncDocument(manager.document);
    const moved =
      derived.bodyRepresentations[getLatestBodyId(manager.document)!]!;
    // Box B spans 0..10 from the origin, then the transform shifts it +5.
    expect(moved.bbox.min.x).toBeCloseTo(5, 6);
    expect(moved.bbox.max.x).toBeCloseTo(15, 6);
  });

  it('runs booleans in the kernel and marks inputs consumed', async () => {
    const manager = managerWithTwoBoxes();
    const [bodyA, bodyB] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union AB',
        operation: 'union',
        targetBodyIds: [bodyA!, bodyB!]
      })
    );
    const unionBodyId = getLatestBodyId(manager.document)!;
    const derived = await kernel.syncDocument(manager.document);

    const union = derived.bodyRepresentations[unionBodyId]!;
    expect(union.volume).toBeCloseTo(1500, 3);
    expect(union.consumed).toBe(false);
    expect(derived.bodyRepresentations[bodyA!]!.consumed).toBe(true);
    expect(derived.bodyRepresentations[bodyB!]!.consumed).toBe(true);
    expect(derived.exportableBodyIds).toEqual([unionBodyId]);
  });

  it('builds extrude and revolve features from sketches', async () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addSketch({
        name: 'Plate Profile',
        plane: 'XZ',
        offset: 0,
        object: {
          objectKind: 'rectangle',
          width: 20,
          height: 10,
          centerX: 0,
          centerY: 0
        }
      })
    );
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Plate',
        sketchId: getLatestSketchId(manager.document)!,
        distance: 5
      })
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Ring Profile',
        plane: 'XY',
        offset: 0,
        object: { objectKind: 'circle', radius: 4, centerX: 20, centerY: 0 }
      })
    );
    manager.execute(
      commandFactories.revolveSketch({
        name: 'Ring',
        sketchId: getLatestSketchId(manager.document)!,
        axis: 'vertical'
      })
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bodies = Object.values(derived.bodyRepresentations);
    expect(bodies).toHaveLength(2);
    const plate = bodies.find((body) => body.name.startsWith('Plate'))!;
    expect(plate.volume).toBeCloseTo(1000, 4);
    const ring = bodies.find((body) => body.name.startsWith('Ring'))!;
    // Torus of revolution: V = 2 pi^2 R r^2, exactly on an analytic kernel.
    expect(ring.volume).toBeCloseTo(2 * Math.PI * Math.PI * 20 * 16, 6);
    expect(ring.faceCount).toBe(1);
  });

  it('warns when a transform targets a missing body', async () => {
    const manager = newManager();
    // Bypass factory validation to simulate a stale document reference.
    const command = commandFactories.transformBody({
      name: 'Move ghost',
      targetBodyId: toBodyId('body_missing'),
      translation: { x: 1, y: 1, z: 1 }
    });
    command.validate = () => {};
    manager.execute(command);
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings).toContain(
      'Feature "Move ghost": Transform target is unavailable.'
    );
  });

  it('recovers when a feature is deleted out from under a dependent', async () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        offset: 0,
        object: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    manager.execute(
      commandFactories.extrudeSketch({ name: 'Puck', sketchId, distance: 4 })
    );
    const sketchFeature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'sketch'
    )!;
    manager.execute(
      commandFactories.deleteFeature({ featureId: sketchFeature.featureId })
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings.join(' ')).toMatch(/Puck/);
  });
});

describe('kernel export', { timeout: 30_000 }, () => {
  it('exports a real STEP file for derived bodies', async () => {
    const manager = managerWithTwoBoxes();
    const [bodyA, bodyB] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union AB',
        operation: 'union',
        targetBodyIds: [bodyA!, bodyB!]
      })
    );
    const unionBodyId = getLatestBodyId(manager.document)!;
    const text = await kernel.exportStep(manager.document, [unionBodyId]);
    expect(text).toContain('ISO-10303-21;');
    expect(text).toContain('MANIFOLD_SOLID_BREP');
    expect(text).toContain('CLOSED_SHELL');
  });

  it('exports ASCII STL with facet normals', async () => {
    const manager = newManager('STL Part');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const stl = await kernel.exportStl(manager.document, [
      getLatestBodyId(manager.document)!
    ]);
    expect(stl).toMatch(/^solid /);
    expect(stl).toContain('facet normal');
    expect((stl.match(/facet normal/g) ?? []).length).toBe(12);
  });

  it('refuses to export bodies without geometry', async () => {
    const manager = newManager();
    await expect(
      kernel.exportStep(manager.document, [toBodyId('body_missing')])
    ).rejects.toThrow(/no exact geometry/);
  });
});
