import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  getLatestBodyId,
  getLatestSketchId,
  revolveSketch,
  transformBody,
  type PrimitiveInput
} from '@openzcad/document-core';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

/**
 * The AI preview renders with the compat polyhedral kernel on the main thread
 * while Apply rebuilds with the exact BrepKit kernel in a worker. If the two
 * disagree about where a primitive sits or which way it points, every preview
 * lies about the model the user is agreeing to.
 *
 * These cases pin the compat kernel to BrepKit's conventions. The compat kernel
 * approximates curves with facets, so radial sizes and volumes are compared with
 * a tolerance; placement and orientation must agree closely.
 */
function primitive(
  name: string,
  primitiveKind: PrimitiveInput['primitiveKind'],
  dimensions: Record<string, number>
): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_conformance')),
    { name, primitiveKind, dimensions }
  );
}

interface Measured {
  volume: number;
  bbox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

describe('compat kernel conforms to the exact kernel', () => {
  let exact: ExactKernelAdapter;
  const compat = createKernelAdapter();

  beforeAll(async () => {
    exact = await createExactKernelAdapter();
  });

  afterAll(() => {
    exact.dispose();
  });

  async function measure(
    document: ProjectDocument
  ): Promise<{ compat: Measured; exact: Measured }> {
    const bodyId = getLatestBodyId(document)!;
    const fromCompat = compat.syncDocument(document);
    const fromExact = await exact.syncDocument(document);
    return {
      compat: fromCompat.bodyRepresentations[bodyId]! as Measured,
      exact: fromExact.bodyRepresentations[bodyId]! as Measured
    };
  }

  function expectAgreement(
    result: { compat: Measured; exact: Measured },
    { volumeTolerance = 0.02, placeTolerance = 0.02 } = {}
  ) {
    const { compat: a, exact: b } = result;
    // Faceting always under-fills a curved solid, so compare proportionally.
    expect(Math.abs(a.volume - b.volume) / b.volume).toBeLessThan(
      volumeTolerance
    );
    for (const axis of ['x', 'y', 'z'] as const) {
      const span = Math.max(
        b.bbox.max[axis] - b.bbox.min[axis],
        1
      );
      expect(Math.abs(a.bbox.min[axis] - b.bbox.min[axis]) / span).toBeLessThan(
        placeTolerance
      );
      expect(Math.abs(a.bbox.max[axis] - b.bbox.max[axis]) / span).toBeLessThan(
        placeTolerance
      );
    }
  }

  it('places a box at the same corner', async () => {
    const result = await measure(
      primitive('Box', 'box', { width: 10, height: 20, depth: 30 })
    );
    expectAgreement(result, { volumeTolerance: 1e-9, placeTolerance: 1e-6 });
    // Both kernels must put the box's corner on the origin, not its centre.
    expect(result.compat.bbox.min.x).toBeCloseTo(0, 6);
    expect(result.compat.bbox.max.z).toBeCloseTo(30, 6);
  });

  it('points a cylinder down the same axis', async () => {
    const result = await measure(
      primitive('Cylinder', 'cylinder', { radius: 5, height: 12 })
    );
    expectAgreement(result);
    // Base on z=0 with the axis along +Z — the compat kernel used to run its
    // cylinders along Y, so a preview showed them turned 90 degrees.
    expect(result.compat.bbox.min.z).toBeCloseTo(0, 6);
    expect(result.compat.bbox.max.z).toBeCloseTo(12, 6);
  });

  it('points a cone down the same axis', async () => {
    expectAgreement(
      await measure(
        primitive('Cone', 'cone', { bottomRadius: 6, topRadius: 3, height: 9 })
      )
    );
  });

  it('centres a sphere the same way', async () => {
    expectAgreement(await measure(primitive('Sphere', 'sphere', { radius: 7 })), {
      // A 32x16 facet sphere is visibly under-filled against an exact one.
      volumeTolerance: 0.06
    });
  });

  it('orients a torus the same way', async () => {
    const result = await measure(
      primitive('Torus', 'torus', { majorRadius: 10, minorRadius: 2 })
    );
    expectAgreement(result, { volumeTolerance: 0.06 });
    // Ring in XY, tube along Z: the thin axis is Z.
    expect(result.compat.bbox.max.z).toBeCloseTo(2, 6);
    expect(result.compat.bbox.max.x).toBeCloseTo(12, 1);
  });

  it('agrees on a rotation about a single axis', async () => {
    let document = primitive('Box', 'box', {
      width: 10,
      height: 20,
      depth: 30
    });
    document = transformBody(document, {
      name: 'Spin',
      targetBodyId: getLatestBodyId(document)!,
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    expectAgreement(await measure(document), {
      volumeTolerance: 1e-6,
      placeTolerance: 1e-6
    });
  });

  it('agrees on a rotation about several axes at once', async () => {
    let document = primitive('Box', 'box', {
      width: 10,
      height: 20,
      depth: 30
    });
    document = transformBody(document, {
      name: 'Tumble',
      targetBodyId: getLatestBodyId(document)!,
      translation: { x: 5, y: -3, z: 2 },
      rotationDeg: { x: 30, y: 40, z: 50 }
    }).document;
    expectAgreement(await measure(document), {
      volumeTolerance: 1e-6,
      placeTolerance: 1e-6
    });
  });

  it('agrees on an extruded sketch', async () => {
    let document = createProjectDocument('Extrude', toUserId('user_conformance'));
    document = addSketchFeature(document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 32,
        height: 18,
        centerX: 0,
        centerY: 0
      }
    }).document;
    document = extrudeSketch(document, {
      name: 'Pad',
      sketchId: getLatestSketchId(document)!,
      distance: 12
    }).document;
    expectAgreement(await measure(document), {
      volumeTolerance: 1e-6,
      placeTolerance: 1e-6
    });
  });

  it('agrees on a circular sketch extruded below its plane', async () => {
    let document = createProjectDocument(
      'Negative circle extrude',
      toUserId('user_conformance')
    );
    document = addSketchFeature(document, {
      name: 'Circle profile',
      plane: 'XY',
      offset: 4,
      object: {
        objectKind: 'circle',
        radius: 6,
        centerX: 3,
        centerY: -2
      }
    }).document;
    document = extrudeSketch(document, {
      name: 'Negative pad',
      sketchId: getLatestSketchId(document)!,
      distance: -12
    }).document;
    expectAgreement(await measure(document), {
      volumeTolerance: 0.03,
      placeTolerance: 0.03
    });
  });

  it('agrees on a revolved sketch', async () => {
    let document = createProjectDocument('Revolve', toUserId('user_conformance'));
    document = addSketchFeature(document, {
      name: 'Profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 4,
        height: 6,
        centerX: 10,
        centerY: 0
      }
    }).document;
    document = revolveSketch(document, {
      name: 'Ring',
      sketchId: getLatestSketchId(document)!,
      axis: 'vertical'
    }).document;
    expectAgreement(await measure(document));
  });

  it('agrees on a hollow box built by subtraction', async () => {
    let document = primitive('Outer', 'box', {
      width: 40,
      height: 30,
      depth: 20
    });
    const outer = getLatestBodyId(document)!;
    document = addPrimitiveFeature(document, {
      name: 'Cavity',
      primitiveKind: 'box',
      dimensions: { width: 36, height: 26, depth: 18 }
    });
    const cavity = getLatestBodyId(document)!;
    document = transformBody(document, {
      name: 'Position Cavity',
      targetBodyId: cavity,
      translation: { x: 2, y: 2, z: 2 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    document = booleanBodies(document, {
      name: 'Shell',
      operation: 'subtract',
      targetBodyIds: [outer, cavity]
    }).document;
    expectAgreement(await measure(document), {
      volumeTolerance: 1e-6,
      placeTolerance: 1e-6
    });
  });
});
