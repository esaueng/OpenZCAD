import { describe, expect, it } from 'vitest';
import {
  GEOMETRY_RELATIVE_TOLERANCE,
  axisRotationMatrix,
  canonicalAxisDirection,
  canonicalPlaneBasis,
  edgeDatumAxis,
  planeIntersectionDatumAxis,
  requireRevolveAxisInPlane,
  surfaceDatumAxis,
  twoPointDatumAxis,
  type DatumAxis,
  type PlaneBasis,
  type Vec3
} from '@openzcad/geometry';

/**
 * R01 datum axis construction against closed-form expectations: two points,
 * a straight edge, a surface axis in canonical sense, where two planes meet
 * (with the parallel refusal tested on both sides of its tolerance), the
 * rotation about an axis that every consumer applies, and the revolve rule
 * that the axis lie in the sketch plane.
 */

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const plane = (origin: Vec3, normal: Vec3): PlaneBasis => {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  const n = v(normal.x / length, normal.y / length, normal.z / length);
  // Any right-handed in-plane pair; the axis construction reads only n and o.
  const helper = Math.abs(n.x) < 0.9 ? v(1, 0, 0) : v(0, 1, 0);
  const u0 = v(
    helper.y * n.z - helper.z * n.y,
    helper.z * n.x - helper.x * n.z,
    helper.x * n.y - helper.y * n.x
  );
  const ul = Math.hypot(u0.x, u0.y, u0.z);
  const u = v(u0.x / ul, u0.y / ul, u0.z / ul);
  return {
    origin,
    u,
    v: v(n.y * u.z - n.z * u.y, n.z * u.x - n.x * u.z, n.x * u.y - n.y * u.x),
    normal: n
  };
};
const apply = (matrix: number[], p: Vec3): Vec3 => ({
  x: matrix[0]! * p.x + matrix[1]! * p.y + matrix[2]! * p.z + matrix[3]!,
  y: matrix[4]! * p.x + matrix[5]! * p.y + matrix[6]! * p.z + matrix[7]!,
  z: matrix[8]! * p.x + matrix[9]! * p.y + matrix[10]! * p.z + matrix[11]!
});
const expectVector = (actual: Vec3, expected: Vec3, digits = 12) => {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
};
const onLine = (axis: DatumAxis, point: Vec3) => {
  const d = v(
    point.x - axis.origin.x,
    point.y - axis.origin.y,
    point.z - axis.origin.z
  );
  const c = v(
    d.y * axis.direction.z - d.z * axis.direction.y,
    d.z * axis.direction.x - d.x * axis.direction.z,
    d.x * axis.direction.y - d.y * axis.direction.x
  );
  return Math.hypot(c.x, c.y, c.z);
};

describe('axis through two points', () => {
  it('runs from the first point toward the second, origin on the first', () => {
    const axis = twoPointDatumAxis(v(1, 2, 3), v(1, 2, 13));
    expect(axis.origin).toEqual(v(1, 2, 3));
    expect(axis.direction).toEqual(v(0, 0, 1));
    const diagonal = twoPointDatumAxis(v(0, 0, 0), v(3, 4, 0));
    expectVector(diagonal.direction, v(0.6, 0.8, 0));
  });

  it('reverses the direction without moving the line', () => {
    const axis = twoPointDatumAxis(v(1, 2, 3), v(1, 2, 13), true);
    expect(axis.origin).toEqual(v(1, 2, 3));
    expect(axis.direction).toEqual(v(-0, -0, -1));
  });

  it('refuses coincident points on both sides of the tolerance', () => {
    expect(() => twoPointDatumAxis(v(5, 5, 5), v(5, 5, 5))).toThrow(
      /two separate points; these coincide/
    );
    expect(() => twoPointDatumAxis(v(0, 0, 0), v(5e-7, 0, 0))).toThrow(
      /coincide/
    );
    expect(twoPointDatumAxis(v(0, 0, 0), v(2e-6, 0, 0)).direction).toEqual(
      v(1, 0, 0)
    );
  });

  it('refuses a non-finite point', () => {
    expect(() => twoPointDatumAxis(v(Number.NaN, 0, 0), v(1, 0, 0))).toThrow(
      /first point is not a finite position/
    );
  });
});

