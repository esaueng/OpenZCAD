import { BrepKernel } from 'brepkit-wasm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBrepKitModelingOperations } from './brepkit-modeling-operations';

const DEFLECTION = 0.001;

interface SolidReading {
  readonly bounds: number[];
  readonly faces: number[];
  readonly volume: number;
  readonly validationErrors: number;
}

function readSolid(kernel: BrepKernel, solid: number): SolidReading {
  return {
    bounds: Array.from(kernel.boundingBox(solid)),
    faces: Array.from(kernel.getSolidFaces(solid)),
    volume: kernel.volume(solid, DEFLECTION),
    validationErrors: kernel.validateSolid(solid)
  };
}

function topFace(kernel: BrepKernel, solid: number): number {
  const matches = Array.from(kernel.getSolidFaces(solid)).filter((face) => {
    const normal = Array.from(kernel.getFaceNormal(face));
    return (
      Math.abs(normal[0] ?? 0) < 1e-12 &&
      Math.abs(normal[1] ?? 0) < 1e-12 &&
      Math.abs((normal[2] ?? 0) - 1) < 1e-12
    );
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one top face and found ${matches.length}.`);
  }
  return matches[0]!;
}

function sortedVertexPositions(kernel: BrepKernel, solid: number): number[][] {
  return Array.from(kernel.getSolidVertices(solid), (vertex) =>
    Array.from(kernel.getVertexPosition(vertex), (coordinate) =>
      Number(coordinate.toFixed(9))
    )
  ).sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = left[index]! - right[index]!;
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  });
}

describe('BrepKit modeling operations', () => {
  let kernel: BrepKernel;

  beforeEach(() => {
    kernel = new BrepKernel();
  });

  afterEach(() => {
    kernel.free();
  });

  it('mirrors a box across a translated, rotated plane without changing the input', () => {
    const source = kernel.makeBox(10, 20, 30);
    const before = readSolid(kernel, source);
    const operations = createBrepKitModelingOperations(kernel);
    const inverseSqrtTwo = 1 / Math.sqrt(2);

    const mirrored = operations.mirror({
      targetSolid: source,
      planePoint: { x: 20, y: 10, z: 5 },
      planeNormal: { x: inverseSqrtTwo, y: inverseSqrtTwo, z: 0 }
    });

    expect(mirrored).not.toBe(source);
    expect(readSolid(kernel, source)).toEqual(before);
    const mirroredReading = readSolid(kernel, mirrored);
    expect(mirroredReading.validationErrors).toBe(0);
    expect(mirroredReading.volume).toBeCloseTo(6000, 8);
    mirroredReading.bounds.forEach((coordinate, index) => {
      expect(coordinate).toBeCloseTo([10, 20, 0, 30, 30, 30][index]!, 8);
    });
    expect(sortedVertexPositions(kernel, mirrored)).toEqual([
      [10, 20, 0],
      [10, 20, 30],
      [10, 30, 0],
      [10, 30, 30],
      [30, 20, 0],
      [30, 20, 30],
      [30, 30, 0],
      [30, 30, 30]
    ]);
  });

  it('shells a box through a unique opening face without changing the input', () => {
    const source = kernel.makeBox(10, 20, 30);
    const before = readSolid(kernel, source);
    const operations = createBrepKitModelingOperations(kernel);

    const shelled = operations.shell({
      targetSolid: source,
      thickness: 1,
      openingFaces: [topFace(kernel, source)]
    });

    const output = readSolid(kernel, shelled);
    expect(readSolid(kernel, source)).toEqual(before);
    expect(output.validationErrors).toBe(0);
    expect(output.bounds).toEqual(before.bounds);
    expect(output.faces.length).toBeGreaterThan(before.faces.length);
    expect(output.volume).toBeGreaterThan(0);
    expect(output.volume).toBeLessThan(before.volume);
  });

  it('offsets a box outward with offsetSolidV2 without changing the input', () => {
    const source = kernel.makeBox(10, 20, 30);
    const before = readSolid(kernel, source);
    const operations = createBrepKitModelingOperations(kernel);

    const offset = operations.offsetSolid({ targetSolid: source, distance: 1 });

    expect(readSolid(kernel, source)).toEqual(before);
    const offsetReading = readSolid(kernel, offset);
    expect(offsetReading.validationErrors).toBe(0);
    expect(offsetReading.volume).toBeCloseTo(8448, 8);
    offsetReading.bounds.forEach((coordinate, index) => {
      expect(coordinate).toBeCloseTo([-1, -1, -1, 11, 21, 31][index]!, 8);
    });
  });

  it('rejects invalid mirror planes and zero or non-finite distances', () => {
    const source = kernel.makeBox(10, 20, 30);
    const operations = createBrepKitModelingOperations(kernel);
    const point = { x: 0, y: 0, z: 0 };

    expect(() =>
      operations.mirror({
        targetSolid: source,
        planePoint: point,
        planeNormal: { x: 0, y: 0, z: 0 }
      })
    ).toThrow(/normalized/);
    expect(() =>
      operations.mirror({
        targetSolid: source,
        planePoint: { x: Number.NaN, y: 0, z: 0 },
        planeNormal: { x: 1, y: 0, z: 0 }
      })
    ).toThrow(/finite coordinates/);
    expect(() =>
      operations.mirror({
        targetSolid: source,
        planePoint: point,
        planeNormal: { x: 2, y: 0, z: 0 }
      })
    ).toThrow(/normalized/);
    for (const thickness of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        operations.shell({
          targetSolid: source,
          thickness,
          openingFaces: [topFace(kernel, source)]
        })
      ).toThrow(/finite and positive/);
    }
    for (const distance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        operations.offsetSolid({ targetSolid: source, distance })
      ).toThrow(/finite and positive/);
    }
  });

  it('rejects empty, duplicate, foreign, and invalid opening face handles', () => {
    const source = kernel.makeBox(10, 20, 30);
    const other = kernel.makeBox(4, 4, 4);
    const opening = topFace(kernel, source);
    const foreign = topFace(kernel, other);
    const operations = createBrepKitModelingOperations(kernel);

    expect(() =>
      operations.shell({ targetSolid: source, thickness: 1, openingFaces: [] })
    ).toThrow(/at least one/);
    expect(() =>
      operations.shell({
        targetSolid: source,
        thickness: 1,
        openingFaces: [opening, opening]
      })
    ).toThrow(/unique/);
    expect(() =>
      operations.shell({
        targetSolid: source,
        thickness: 1,
        openingFaces: [foreign]
      })
    ).toThrow(/does not belong/);
    expect(() =>
      operations.shell({
        targetSolid: source,
        thickness: 1,
        openingFaces: [Number.NaN]
      })
    ).toThrow(/safe integer/);
  });

  it('refuses oversized walls and offsets before calling the kernel', () => {
    const source = kernel.makeBox(10, 20, 30);
    const before = readSolid(kernel, source);
    const operations = createBrepKitModelingOperations(kernel);

    expect(() =>
      operations.shell({
        targetSolid: source,
        thickness: 5,
        openingFaces: [topFace(kernel, source)]
      })
    ).toThrow(/oversized/);
    expect(() =>
      operations.offsetSolid({ targetSolid: source, distance: 5 })
    ).toThrow(/oversized/);
    expect(readSolid(kernel, source)).toEqual(before);
  });

  it('refuses a non-manifold concave offset and leaves its input unchanged', () => {
    const horizontal = kernel.makeBox(20, 5, 10);
    const vertical = kernel.makeBox(5, 20, 10);
    const source = kernel.fuse(horizontal, vertical);
    const before = readSolid(kernel, source);
    const operations = createBrepKitModelingOperations(kernel);

    expect(() =>
      operations.offsetSolid({ targetSolid: source, distance: 0.5 })
    ).toThrow(/BrepKit solid offset refused/);
    expect(readSolid(kernel, source)).toEqual(before);
  });
});
