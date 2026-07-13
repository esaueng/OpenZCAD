import { describe, expect, it } from 'vitest';
import {
  PLANE_BASES,
  booleanSolids,
  circleProfile,
  extrudeProfile,
  makeBox,
  makeCone,
  makeCylinder,
  makeSphere,
  makeTorus,
  polygonProfile,
  rectangleProfile,
  revolveProfile,
  solidBounds,
  solidVolume,
  transformSolid,
  triangulateSolid,
  validateSolid,
  type Solid
} from '@openzcad/geometry';

function expectClosed(solid: Solid): void {
  const validation = validateSolid(solid);
  expect(validation.openEdgeCount).toBe(0);
  expect(validation.nonManifoldEdgeCount).toBe(0);
  expect(validation.closed).toBe(true);
}

describe('primitive solids', () => {
  it('builds an exact box', () => {
    const box = makeBox(10, 20, 30);
    expectClosed(box);
    expect(box.faces).toHaveLength(6);
    expect(box.vertices).toHaveLength(8);
    expect(solidVolume(box)).toBeCloseTo(6000, 6);
    const bounds = solidBounds(box);
    expect(bounds.min).toEqual({ x: -5, y: -10, z: -15 });
    expect(bounds.max).toEqual({ x: 5, y: 10, z: 15 });
  });

  it('builds a watertight cylinder within 1% of the analytic volume', () => {
    const cylinder = makeCylinder(10, 20);
    expectClosed(cylinder);
    const analytic = Math.PI * 100 * 20;
    expect(solidVolume(cylinder)).toBeGreaterThan(analytic * 0.99);
    expect(solidVolume(cylinder)).toBeLessThan(analytic);
  });

  it('builds cones, including pointed ones', () => {
    const frustum = makeCone(10, 5, 12);
    expectClosed(frustum);
    const pointed = makeCone(10, 0, 12);
    expectClosed(pointed);
    const analyticPointed = (Math.PI * 100 * 12) / 3;
    expect(solidVolume(pointed)).toBeGreaterThan(analyticPointed * 0.98);
    expect(solidVolume(pointed)).toBeLessThan(analyticPointed);
  });

  it('builds a watertight sphere within 3% of the analytic volume', () => {
    const sphere = makeSphere(10);
    expectClosed(sphere);
    const analytic = (4 / 3) * Math.PI * 1000;
    expect(solidVolume(sphere)).toBeGreaterThan(analytic * 0.97);
    expect(solidVolume(sphere)).toBeLessThan(analytic);
  });

  it('builds a watertight torus', () => {
    const torus = makeTorus(20, 5);
    expectClosed(torus);
    const analytic = 2 * Math.PI * Math.PI * 20 * 25;
    expect(solidVolume(torus)).toBeGreaterThan(analytic * 0.95);
    expect(solidVolume(torus)).toBeLessThan(analytic);
  });

  it('rejects nonsense dimensions', () => {
    expect(() => makeBox(0, 1, 1)).toThrow(/positive/);
    expect(() => makeTorus(5, 9)).toThrow(/smaller/);
  });
});

