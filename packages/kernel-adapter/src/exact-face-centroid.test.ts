import { describe, expect, it } from 'vitest';

import { RemusKernel } from './remus-runtime';
import { faceVertexCentroid } from './exact-brep';
import { planarFaceCentroid } from './exact-face-centroid';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Every planar face of a solid, with the normal the measurement needs. */
function planarFaces(
  kernel: RemusKernel,
  solid: number
): Array<{ face: number; normal: Vec3 }> {
  return Array.from(kernel.getSolidFaces(solid)).flatMap((face) => {
    if (kernel.getSurfaceType(face) !== 'plane') {
      return [];
    }
    const raw = kernel.getFaceNormal(face);
    return [{ face, normal: { x: raw[0]!, y: raw[1]!, z: raw[2]! } }];
  });
}

function measure(kernel: RemusKernel, solid: number, pick: (face: Vec3) => boolean) {
  const match = planarFaces(kernel, solid).find(({ face }) => {
    const centre = faceVertexCentroid(kernel, face);
    return centre !== null && pick(centre);
  });
  if (!match) {
    throw new Error('No planar face matched the test predicate.');
  }
  return {
    measured: planarFaceCentroid(kernel, match.face, match.normal),
    vertexMean: faceVertexCentroid(kernel, match.face)!
  };
}

function expectClose(actual: Vec3, expected: Vec3, tolerance = 1e-9): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThan(tolerance);
  expect(Math.abs(actual.z - expected.z)).toBeLessThan(tolerance);
}

/** Row-major rigid translation, matching `copyAndTransformSolid`. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

describe('planarFaceCentroid', () => {
  it('puts a disc bounded by one circular edge on its axis, not its rim', () => {
    const kernel = new RemusKernel();
    const { measured, vertexMean } = measure(
      kernel,
      kernel.makeCylinder(10, 18),
      (centre) => centre.z === 18
    );
    // The single seam vertex IS the whole vertex mean, one radius out.
    expectClose(vertexMean, { x: 10, y: 0, z: 18 });
    expectClose(measured!.centroid, { x: 0, y: 0, z: 18 }, 1e-12);
    expect(measured!.provenance).toBe('sampled');
  });

  it('leaves a rectangular face where the vertex mean already had it', () => {
    const kernel = new RemusKernel();
    const { measured, vertexMean } = measure(
      kernel,
      kernel.makeBox(20, 20, 18),
      (centre) => centre.z === 18
    );
    expectClose(vertexMean, { x: 10, y: 10, z: 18 });
    expectClose(measured!.centroid, { x: 10, y: 10, z: 18 });
    // A straight boundary integrates exactly; nothing is inscribed.
    expect(measured!.provenance).toBe('exact');
  });

  it('weighs an L-shaped face by area rather than by vertex count', () => {
    const kernel = new RemusKernel();
    const solid = kernel.cut(
      kernel.makeBox(20, 20, 5),
      kernel.copyAndTransformSolid(
        kernel.makeBox(10, 10, 20),
        translation(10, 10, -5)
      )
    );
    const { measured, vertexMean } = measure(
      kernel,
      solid,
      (centre) => centre.z === 5
    );
    // Six corners average to the middle of the square the L was cut from.
    expectClose(vertexMean, { x: 10, y: 10, z: 5 });
    // (400·10 − 100·15) / 300 on both axes.
    expectClose(measured!.centroid, { x: 25 / 3, y: 25 / 3, z: 5 });
    expect(measured!.provenance).toBe('exact');
  });

  it('subtracts a hole the same way from both ends of a drilled block', () => {
    const kernel = new RemusKernel();
    const solid = kernel.cut(
      kernel.makeBox(20, 20, 10),
      kernel.copyAndTransformSolid(
        kernel.makeCylinder(3, 40),
        translation(5, 5, -10)
      )
    );
    // (400·10 − 9π·5) / (400 − 9π), the same on both faces. The tolerance is
    // the inscribed polygon's residual against that closed form — measured at
    // 3.4e-5 mm on a 20 mm face, four orders below any modelling tolerance.
    const expected = (400 * 10 - Math.PI * 9 * 5) / (400 - Math.PI * 9);
    const top = measure(kernel, solid, (centre) => centre.z === 10);
    const bottom = measure(kernel, solid, (centre) => centre.z === 0);
    expectClose(top.measured!.centroid, { x: expected, y: expected, z: 10 }, 1e-4);
    expectClose(bottom.measured!.centroid, { x: expected, y: expected, z: 0 }, 1e-4);
    // A hole wire has no orientation flag to read, and the two ends chain it
    // in opposite directions; an unsigned sum put these on opposite sides.
    expect(top.measured!.centroid.x).toBeCloseTo(
      bottom.measured!.centroid.x,
      9
    );
  });

  it('does not depend on which in-plane axes a caller would pick', () => {
    const kernel = new RemusKernel();
    const solid = kernel.makeCylinder(7, 4);
    const cap = planarFaces(kernel, solid).find(({ normal }) => normal.z > 0)!;
    const upright = planarFaceCentroid(kernel, cap.face, cap.normal)!;
    // The opposite normal names the same plane and must name the same point.
    const flipped = planarFaceCentroid(kernel, cap.face, {
      x: -cap.normal.x,
      y: -cap.normal.y,
      z: -cap.normal.z
    })!;
    expectClose(upright.centroid, flipped.centroid, 1e-12);
  });

  it('reports nothing rather than a guess for a degenerate normal', () => {
    const kernel = new RemusKernel();
    const cap = planarFaces(kernel, kernel.makeCylinder(5, 5))[0]!;
    expect(planarFaceCentroid(kernel, cap.face, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
