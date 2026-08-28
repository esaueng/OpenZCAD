import { readFileSync } from 'node:fs';

import { drillHole } from '../packages/kernel-adapter/src/exact-cylinder-ops';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectReflectionSymmetries,
  measureImportedStep,
  measureRuledEdgeSweepDeviation,
  type AnalyticInventory
} from './support/reconstruction-measurement';

const HAMMER_HOLDER_STEP = process.env.OPENZCAD_HAMMER_HOLDER_STEP;

function translation(x: number, y: number, z: number): Float64Array {
  return new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
}

function translated(
  kernel: RemusKernel,
  solid: number,
  x: number,
  y: number,
  z: number
): number {
  return kernel.copyAndTransformSolid(solid, translation(x, y, z));
}

function syntheticHolderStep(kernel: RemusKernel): Uint8Array {
  const sideProfile = kernel.makePolygon(
    new Float64Array([
      0, 0, 0, 60, 0, 0, 60, 32, 0, 52, 32, 0, 52, 8, 0, 8, 8, 0, 8, 32, 0, 0,
      32, 0
    ])
  );
  let holder = kernel.extrude(sideProfile, 0, 0, 1, 20);
  for (const x of [4, 56]) {
    holder = drillHole(kernel, holder, {
      surfacePoint: { x, y: 19, z: 20 },
      axis: { x: 0, y: 0, z: -1 },
      radius: 2.5,
      depth: 20,
      style: 'countersink',
      countersinkRadius: 4.5,
      countersinkAngle: Math.PI / 2,
      entryExtension: 0.2,
      exitExtension: 0.2
    });
  }

  // An analytic one-sided boss stands in for the embossed text. It makes the
  // model only partially symmetric without smuggling a proprietary glyph or
  // a free-form surface into the repository.
  const emboss = translated(kernel, kernel.makeBox(0.4, 6, 4), 8, 14, 7);
  holder = kernel.fuse(holder, emboss);
  expect(kernel.validateSolid(holder)).toBe(0);
  return kernel.exportStep(holder);
}

