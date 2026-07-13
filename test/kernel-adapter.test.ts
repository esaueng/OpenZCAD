import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, getLatestBodyId, getLatestSketchId } from '@openzcad/document-core';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import { toBodyId, toUserId, type FeatureNode } from '@openzcad/shared';

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

const kernel = createKernelAdapter();

describe('kernel sync', () => {
  it('derives real meshes with volume and bounds', () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      })
    );
    const derived = kernel.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[getLatestBodyId(manager.document)!]!;
    expect(body.mesh.indices.length).toBeGreaterThan(0);
    expect(body.volume).toBeCloseTo(6000, 4);
    expect(body.faceCount).toBe(6);
    expect(body.bbox.min).toEqual({ x: -5, y: -10, z: -15 });
    expect(body.exportableStep).toBe(true);
    expect(body.consumed).toBe(false);
  });

  it('drives feature dimensions from parameters and regenerates on edits', () => {
    const manager = newManager();
    manager.execute(commandFactories.setParameter({ name: 'w', expression: '30' }));
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Param Box',
        primitiveKind: 'box',
        dimensions: { width: 'w', height: 'w / 2', depth: 10 }
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    expect(kernel.syncDocument(manager.document).bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      30 * 15 * 10,
      4
    );

    manager.execute(commandFactories.setParameter({ name: 'w', expression: '40' }));
    expect(kernel.syncDocument(manager.document).bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      40 * 20 * 10,
      4
    );
  });

  it('surfaces parameter errors as warnings instead of dropping geometry silently', () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Broken Box',
        primitiveKind: 'box',
        dimensions: { width: 'missing_param', height: 1, depth: 1 }
      })
    );
    const derived = kernel.syncDocument(manager.document);
    expect(derived.warnings.join(' ')).toMatch(/Broken Box/);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(0);
  });

  it('bakes transforms into world-space vertices', () => {
    const manager = managerWithTwoBoxes();
    const derived = kernel.syncDocument(manager.document);
    const moved = derived.bodyRepresentations[getLatestBodyId(manager.document)!]!;
    expect(moved.bbox.min.x).toBeCloseTo(0, 6);
    expect(moved.bbox.max.x).toBeCloseTo(10, 6);
  });

  it('runs real CSG for booleans and marks inputs consumed', () => {
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
    const derived = kernel.syncDocument(manager.document);

    const union = derived.bodyRepresentations[unionBodyId]!;
    expect(union.volume).toBeCloseTo(1500, 3);
    expect(union.consumed).toBe(false);
    expect(derived.bodyRepresentations[bodyA!]!.consumed).toBe(true);
    expect(derived.bodyRepresentations[bodyB!]!.consumed).toBe(true);
    expect(derived.exportableBodyIds).toEqual([unionBodyId]);
  });

  it('builds extrude and revolve features from sketches', () => {
    const manager = newManager();
    manager.execute(
      commandFactories.addSketch({
        name: 'Plate Profile',
        plane: 'XZ',
        offset: 0,
        object: { objectKind: 'rectangle', width: 20, height: 10, centerX: 0, centerY: 0 }
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
    const derived = kernel.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bodies = Object.values(derived.bodyRepresentations);
    expect(bodies).toHaveLength(2);
    const plate = bodies.find((body) => body.name.startsWith('Plate'))!;
    expect(plate.volume).toBeCloseTo(1000, 4);
    const ring = bodies.find((body) => body.name.startsWith('Ring'))!;
    // Torus of revolution: V = 2 pi^2 R r^2 (tessellated slightly below).
    const analytic = 2 * Math.PI * Math.PI * 20 * 16;
    expect(ring.volume).toBeGreaterThan(analytic * 0.95);
    expect(ring.volume).toBeLessThan(analytic);
  });

  it('warns when a transform targets a missing body', () => {
    const manager = newManager();
    // Bypass factory validation to simulate a stale document reference.
    const command = commandFactories.transformBody({
      name: 'Move ghost',
      targetBodyId: toBodyId('body_missing'),
      translation: { x: 1, y: 1, z: 1 }
    });
    command.validate = () => {};
    manager.execute(command);
    const derived = kernel.syncDocument(manager.document);
    expect(derived.warnings).toContain('Transform "Move ghost" targets a missing body.');
  });

  it('recovers when a feature is deleted out from under a dependent', () => {
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
    manager.execute(commandFactories.extrudeSketch({ name: 'Puck', sketchId, distance: 4 }));
    const sketchFeature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode => node.kind === 'feature' && node.featureKind === 'sketch'
    )!;
    manager.execute(commandFactories.deleteFeature({ featureId: sketchFeature.featureId }));
    const derived = kernel.syncDocument(manager.document);
    expect(derived.warnings.join(' ')).toMatch(/Puck/);
  });
});

describe('kernel export', () => {
  it('exports a real STEP file for derived bodies', () => {
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
    const { text, warnings } = kernel.exportStep(manager.document, [unionBodyId]);
    expect(warnings).toEqual([]);
    expect(text).toContain('ISO-10303-21;');
    expect(text).toContain('MANIFOLD_SOLID_BREP');
    expect(text).toContain('CLOSED_SHELL');
  });

  it('exports ASCII STL with facet normals', () => {
    const manager = newManager('STL Part');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const stl = kernel.exportStl(manager.document, [getLatestBodyId(manager.document)!]);
    expect(stl).toContain('solid STL_Part');
    expect(stl).toContain('facet normal');
    expect((stl.match(/facet normal/g) ?? []).length).toBe(12);
  });

  it('refuses to export bodies without geometry', () => {
    const manager = newManager();
    expect(() => kernel.exportStep(manager.document, [toBodyId('body_missing')])).toThrow(
      /no geometry/
    );
  });
});