describe('axis along an edge', () => {
  it('runs from end 0 toward end 1', () => {
    const axis = edgeDatumAxis(v(20, 0, 0), v(20, 0, 20));
    expect(axis.origin).toEqual(v(20, 0, 0));
    expect(axis.direction).toEqual(v(0, 0, 1));
  });

  it('refuses a zero-length edge', () => {
    expect(() => edgeDatumAxis(v(1, 1, 1), v(1, 1, 1))).toThrow(
      /non-zero length/
    );
  });
});

describe('surface axis', () => {
  it('takes the canonical sense whichever way the kernel reports it', () => {
    expect(canonicalAxisDirection(v(0, 0, -2))).toEqual(v(-0, -0, 1));
    expect(canonicalAxisDirection(v(0, 0, 2))).toEqual(v(0, 0, 1));
    expectVector(
      canonicalAxisDirection(v(-1, 1, 0)),
      v(Math.SQRT1_2, -Math.SQRT1_2, 0)
    );
    // Float noise below the direction quantum never decides the sense.
    expect(canonicalAxisDirection(v(-1e-9, 0, -1)).z).toBeCloseTo(1, 12);
    expect(canonicalAxisDirection(v(1e-9, 0, -1)).z).toBeCloseTo(1, 12);
  });

  it('keeps its origin and reverses on request', () => {
    const axis = surfaceDatumAxis(v(5, 5, 10), v(0, 0, -1));
    expect(axis.origin).toEqual(v(5, 5, 10));
    expect(axis.direction.z).toBe(1);
    expect(surfaceDatumAxis(v(5, 5, 10), v(0, 0, -1), true).direction.z).toBe(
      -1
    );
  });

  it('refuses a zero direction', () => {
    expect(() => surfaceDatumAxis(v(0, 0, 0), v(0, 0, 0))).toThrow(
      /no direction/
    );
  });
});

describe('axis where two planes meet', () => {
  it('meets XZ and YZ along +Z through the origin', () => {
    const axis = planeIntersectionDatumAxis(
      canonicalPlaneBasis('XZ', 2),
      canonicalPlaneBasis('YZ')
    );
    expectVector(axis.origin, v(0, 0, 0));
    // XZ (revision 2) faces −Y and YZ faces +X: (−Y) × (+X) = +Z.
    expectVector(axis.direction, v(0, 0, 1));
  });

  it('meets two offset planes on the line nearest A’s origin', () => {
    // x = 4 and z = 7 meet in the line (4, t, 7).
    const a = plane(v(4, 9, -3), v(1, 0, 0));
    const b = plane(v(-2, 5, 7), v(0, 0, 1));
    const axis = planeIntersectionDatumAxis(a, b);
    expectVector(axis.origin, v(4, 9, 7));
    expectVector(axis.direction, v(0, -1, 0));
    expect(onLine(axis, v(4, -100, 7))).toBeLessThan(1e-12);
  });

  it('meets oblique planes on their analytic line', () => {
    // x + y = 2 and z = x: the line (t, 2 − t, t), direction ∝ (1, −1, 1).
    const a = plane(v(1, 1, 0), v(1, 1, 0));
    const b = plane(v(0, 0, 0), v(-1, 0, 1));
    const axis = planeIntersectionDatumAxis(a, b);
    for (const t of [-5, 0, 1, 8]) {
      expect(onLine(axis, v(t, 2 - t, t))).toBeLessThan(1e-12);
    }
    const s = 1 / Math.sqrt(3);
    expect(Math.abs(axis.direction.x)).toBeCloseTo(s, 12);
    expect(axis.direction.x * axis.direction.y).toBeCloseTo(-s * s, 12);
  });

  it('refuses parallel and antiparallel planes on both sides of the tolerance', () => {
    const xy = plane(v(0, 0, 0), v(0, 0, 1));
    expect(() =>
      planeIntersectionDatumAxis(xy, plane(v(0, 0, 10), v(0, 0, 1)))
    ).toThrow(/not parallel; these are parallel/);
    expect(() =>
      planeIntersectionDatumAxis(xy, plane(v(0, 0, 10), v(0, 0, -1)))
    ).toThrow(/parallel/);
    // A tilt of half the tolerance is parallel; twice it is not.
    const tilted = (angle: number) =>
      plane(v(0, 0, 10), v(Math.sin(angle), 0, Math.cos(angle)));
    expect(() =>
      planeIntersectionDatumAxis(xy, tilted(GEOMETRY_RELATIVE_TOLERANCE / 2))
    ).toThrow(/parallel/);
    const steep = planeIntersectionDatumAxis(
      xy,
      tilted(GEOMETRY_RELATIVE_TOLERANCE * 4)
    );
    expect(Math.abs(steep.direction.y)).toBeCloseTo(1, 9);
  });

  it('reverses the direction on request', () => {
    const forward = planeIntersectionDatumAxis(
      canonicalPlaneBasis('XZ', 2),
      canonicalPlaneBasis('YZ')
    );
    const reversed = planeIntersectionDatumAxis(
      canonicalPlaneBasis('XZ', 2),
      canonicalPlaneBasis('YZ'),
      true
    );
    expect(reversed.origin).toEqual(forward.origin);
    expectVector(reversed.direction, v(0, 0, -1));
  });
});