describe('profile sweeps', () => {
  it('extrudes a rectangle into an exact prism on every plane', () => {
    for (const plane of ['XY', 'XZ', 'YZ'] as const) {
      const solid = extrudeProfile(rectangleProfile(20, 10), PLANE_BASES[plane], 5);
      expectClosed(solid);
      expect(solidVolume(solid)).toBeCloseTo(1000, 6);
    }
  });

  it('respects sketch offsets and negative distances', () => {
    const up = extrudeProfile(rectangleProfile(4, 4), PLANE_BASES.XZ, 6, 10);
    const bounds = solidBounds(up);
    expect(bounds.min.y).toBeCloseTo(10, 6);
    expect(bounds.max.y).toBeCloseTo(16, 6);

    const down = extrudeProfile(rectangleProfile(4, 4), PLANE_BASES.XZ, -6, 10);
    const downBounds = solidBounds(down);
    expect(downBounds.min.y).toBeCloseTo(4, 6);
    expect(downBounds.max.y).toBeCloseTo(10, 6);
    expect(solidVolume(down)).toBeCloseTo(96, 6);
  });

  it('extrudes circles and polygons', () => {
    const disc = extrudeProfile(circleProfile(10), PLANE_BASES.XZ, 8);
    expectClosed(disc);
    expect(solidVolume(disc)).toBeGreaterThan(Math.PI * 100 * 8 * 0.99);

    const hex = extrudeProfile(polygonProfile(6, 10), PLANE_BASES.XY, 8);
    expectClosed(hex);
    const hexArea = ((3 * Math.sqrt(3)) / 2) * 100;
    expect(solidVolume(hex)).toBeCloseTo(hexArea * 8, 4);
  });

  it('revolves an offset rectangle into a watertight ring', () => {
    // Rectangle spanning u in [5, 15], v in [-10, 10], revolved about the v axis.
    const profile = rectangleProfile(10, 20, 10, 0);
    const ring = revolveProfile(profile, PLANE_BASES.XZ, 'vertical');
    expectClosed(ring);
    const analytic = Math.PI * (15 * 15 - 5 * 5) * 20;
    expect(solidVolume(ring)).toBeGreaterThan(analytic * 0.98);
    expect(solidVolume(ring)).toBeLessThan(analytic);
  });

  it('refuses to revolve a profile crossing the axis', () => {
    const profile = rectangleProfile(10, 20, 0, 0);
    expect(() => revolveProfile(profile, PLANE_BASES.XY, 'vertical')).toThrow(/axis/);
  });
});

describe('transforms', () => {
  it('translates vertices in place', () => {
    const moved = transformSolid(makeBox(2, 2, 2), {
      translation: { x: 5, y: 6, z: 7 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    const bounds = solidBounds(moved);
    expect(bounds.min).toEqual({ x: 4, y: 5, z: 6 });
    expect(bounds.max).toEqual({ x: 6, y: 7, z: 8 });
    expect(solidVolume(moved)).toBeCloseTo(8, 6);
  });

  it('rotates 90 degrees about Z like three.js Euler XYZ', () => {
    const rotated = transformSolid(makeBox(10, 2, 2), {
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    });
    const bounds = solidBounds(rotated);
    // x extent becomes y extent: (1,0,0) -> (0,1,0).
    expect(bounds.max.y).toBeCloseTo(5, 6);
    expect(bounds.max.x).toBeCloseTo(1, 6);
    expect(solidVolume(rotated)).toBeCloseTo(40, 6);
  });
});

describe('booleans', () => {
  const boxA = () => makeBox(10, 10, 10);
  const boxB = () =>
    transformSolid(makeBox(10, 10, 10), {
      translation: { x: 5, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    });

  it('unions overlapping boxes with the exact combined volume', () => {
    const union = booleanSolids('union', boxA(), boxB());
    expectClosed(union);
    expect(solidVolume(union)).toBeCloseTo(1500, 4);
  });

  it('subtracts with the exact remaining volume', () => {
    const cut = booleanSolids('subtract', boxA(), boxB());
    expectClosed(cut);
    expect(solidVolume(cut)).toBeCloseTo(500, 4);
  });

  it('intersects with the exact common volume', () => {
    const common = booleanSolids('intersect', boxA(), boxB());
    expectClosed(common);
    expect(solidVolume(common)).toBeCloseTo(500, 4);
  });

  it('drills a cylinder through a box and stays watertight', () => {
    const plate = makeBox(30, 10, 30);
    const drill = makeCylinder(5, 40);
    const result = booleanSolids('subtract', plate, drill);
    expectClosed(result);
    const cylinderVolume = solidVolume(makeCylinder(5, 10));
    expect(solidVolume(result)).toBeCloseTo(9000 - cylinderVolume, 1);
  });

  it('returns an empty solid for disjoint intersection', () => {
    const far = transformSolid(makeBox(4, 4, 4), {
      translation: { x: 100, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    const result = booleanSolids('intersect', boxA(), far);
    expect(result.faces).toHaveLength(0);
  });
});

describe('triangulation', () => {
  it('produces a flat-shaded triangle mesh covering every face', () => {
    const box = makeBox(2, 2, 2);
    const mesh = triangulateSolid(box);
    expect(mesh.indices.length).toBe(6 * 2 * 3);
    expect(mesh.vertices.length).toBe(6 * 4 * 3);
  });
});
