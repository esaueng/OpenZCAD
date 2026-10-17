import { describe, expect, it } from 'vitest';
import {
  canonicalPlaneBasis,
  midDatumPlane,
  offsetDatumPlane,
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