describe('rotation about a datum axis', () => {
  it('turns right-handed about the direction and keeps the line fixed', () => {
    const axis = twoPointDatumAxis(v(5, 0, 0), v(5, 0, 10));
    const quarter = axisRotationMatrix(axis, 90);
    expectVector(apply(quarter, v(1, 0, 0)), v(5, -4, 0));
    expectVector(apply(quarter, v(5, 0, 3)), v(5, 0, 3));
    expectVector(apply(axisRotationMatrix(axis, 180), v(1, 0, 7)), v(9, 0, 7));
    // A reversed axis turns the other way.
    const reversed = axisRotationMatrix(
      { ...axis, direction: v(0, 0, -1) },
      90
    );
    expectVector(apply(reversed, v(1, 0, 0)), v(5, 4, 0));
  });

  it('turns about an oblique axis', () => {
    // A third of a turn about (1, 1, 1) through the origin cycles the axes.
    const axis = twoPointDatumAxis(v(0, 0, 0), v(1, 1, 1));
    expectVector(apply(axisRotationMatrix(axis, 120), v(1, 0, 0)), v(0, 1, 0));
  });
});

describe('revolve axis in the sketch plane', () => {
  const xz = canonicalPlaneBasis('XZ', 2);

  it('accepts an axis in the plane, through or off its origin', () => {
    expect(() =>
      requireRevolveAxisInPlane(
        twoPointDatumAxis(v(20, 0, 0), v(20, 0, 10)),
        xz,
        'Profile'
      )
    ).not.toThrow();
    expect(() =>
      requireRevolveAxisInPlane(
        twoPointDatumAxis(v(0, 0, 0), v(1, 0, 1)),
        xz,
        'Profile'
      )
    ).not.toThrow();
  });

  it('refuses an axis off the plane or tilted out of it', () => {
    expect(() =>
      requireRevolveAxisInPlane(
        twoPointDatumAxis(v(0, 5, 0), v(0, 5, 10)),
        xz,
        'Profile'
      )
    ).toThrow(/does not lie in the plane of sketch "Profile"/);
    expect(() =>
      requireRevolveAxisInPlane(
        twoPointDatumAxis(v(0, 0, 0), v(0, 1, 10)),
        xz,
        'Profile'
      )
    ).toThrow(/does not lie in the plane/);
  });
});
