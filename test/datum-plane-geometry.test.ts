import { describe, expect, it } from 'vitest';
import {
  canonicalPlaneBasis,
  midDatumPlane,
  offsetDatumPlane,
  parallelDatumPlane,
  threePointDatumPlane,
  type PlaneBasis
} from '@openzcad/geometry';

/**
 * R01 plane construction against closed-form expectations: offsets along the
 * source normal, midplanes halfway between parallel carriers with A's frame
 * kept, refusals for nonparallel and coincident sources, and right-handed
 * frames after a normal flip.
 */

const xy = canonicalPlaneBasis('XY');
const handed = (frame: PlaneBasis) => {
  const { u, v, normal: n } = frame;
  const c = {
    x: u.y * v.z - u.z * v.y,
    y: u.z * v.x - u.x * v.z,
    z: u.x * v.y - u.y * v.x
  };
  return c.x * n.x + c.y * n.y + c.z * n.z;
};
const at = (z: number, flip = false): PlaneBasis => ({
  origin: { x: 0, y: 0, z },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: flip ? -1 : 1, z: 0 },
  normal: { x: 0, y: 0, z: flip ? -1 : 1 }
});

describe('offset datum plane', () => {
  it.each([
    [10, 10],
    [0, 0],
    [-4, -4],
    [12, 12],
    [-5, -5]
  ])('offsets XY by %d to z = %d', (offset, z) => {
    const plane = offsetDatumPlane(xy, offset);
    expect(plane.origin.z).toBeCloseTo(z, 12);
    expect(plane.normal).toEqual(xy.normal);
    expect(plane.u).toEqual(xy.u);
  });

  it('flips the result normal without moving it, staying right-handed', () => {
    const plane = offsetDatumPlane(xy, 7, true);
    expect(plane.origin.z).toBeCloseTo(7, 12);
    expect(plane.normal.z).toBe(-1);
    expect(handed(plane)).toBeCloseTo(1, 12);
  });

  it('refuses a non-finite offset', () => {
    expect(() => offsetDatumPlane(xy, Number.NaN)).toThrow(/finite/);
  });
});

