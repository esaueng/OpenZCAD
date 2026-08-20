import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchConstraint,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getLatestBodyId,
  getLatestSketchId,
  revolveSketch,
  setParameter,
  transformBody,
  type PrimitiveInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

/**
 * Kernel conventions, pinned absolutely.
 *
 * Remus is the only kernel, so "where does a primitive sit and which way does
 * it point" can no longer be checked by agreeing with a second kernel — it has
 * to be asserted outright. Every case below states the analytic volume and the
 * exact placement the document model promises, so a kernel upgrade that quietly
 * re-centres a box, spins a cylinder onto another axis, or changes Euler order
 * fails here instead of in a user's model.
 *
 * These are exact-kernel numbers: analytic surfaces, so volumes match closed
 * form rather than a faceting tolerance.
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
  faceCount: number;
  bbox: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
}

// Real-kernel suite: see the note in exact-kernel-adapter.test.ts — WASM
// startup alone can exceed the 5 s default under pool contention.
describe('exact kernel conventions', { timeout: 30_000 }, () => {
  let exact: ExactKernelAdapter;

  beforeAll(async () => {
    exact = await createExactKernelAdapter();
  });

  afterAll(() => {
    exact.dispose();
  });

  async function measure(document: ProjectDocument): Promise<Measured> {
    const bodyId = getLatestBodyId(document)!;
    const derived = await exact.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[bodyId]!;
  }

  function expectBounds(
    measured: Measured,
    min: [number, number, number],
    max: [number, number, number],
    precision = 6
  ): void {
    const axes = ['x', 'y', 'z'] as const;
    axes.forEach((axis, index) => {
      expect(measured.bbox.min[axis]).toBeCloseTo(min[index]!, precision);
      expect(measured.bbox.max[axis]).toBeCloseTo(max[index]!, precision);
    });
  }

  it('puts a box corner on the origin, not its centre', async () => {
    const measured = await measure(
      primitive('Box', 'box', { width: 10, height: 20, depth: 30 })
    );
    expect(measured.volume).toBeCloseTo(6000, 9);
    expect(measured.faceCount).toBe(6);
    expectBounds(measured, [0, 0, 0], [10, 20, 30]);
  });

  it('points a cylinder down +Z from a base on z=0', async () => {
    const measured = await measure(
      primitive('Cylinder', 'cylinder', { radius: 5, height: 12 })
    );
    // Analytic, not faceted: pi * r^2 * h exactly.
    expect(measured.volume).toBeCloseTo(Math.PI * 25 * 12, 9);
    // Side, top, bottom — one analytic cylindrical face, not 48 facets.
    expect(measured.faceCount).toBe(3);
    expectBounds(measured, [-5, -5, 0], [5, 5, 12]);
  });

  it('points a cone down +Z and keeps the frustum volume analytic', async () => {
    const measured = await measure(
      primitive('Cone', 'cone', { bottomRadius: 6, topRadius: 3, height: 9 })
    );
    const analytic = ((Math.PI * 9) / 3) * (36 + 6 * 3 + 9);
    expect(measured.volume).toBeCloseTo(analytic, 9);
    expect(measured.faceCount).toBe(3);
    expectBounds(measured, [-6, -6, 0], [6, 6, 9]);
  });

  it('centres a sphere on the origin', async () => {
    const measured = await measure(
      primitive('Sphere', 'sphere', { radius: 7 })
    );
    expect(measured.volume).toBeCloseTo((4 / 3) * Math.PI * 343, 9);
    expectBounds(measured, [-7, -7, -7], [7, 7, 7]);
  });

  it('lays a torus ring in XY with its tube along Z', async () => {
    const measured = await measure(
      primitive('Torus', 'torus', { majorRadius: 10, minorRadius: 2 })
    );
    expect(measured.volume).toBeCloseTo(2 * Math.PI * Math.PI * 10 * 4, 9);
    // Thin axis is Z; the ring reaches majorRadius + minorRadius in X and Y.
    expectBounds(measured, [-12, -12, -2], [12, 12, 2]);
  });

  it('rotates about the world origin, not the body centre', async () => {
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
    const measured = await measure(document);
    expect(measured.volume).toBeCloseTo(6000, 6);
    // The box spans x 0..10 and y 0..20; Rz(90) sweeps it onto -X.
    expectBounds(measured, [-20, 0, 0], [0, 10, 30]);
  });

  it('applies multi-axis rotations in X, then Y, then Z order', async () => {
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
    const measured = await measure(document);
    expect(measured.volume).toBeCloseTo(6000, 6);
    // Pinned from the ZYX composition; an XYZ order lands elsewhere entirely.
    expectBounds(
      measured,
      [-4.136519851713, -3, -4.427876096865],
      [32.149330470906, 22.076901471913, 29.562862876258],
      6
    );
  });

  it('extrudes a centred sketch rectangle along the plane normal', async () => {
    let document = createProjectDocument(
      'Extrude',
      toUserId('user_conformance')
    );
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
    const measured = await measure(document);
    expect(measured.volume).toBeCloseTo(32 * 18 * 12, 6);
    expectBounds(measured, [-16, -9, 0], [16, 9, 12]);
  });

  it('extrudes a circle below its offset plane for a negative distance', async () => {
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
    const measured = await measure(document);
    expect(measured.volume).toBeCloseTo(Math.PI * 36 * 12, 9);
    // Plane at z=4, extruded -12: the solid spans z -8..4, centred on (3, -2).
    expectBounds(measured, [-3, -8, -8], [9, 4, 4]);
  });

  it('revolves an offset rectangle into an annular ring', async () => {
    let document = createProjectDocument(
      'Revolve',
      toUserId('user_conformance')
    );
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
    const measured = await measure(document);
    // Annulus between r=8 and r=12, 6 tall.
    expect(measured.volume).toBeCloseTo(Math.PI * (144 - 64) * 6, 9);
    expectBounds(measured, [-12, -12, -3], [12, 12, 3]);
  });

  it('subtracts a positioned cavity without changing the outer envelope', async () => {
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
    const measured = await measure(document);
    expect(measured.volume).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18, 6);
    // Six outer faces plus the five cavity walls: the cavity is open on +Z.
    expect(measured.faceCount).toBe(11);
    expectBounds(measured, [0, 0, 0], [40, 30, 20]);
  });

  it('solves persisted sketch constraints through the GCS', async () => {
    let document = createProjectDocument(
      'GCS Solve',
      toUserId('user_conformance')
    );
    document = setParameter(document, { name: 'len', expression: '20' });
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 9, y2: 2 },
        { objectKind: 'line', x1: 0, y1: 5, x2: 11, y2: 9 },
        { objectKind: 'circle', radius: 4, centerX: 30, centerY: 0 }
      ]
    });
    const sketch = findSketch(withSketch, sketchId)!;
    const [lineA, lineB, circle] = sketch.objectIds;

    let constrained = addSketchConstraint(withSketch, {
      sketchId,
      constraint: { constraintKind: 'horizontal', objectId: lineA! }
    }).document;
    constrained = addSketchConstraint(constrained, {
      sketchId,
      constraint: { constraintKind: 'parallel', a: lineA!, b: lineB! }
    }).document;
    constrained = addSketchConstraint(constrained, {
      sketchId,
      constraint: {
        constraintKind: 'distance',
        a: { objectId: lineA!, point: 'start' },
        b: { objectId: lineA!, point: 'end' },
        // A driving dimension through a named parameter, like every other
        // sketch dimension.
        value: 'len'
      }
    }).document;
    constrained = addSketchConstraint(constrained, {
      sketchId,
      constraint: { constraintKind: 'radius', objectId: circle!, value: 7 }
    }).document;

    const outcome = await exact.solveSketch(constrained, sketchId);
    expect(outcome.converged).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.maxResidual).toBeLessThan(1e-8);
    // Positions are still free, so the sketch cannot classify as fully
    // solved — but it must not read as redundant or unsatisfied either.
    expect(['solved', 'underConstrained']).toContain(outcome.classification);
    expect(outcome.dof.dof).toBeGreaterThan(0);
    expect(outcome.constraintResiduals).toHaveLength(4);
    for (const residual of outcome.constraintResiduals) {
      expect(residual.maxResidual).toBeLessThan(1e-8);
    }

    const solvedLineA = outcome.objects.find(
      (object) => object.objectId === lineA
    );
    const solvedLineB = outcome.objects.find(
      (object) => object.objectId === lineB
    );
    const solvedCircle = outcome.objects.find(
      (object) => object.objectId === circle
    );
    if (
      solvedLineA?.kind !== 'line' ||
      solvedLineB?.kind !== 'line' ||
      solvedCircle?.kind !== 'circle'
    ) {
      throw new Error('Solved geometry lost an object.');
    }
    // Horizontal: the line's endpoints share a Y.
    expect(Math.abs(solvedLineA.y2 - solvedLineA.y1)).toBeLessThan(1e-8);
    // Driven length via the parameter.
    expect(
      Math.hypot(
        solvedLineA.x2 - solvedLineA.x1,
        solvedLineA.y2 - solvedLineA.y1
      )
    ).toBeCloseTo(20, 8);
    // Parallel: cross product of directions vanishes.
    expect(
      Math.abs(
        (solvedLineA.x2 - solvedLineA.x1) * (solvedLineB.y2 - solvedLineB.y1) -
          (solvedLineA.y2 - solvedLineA.y1) * (solvedLineB.x2 - solvedLineB.x1)
      )
    ).toBeLessThan(1e-6);
    expect(solvedCircle.radius).toBeCloseTo(7, 8);
  });

  it('rolls back a sketch whose driving dimensions conflict', async () => {
    const base = createProjectDocument(
      'GCS Conflict',
      toUserId('user_conformance')
    );
    const { document: withSketch, sketchId } = addSketchFeature(base, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
    });
    const [line] = findSketch(withSketch, sketchId)!.objectIds;
    let conflicted = addSketchConstraint(withSketch, {
      sketchId,
      constraint: {
        constraintKind: 'distance',
        a: { objectId: line!, point: 'start' },
        b: { objectId: line!, point: 'end' },
        value: 10
      }
    }).document;
    conflicted = addSketchConstraint(conflicted, {
      sketchId,
      constraint: {
        constraintKind: 'distance',
        a: { objectId: line!, point: 'start' },
        b: { objectId: line!, point: 'end' },
        value: 20
      }
    }).document;

    const outcome = await exact.solveSketch(conflicted, sketchId);
    // The same two points cannot be both 10 and 20 apart. The kernel's
    // detailed solve is transactional, so the input geometry survives.
    expect(outcome.converged).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    const restored = outcome.objects.find(
      (object) => object.objectId === line
    );
    if (restored?.kind !== 'line') {
      throw new Error('Rolled-back geometry lost the line.');
    }
    expect(restored.x1).toBeCloseTo(0, 8);
    expect(restored.x2).toBeCloseTo(10, 8);
  });
});
