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

  it('exports binary STL with the exact facet count in its header', async () => {
    const manager = newManager('Binary STL Part');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const bytes = await kernel.exportMesh(
      manager.document,
      [getLatestBodyId(manager.document)!],
      { format: 'stl-binary', deflection: 0.08 }
    );
    // 80-byte header, 4-byte little-endian facet count, 50 bytes per facet.
    const facets = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).getUint32(80, true);
    expect(facets).toBe(12);
    expect(bytes.byteLength).toBe(84 + facets * 50);
  });

  it('merges every body into one binary STL facet stream', async () => {
    const manager = managerWithTwoBoxes();
    const [bodyA, bodyB] = manager.document.bodyOrder;
    const facetCount = (bytes: Uint8Array) =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        80,
        true
      );
    const single = await kernel.exportMesh(manager.document, [bodyA!], {
      format: 'stl-binary',
      deflection: 0.08
    });
    const both = await kernel.exportMesh(manager.document, [bodyA!, bodyB!], {
      format: 'stl-binary',
      deflection: 0.08
    });
    expect(facetCount(both)).toBe(2 * facetCount(single));
  });

  it('exports a multi-body 3MF package', async () => {
    const manager = managerWithTwoBoxes();
    const [bodyA, bodyB] = manager.document.bodyOrder;
    const bytes = await kernel.exportMesh(manager.document, [bodyA!, bodyB!], {
      format: '3mf',
      deflection: 0.08
    });
    // A 3MF file is a zip package: PK local-file-header magic.
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('exports OBJ and glTF meshes for multi-body documents', async () => {
    const manager = managerWithTwoBoxes();
    const [bodyA, bodyB] = manager.document.bodyOrder;
    const obj = await kernel.exportMesh(manager.document, [bodyA!, bodyB!], {
      format: 'obj',
      deflection: 0.08
    });
    const text = new TextDecoder().decode(obj);
    expect(text).toContain('# remus OBJ export');
    // Two boxes: 8 corners each triangulated per face; the exact count is
    // the writer's, but both bodies' vertices must be present.
    const vertexLines = text
      .split('\n')
      .filter((line) => line.startsWith('v ')).length;
    const single = new TextDecoder().decode(
      await kernel.exportMesh(manager.document, [bodyA!], {
        format: 'obj',
        deflection: 0.08
      })
    );
    const singleVertexLines = single
      .split('\n')
      .filter((line) => line.startsWith('v ')).length;
    expect(vertexLines).toBe(2 * singleVertexLines);

    const glb = await kernel.exportMesh(manager.document, [bodyA!, bodyB!], {
      format: 'glb',
      deflection: 0.08
    });
    // GLB header: magic "glTF", version 2, declared length == byte length.
    expect(new TextDecoder().decode(glb.subarray(0, 4))).toBe('glTF');
    const header = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(header.getUint32(4, true)).toBe(2);
    expect(header.getUint32(8, true)).toBe(glb.byteLength);
  });

  it('encodes the ASCII STL format choice as bytes', async () => {
    const manager = newManager('ASCII Mesh Part');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const bytes = await kernel.exportMesh(
      manager.document,
      [getLatestBodyId(manager.document)!],
      { format: 'stl-ascii', deflection: 0.08 }
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('solid ');
  });

  it('rejects a non-positive mesh export deflection', async () => {
    const manager = newManager('Bad Deflection');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    await expect(
      kernel.exportMesh(
        manager.document,
        [getLatestBodyId(manager.document)!],
        { format: 'stl-binary', deflection: 0 }
      )
    ).rejects.toThrow(/positive/);
  });

  it('scales a body uniformly through a parameter', async () => {
    const manager = newManager('Scaled Part');
    manager.execute(
      commandFactories.setParameter({ name: 'k', expression: '2' })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Scale',
        targetBodyId: bodyId,
        translation: { x: 0, y: 0, z: 0 },
        scale: 'k'
      })
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      5 * 6 * 7 * 8,
      3
    );

    // Parametric: re-driving the parameter rescales the same feature.
    manager.execute(
      commandFactories.setParameter({ name: 'k', expression: '3' })
    );
    const rescaled = await kernel.syncDocument(manager.document);
    expect(rescaled.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      5 * 6 * 7 * 27,
      2
    );
  });

  it('rejects a non-positive transform scale as a feature warning', async () => {
    const manager = newManager('Bad Scale');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Collapse',
        targetBodyId: bodyId,
        translation: { x: 0, y: 0, z: 0 },
        scale: 0
      })
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(derived.warnings.join('\n')).toMatch(/positive/);
    // The failed feature leaves the body at its unscaled size.
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(210, 4);
  });

  it('reports watertight mesh quality for a solid box', async () => {
    const manager = newManager('Quality Part');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 6, depth: 7 }
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    const report = await kernel.meshQuality(manager.document, [bodyId], 0.08);
    expect(report.watertight).toBe(true);
    expect(report.bodies).toEqual([
      {
        bodyId,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        watertight: true
      }
    ]);
  });
});