describe('midplane', () => {
  it('lands halfway between z = 0 and z = 20, keeping the first frame', () => {
    const plane = midDatumPlane(at(0), at(20));
    expect(plane.origin).toEqual({ x: 0, y: 0, z: 10 });
    expect(plane.normal).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('accepts opposing normals and either order', () => {
    expect(midDatumPlane(at(0), at(20, true)).origin.z).toBeCloseTo(10, 12);
    const reversed = midDatumPlane(at(20, true), at(0));
    expect(reversed.origin.z).toBeCloseTo(10, 12);
    // The first source's frame decides orientation.
    expect(reversed.normal.z).toBe(-1);
  });

  it('keeps the first origin in-plane when the second slides along itself', () => {
    const slid = { ...at(20), origin: { x: 37, y: -9, z: 20 } };
    expect(midDatumPlane(at(0), slid).origin).toEqual({ x: 0, y: 0, z: 10 });
  });

  it('finds the oblique midplane of two parallel tilted planes', () => {
    const s = Math.SQRT1_2;
    const tilted = (k: number): PlaneBasis => ({
      origin: { x: k * s, y: 0, z: k * s },
      u: { x: s, y: 0, z: -s },
      v: { x: 0, y: 1, z: 0 },
      normal: { x: s, y: 0, z: s }
    });
    const plane = midDatumPlane(tilted(2), tilted(8));
    expect(plane.origin.x).toBeCloseTo(5 * s, 12);
    expect(plane.origin.z).toBeCloseTo(5 * s, 12);
  });

  it('refuses nonparallel and coincident sources', () => {
    const tilted: PlaneBasis = {
      origin: { x: 0, y: 0, z: 20 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 0.6, z: 0.8 },
      normal: { x: 0, y: -0.8, z: 0.6 }
    };
    expect(() => midDatumPlane(at(0), tilted)).toThrow(/not parallel/);
    expect(() => midDatumPlane(at(5), at(5, true))).toThrow(/coincide/);
    // Just inside and just outside the coincidence tolerance (1e-6 here).
    expect(() => midDatumPlane(at(0), at(5e-7))).toThrow(/coincide/);
    expect(midDatumPlane(at(0), at(2e-6)).origin.z).toBeCloseTo(1e-6, 12);
  });
});

const p = (x: number, y: number, z: number) => ({ x, y, z });
/** Signed distance of `point` from `plane` along its normal. */
const height = (
  plane: PlaneBasis,
  point: { x: number; y: number; z: number }
) =>
  (point.x - plane.origin.x) * plane.normal.x +
  (point.y - plane.origin.y) * plane.normal.y +
  (point.z - plane.origin.z) * plane.normal.z;

describe('three-point datum plane', () => {
  it('puts three points at z = 0 on the plane z = 0 with a +Z normal', () => {
    const plane = threePointDatumPlane(p(0, 0, 0), p(10, 0, 0), p(0, 10, 0));
    expect(plane.origin).toEqual(p(0, 0, 0));
    expect(plane.normal).toEqual(p(0, 0, 1));
    expect(plane.u).toEqual(p(1, 0, 0));
    expect(plane.v).toEqual(p(0, 1, 0));
    expect(height(plane, p(37, -9, 0))).toBe(0);
    expect(handed(plane)).toBeCloseTo(1, 12);
  });

  it('follows the right-hand rule: clockwise points give -Z', () => {
    const plane = threePointDatumPlane(p(0, 0, 5), p(0, 10, 5), p(10, 0, 5));
    expect(plane.normal).toEqual(p(0, 0, -1));
    expect(plane.origin.z).toBe(5);
    expect(handed(plane)).toBeCloseTo(1, 12);
  });

  it('passes through all three points of an oblique triple', () => {
    const points = [p(1, 2, 3), p(7, -4, 9), p(-2, 5, 11)] as const;
    const plane = threePointDatumPlane(...points);
    for (const point of points) expect(height(plane, point)).toBeCloseTo(0, 12);
    expect(handed(plane)).toBeCloseTo(1, 12);
  });

  it('is the plane x + y + z = 1 through the unit intercepts', () => {
    const plane = threePointDatumPlane(p(1, 0, 0), p(0, 1, 0), p(0, 0, 1));
    const s = 1 / Math.sqrt(3);
    expect(plane.normal.x).toBeCloseTo(s, 12);
    expect(plane.normal.y).toBeCloseTo(s, 12);
    expect(plane.normal.z).toBeCloseTo(s, 12);
    expect(height(plane, p(0, 0, 0))).toBeCloseTo(-s, 12);
  });

  it('flips the normal without moving the plane', () => {
    const plane = threePointDatumPlane(
      p(0, 0, 0),
      p(10, 0, 0),
      p(0, 10, 0),
      true
    );
    expect(plane.normal.z).toBe(-1);
    expect(Math.hypot(plane.normal.x, plane.normal.y)).toBe(0);
    expect(plane.origin).toEqual(p(0, 0, 0));
    expect(handed(plane)).toBeCloseTo(1, 12);
  });

  it.each([
    ['in a line', p(0, 0, 0), p(5, 5, 5), p(10, 10, 10)],
    ['in a line, third behind the first', p(0, 0, 0), p(4, 0, 0), p(-3, 0, 0)],
    ['within the tolerance of a line', p(0, 0, 0), p(10, 0, 0), p(5, 1e-7, 0)]
  ])('refuses points %s as collinear', (_name, a, b, c) => {
    expect(() => threePointDatumPlane(a, b, c)).toThrow(/collinear/);
  });

  it('refuses coincident points, naming which', () => {
    expect(() =>
      threePointDatumPlane(p(1, 1, 1), p(1, 1, 1), p(0, 5, 0))
    ).toThrow(/first and second coincide/);
    expect(() =>
      threePointDatumPlane(p(0, 0, 0), p(3, 0, 0), p(3, 0, 0))
    ).toThrow(/second and third coincide/);
  });

  it('refuses a non-finite point', () => {
    expect(() =>
      threePointDatumPlane(p(0, 0, 0), p(Number.NaN, 0, 0), p(0, 1, 0))
    ).toThrow(/second point is not a finite/);
  });
});

describe('parallel-at-point datum plane', () => {
  it('moves XY up to a point at z = 7, keeping its axes', () => {
    const plane = parallelDatumPlane(xy, p(3, -2, 7));
    expect(plane.origin).toEqual(p(3, -2, 7));
    expect(plane.normal).toEqual(xy.normal);
    expect(plane.u).toEqual(xy.u);
    expect(height(plane, p(-50, 80, 7))).toBe(0);
  });

  it('gives the source itself for a point on it', () => {
    const plane = parallelDatumPlane(at(4), p(9, 9, 4));
    expect(height(plane, at(4).origin)).toBe(0);
    expect(plane.normal).toEqual(at(4).normal);
  });

  it('copies a tilted source through a point', () => {
    const s = Math.SQRT1_2;
    const tilted: PlaneBasis = {
      origin: p(0, 0, 0),
      u: p(1, 0, 0),
      v: p(0, s, s),
      normal: p(0, -s, s)
    };
    const plane = parallelDatumPlane(tilted, p(0, 0, 10));
    // Distance from the source along its normal: 10·sin 45°.
    expect(height(tilted, plane.origin)).toBeCloseTo(10 * s, 12);
    expect(plane.normal).toEqual(tilted.normal);
  });

  it('flips the normal and stays right-handed', () => {
    const plane = parallelDatumPlane(xy, p(0, 0, 2), true);
    expect(plane.normal.z).toBe(-1);
    expect(handed(plane)).toBeCloseTo(1, 12);
  });

  it('refuses a non-finite point', () => {
    expect(() => parallelDatumPlane(xy, p(0, Infinity, 0))).toThrow(
      /through point is not a finite/
    );
  });
});