describe('guided-reconstruction measurement tooling', () => {
  let kernel: RemusKernel;

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  afterEach(() => {
    kernel.free();
  });

  it('measures the synthetic imported U-bracket hypothesis kinds', () => {
    const report = measureImportedStep(kernel, syntheticHolderStep(kernel));

    expect(report.validationErrors).toBe(0);
    expect(report.inventory.bySurfaceType.plane).toBeGreaterThan(0);
    expect(report.inventory.bySurfaceType.cylinder).toBe(2);
    expect(report.inventory.bySurfaceType.cone).toBe(2);

    const opening = report.parallelPlaneSpacings.find(
      (spacing) =>
        Math.abs(spacing.distance - 44) <= 1e-8 &&
        Math.abs(Math.abs(spacing.normal[0]) - 1) <= 1e-8
    );
    expect(
      opening,
      JSON.stringify(report.parallelPlaneSpacings, null, 2)
    ).toBeDefined();

    const armSymmetry = report.reflectionSymmetries.find(
      (symmetry) =>
        Math.abs(Math.abs(symmetry.planeNormal.x) - 1) <= 1e-8 &&
        Math.abs(symmetry.planeOffset - 30) <= 1e-8
    );
    expect(
      armSymmetry,
      JSON.stringify(report.reflectionSymmetries, null, 2)
    ).toBeDefined();
    expect(armSymmetry!.matchedAnalyticFaces).toBeGreaterThan(0);
    expect(armSymmetry!.unmatchedAnalyticFaces).toBeGreaterThan(0);

    const rectangularFace = report.inventory.faces.find(
      (face) =>
        face.surfaceType === 'plane' &&
        kernel.getFaceEdges(face.face).length === 4
    );
    expect(rectangularFace).toBeDefined();
    const planarDeviation = measureRuledEdgeSweepDeviation(
      kernel,
      rectangularFace!.face
    );
    expect(planarDeviation.maximum).toBeLessThan(1e-8);
  });

  it('refuses over-budget symmetry and edge-sweep work', () => {
    const faces = Array.from({ length: 65 }, (_, index) => {
      const center = {
        x: index,
        y: index ** 2,
        z: index ** 3
      };
      return {
        face: index,
        surfaceType: 'sphere',
        analytic: true,
        area: 1,
        center,
        vertices: [center],
        parameters: { radius: 1 },
        radius: 1
      };
    });
    const inventory: AnalyticInventory = {
      totalFaces: faces.length,
      analyticFaces: faces.length,
      bySurfaceType: { sphere: faces.length },
      faces
    };
    expect(() =>
      detectReflectionSymmetries(inventory, {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 64, y: 64 ** 2, z: 64 ** 3 }
      })
    ).toThrow(/candidate budget/);
    expect(() =>
      detectReflectionSymmetries(
        { ...inventory, faces: Array(129).fill(faces[0]) },
        {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 }
        }
      )
    ).toThrow(/analytic-face budget/);
    expect(() =>
      detectReflectionSymmetries(
        { ...inventory, faces: [faces[0]!] },
        {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 }
        },
        { maxSymmetries: 33 }
      )
    ).toThrow(/max symmetries/);

    expect(() =>
      measureRuledEdgeSweepDeviation(kernel, 0, { samplesPerRail: 66 })
    ).toThrow(/samples per rail/);
    expect(() =>
      measureRuledEdgeSweepDeviation(kernel, 0, { edgeDeflection: 1e-5 })
    ).toThrow(/rail deflection/);
  });

  it.skipIf(!HAMMER_HOLDER_STEP)(
    'reproduces the recorded local Hammer Holder measurements',
    () => {
      const report = measureImportedStep(
        kernel,
        readFileSync(HAMMER_HOLDER_STEP!)
      );

      expect(report.faceCount).toBe(160);
      expect(report.edgeCount).toBe(386);
      expect(Math.abs(report.volume - 50_240.47)).toBeLessThan(0.02);
      expect(report.validationErrors).toBe(0);
      expect(report.inventory.bySurfaceType).toEqual({
        bspline: 42,
        cone: 2,
        cylinder: 42,
        plane: 52,
        sphere: 8,
        torus: 14
      });
      expect(
        report.parallelPlaneSpacings.some(
          (spacing) =>
            Math.abs(spacing.distance - 46) <= 1e-8 &&
            Math.abs(Math.abs(spacing.normal[0]) - 1) <= 1e-8
        )
      ).toBe(true);
      expect(
        report.reflectionSymmetries.some(
          (symmetry) =>
            Math.abs(Math.abs(symmetry.planeNormal.x) - 1) <= 1e-8 &&
            Math.abs(symmetry.planeOffset - 11) <= 1e-8
        )
      ).toBe(true);

      const neckFaces = report.inventory.faces.filter(
        (face) =>
          face.surfaceType === 'bspline' &&
          face.area > 20 &&
          kernel.getFaceEdges(face.face).length === 4 &&
          face.center.x < 11
      );
      expect(neckFaces).toHaveLength(1);
      const deviation = measureRuledEdgeSweepDeviation(
        kernel,
        neckFaces[0]!.face,
        { edgeDeflection: 0.005, faceDeflection: 0.005, samplesPerRail: 65 }
      );
      expect(deviation.candidateToWitness.maximum).toBeGreaterThan(0.38);
      expect(deviation.candidateToWitness.maximum).toBeLessThan(0.4);
      expect(deviation.witnessToCandidate.maximum).toBeGreaterThan(1.9);
      expect(deviation.witnessToCandidate.maximum).toBeLessThan(1.93);
      expect(deviation.witnessToCandidate.rms).toBeGreaterThan(0.57);
      expect(deviation.witnessToCandidate.rms).toBeLessThan(0.59);
    },
    60_000
  );
});
