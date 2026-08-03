import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel, type ShapeHandle } from 'occt-wasm';

import {
  mirrorOcctSolid,
  offsetOcctSolid,
  resizeOcctAnalyticCylinder,
  shellOcctSolid,
  validateOcctSolid
} from './occt-modeling-operations';

interface MeasuredCylinder {
  face: ShapeHandle;
  radius: number;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
}

function measuredCylinders(
  kernel: OcctKernel,
  owner: ShapeHandle
): MeasuredCylinder[] {
  return kernel
    .getSubShapes(owner, 'face')
    .flatMap((face): MeasuredCylinder[] => {
      if (kernel.surfaceType(face) !== 'cylinder') {
        return [];
      }
      const cylinder = kernel.getFaceCylinderData(face);
      const bounds = kernel.uvBounds(face);
      if (
        !cylinder ||
        Math.abs(bounds.uMax - bounds.uMin) < Math.PI * 2 - 1e-5
      ) {
        return [];
      }
      const opposite = bounds.uMin + Math.PI;
      const axisPoint = (v: number) => {
        const left = kernel.pointOnSurface(face, bounds.uMin, v);
        const right = kernel.pointOnSurface(face, opposite, v);
        return {
          x: (left.x + right.x) / 2,
          y: (left.y + right.y) / 2,
          z: (left.z + right.z) / 2
        };
      };
      return [
        {
          face,
          radius: cylinder.radius,
          start: axisPoint(bounds.vMin),
          end: axisPoint(bounds.vMax)
        }
      ];
    });
}

describe('OCCT modeling operations', () => {
  let kernel: OcctKernel;

  beforeAll(async () => {
    kernel = await OcctKernel.init();
  });

  afterAll(() => {
    kernel[Symbol.dispose]();
  });

  it('mirrors a valid solid across a finite normalized plane', () => {
    const source = kernel.makeBox(10, 20, 30);
    const mirrored = mirrorOcctSolid(kernel, source, {
      planePoint: { x: 15, y: 0, z: 0 },
      planeNormal: { x: 2, y: 0, z: 0 }
    });
    const bounds = validateOcctSolid(kernel, mirrored, 'test mirror').bounds;

    expect(bounds.xmin).toBeCloseTo(20, 8);
    expect(bounds.xmax).toBeCloseTo(30, 8);
    expect(kernel.getVolume(mirrored)).toBeCloseTo(6000, 6);
    expect(() =>
      mirrorOcctSolid(kernel, source, {
        planePoint: { x: 0, y: 0, z: 0 },
        planeNormal: { x: 0, y: 0, z: 0 }
      })
    ).toThrow('non-zero');
  });

  it('shells one unique opening face and rejects bad thickness or selection', () => {
    const source = kernel.makeBox(10, 20, 30);
    const top = kernel
      .getSubShapes(source, 'face')
      .find((face) => kernel.getSurfaceCenterOfMass(face).z > 29)!;
    const shelled = shellOcctSolid(kernel, source, {
      openingFaces: [top],
      thickness: 2
    });

    expect(
      validateOcctSolid(kernel, shelled, 'test shell').volume
    ).toBeLessThan(6000);
    expect(() =>
      shellOcctSolid(kernel, source, {
        openingFaces: [top, top],
        thickness: 2
      })
    ).toThrow('uniquely');
    expect(() =>
      shellOcctSolid(kernel, source, { openingFaces: [top], thickness: 5 })
    ).toThrow('local feature size');
  });

  it('applies only positive outward uniform offsets', () => {
    const source = kernel.makeBox(10, 20, 30);
    const offset = offsetOcctSolid(kernel, source, { distance: 2 });
    const result = validateOcctSolid(kernel, offset, 'test offset');

    expect(result.volume).toBeCloseTo(14 * 24 * 34, 6);
    expect(kernel.getSubShapes(offset, 'face')).toHaveLength(6);
    expect(result.bounds.xmin).toBeLessThan(0);
    expect(result.bounds.xmax).toBeGreaterThan(10);
    expect(() => offsetOcctSolid(kernel, source, { distance: 0 })).toThrow(
      'greater than zero'
    );
    expect(() => offsetOcctSolid(kernel, source, { distance: 10 })).toThrow(
      'local feature size'
    );
    expect(() =>
      offsetOcctSolid(kernel, kernel.makeCylinder(5, 10), { distance: 1 })
    ).toThrow('sharp intersection-join parity');
  });

  it('resizes transformed bosses and proven through and blind holes analytically', () => {
    const localBoss = kernel.makeCylinder(4, 12);
    const boss = kernel.transform(
      localBoss,
      [0, 0, 1, 31, 1, 0, 0, -7, 0, 1, 0, 19]
    );
    const bossWall = measuredCylinders(kernel, boss)[0]!;
    const grownBoss = resizeOcctAnalyticCylinder(kernel, boss, bossWall.face, {
      sourceRadius: bossWall.radius,
      sourceAxisStart: bossWall.start,
      sourceAxisEnd: bossWall.end,
      concavity: 'boss',
      radius: 6
    });
    const grownWalls = measuredCylinders(kernel, grownBoss);
    expect(grownWalls).toHaveLength(1);
    expect(grownWalls[0]?.radius).toBeCloseTo(6, 6);

    for (const blind of [false, true]) {
      const block = kernel.makeBox(20, 20, 10);
      const cutter = kernel.translate(
        kernel.makeCylinder(3, blind ? 6 : 12),
        10,
        10,
        blind ? 5 : -1
      );
      const drilled = kernel.unifySameDomain(kernel.cut(block, cutter));
      const hole = measuredCylinders(kernel, drilled).find(
        ({ face }) => kernel.shapeOrientation(face) === 'reversed'
      )!;
      const resized = resizeOcctAnalyticCylinder(kernel, drilled, hole.face, {
        sourceRadius: hole.radius,
        sourceAxisStart: hole.start,
        sourceAxisEnd: hole.end,
        concavity: 'hole',
        radius: 4
      });
      const result = measuredCylinders(kernel, resized).filter(
        ({ radius }) => Math.abs(radius - 4) < 1e-6
      );
      expect(result).toHaveLength(1);
      expect(
        validateOcctSolid(kernel, resized, 'test hole').volume
      ).toBeGreaterThan(0);
    }

    expect(() =>
      resizeOcctAnalyticCylinder(kernel, boss, bossWall.face, {
        sourceRadius: bossWall.radius,
        sourceAxisStart: bossWall.start,
        sourceAxisEnd: bossWall.end,
        concavity: 'hole',
        radius: 5
      })
    ).toThrow('concavity');
  });
});
