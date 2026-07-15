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
    // Corner at the origin, matching OCCT — not centred on it.
    expect(bounds.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(bounds.max).toEqual({ x: 10, y: 20, z: 30 });
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
    expect(bounds.min).toEqual({ x: 5, y: 6, z: 7 });
    expect(bounds.max).toEqual({ x: 7, y: 8, z: 9 });
    expect(solidVolume(moved)).toBeCloseTo(8, 6);
  });

  it('rotates 90 degrees about Z, about the world origin', () => {
    const rotated = transformSolid(makeBox(10, 2, 2), {
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    });
    const bounds = solidBounds(rotated);
    // The box spans x 0..10, so rotating about the origin sweeps it onto +Y.
    expect(bounds.max.y).toBeCloseTo(10, 6);
    expect(bounds.max.x).toBeCloseTo(0, 6);
    expect(bounds.min.x).toBeCloseTo(-2, 6);
    expect(solidVolume(rotated)).toBeCloseTo(40, 6);
  });

  it('applies rotations in the exact kernel order (X, then Y, then Z)', () => {
    // Under the previous XYZ order this landed on a different axis entirely,
    // so the preview disagreed with the applied model.
    const rotated = transformSolid(makeBox(10, 2, 2), {
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 90, z: 90 }
    });
    const bounds = solidBounds(rotated);
    // Ry(90) sends +X to -Z; Rz(90) leaves -Z alone.
    expect(bounds.min.z).toBeCloseTo(-10, 6);
    expect(bounds.max.z).toBeCloseTo(0, 6);
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
    // The plate's corner is on the origin and the drill runs along +Z, so
    // centre the drill in XY and start it below the face it enters. Radius 3
    // keeps the hole strictly inside the plate's 10 of Y: a radius of 5 would
    // sit tangent to both side faces, which is a degenerate cut.
    const drill = transformSolid(makeCylinder(3, 40), {
      translation: { x: 15, y: 5, z: -5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    const result = booleanSolids('subtract', plate, drill);
    expectClosed(result);
    // The hole runs the full 30 of the plate's Z thickness.
    const plugVolume = solidVolume(makeCylinder(3, 30));
    expect(solidVolume(result)).toBeCloseTo(9000 - plugVolume, 1);
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
