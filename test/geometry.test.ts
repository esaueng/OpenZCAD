import { describe, expect, it } from 'vitest';
import {
  FRONT_FACING_XZ_BASIS,
  PLANE_BASES,
  canonicalPlaneBasis,
  canonicalPlaneRefForEdit,
  circleProfile,
  frameForPlaneRef,
  newCanonicalPlaneRef,
  polygonProfile,
  rectangleProfile,
  solidFromTriangles,
  solidVolume,
  validateSolid,
  type Solid
} from '@openzcad/geometry';

/**
 * What the geometry package still owns after the kernel took over solids:
 * sketch-plane frames, closed 2D profiles, and mesh welding. Solids, sweeps
 * and booleans are the exact kernel's job and are covered by the kernel suites.
 */

function signedArea(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

describe('sketch plane frames', () => {
  it('keeps every canonical basis right-handed (u x v = normal)', () => {
    for (const { u, v, normal } of [
      ...Object.values(PLANE_BASES),
      FRONT_FACING_XZ_BASIS
    ]) {
      const cross = {
        x: u.y * v.z - u.z * v.y,
        y: u.z * v.x - u.x * v.z,
        z: u.x * v.y - u.y * v.x
      };
      expect(cross.x).toBeCloseTo(normal.x, 12);
      expect(cross.y).toBeCloseTo(normal.y, 12);
      expect(cross.z).toBeCloseTo(normal.z, 12);
    }
  });

  it('offsets a canonical plane along its own normal', () => {
    const basis = frameForPlaneRef(
      { type: 'canonical', plane: 'XZ', offset: 'h' },
      () => 7
    );
    // XZ's normal is +Y, so the frame slides up Y and nothing else moves.
    expect(basis.origin).toEqual({ x: 0, y: 7, z: 0 });
    expect(basis.u).toEqual(PLANE_BASES.XZ.u);
    expect(basis.v).toEqual(PLANE_BASES.XZ.v);
    expect(basis.normal).toEqual(PLANE_BASES.XZ.normal);
  });

  it('resolves a revision-2 XZ plane to face the Front view', () => {
    // The Front view looks along +Y from -Y with +Z up, so screen-right is +X
    // and screen-up is +Z. Revision 1's XZ (v = -Z, normal +Y) is viewed from
    // behind the model and reads mirrored; revision 2 must read u right and
    // v up from the front, with its offset sliding toward that viewer.
    const basis = frameForPlaneRef(
      { type: 'canonical', plane: 'XZ', offset: 'h', basisRevision: 2 },
      () => 7
    );
    expect(basis.origin).toEqual({ x: 0, y: -7, z: 0 });
    expect(basis.u).toEqual({ x: 1, y: 0, z: 0 });
    expect(basis.v).toEqual({ x: 0, y: 0, z: 1 });
    expect(basis.normal).toEqual({ x: 0, y: -1, z: 0 });
  });

  it('keeps XY and YZ identical across basis revisions', () => {
    expect(canonicalPlaneBasis('XY', 2)).toBe(PLANE_BASES.XY);
    expect(canonicalPlaneBasis('YZ', 2)).toBe(PLANE_BASES.YZ);
    expect(canonicalPlaneBasis('XZ')).toBe(PLANE_BASES.XZ);
  });

  it('writes the basis revision on new refs only where it changes the basis', () => {
    // Saved XY and YZ sketches must stay byte-identical to new ones, and a
    // legacy XZ ref with no revision must keep resolving to revision 1.
    expect(newCanonicalPlaneRef('XY', 3)).toEqual({
      type: 'canonical',
      plane: 'XY',
      offset: 3
    });
    expect(newCanonicalPlaneRef('YZ', 0)).toEqual({
      type: 'canonical',
      plane: 'YZ',
      offset: 0
    });
    expect(newCanonicalPlaneRef('XZ', 0)).toEqual({
      type: 'canonical',
      plane: 'XZ',
      offset: 0,
      basisRevision: 2
    });
  });

  it('uses a stored frame verbatim for non-canonical plane references', () => {
    const frame = {
      origin: { x: 1, y: 2, z: 3 },
      xAxis: { x: 0, y: 1, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      zAxis: { x: 1, y: 0, z: 0 }
    };
    const basis = frameForPlaneRef({ type: 'frame', frame }, () => {
      throw new Error('a stored frame must not consult the offset evaluator');
    });
    expect(basis.origin).toEqual(frame.origin);
    expect(basis.u).toEqual(frame.xAxis);
    expect(basis.v).toEqual(frame.yAxis);
    expect(basis.normal).toEqual(frame.zAxis);
  });

  it.each(['XY', 'YZ'] as const)(
    'authors a %s to Front edit with the current basis',
    (plane) => {
      const ref = canonicalPlaneRefForEdit(
        { type: 'canonical', plane, offset: 0 },
        'XZ',
        3
      );
      const frame = frameForPlaneRef(ref, (value) => Number(value));
      expect(frame.origin).toEqual({ x: 0, y: -3, z: 0 });
      expect(frame.v).toEqual({ x: 0, y: 0, z: 1 });
      expect(frame.normal).toEqual({ x: 0, y: -1, z: 0 });
    }
  );

  it('keeps a legacy Front basis when only its offset changes', () => {
    const ref = canonicalPlaneRefForEdit(
      { type: 'canonical', plane: 'XZ', offset: 0 },
      'XZ',
      3
    );
    expect(ref).toEqual({ type: 'canonical', plane: 'XZ', offset: 3 });
    expect(frameForPlaneRef(ref, (value) => Number(value)).origin).toEqual({
      x: 0,
      y: 3,
      z: 0
    });
  });

  it('keeps a current Front basis on the same plane and uses it when returning to Front', () => {
    const ref = canonicalPlaneRefForEdit(
      newCanonicalPlaneRef('XZ', 0),
      'XZ',
      3
    );
    expect(ref.basisRevision).toBe(2);
    const side = canonicalPlaneRefForEdit(ref, 'YZ', 3);
    expect(side).toEqual(newCanonicalPlaneRef('YZ', 3));
    expect(canonicalPlaneRefForEdit(side, 'XZ', 3)).toEqual(ref);
  });
});

describe('sketch profiles', () => {
  it('centres a rectangle on its centre point and winds it counter-clockwise', () => {
    const profile = rectangleProfile(20, 10, 3, -4);
    expect(profile).toHaveLength(4);
    expect(Math.min(...profile.map((point) => point.x))).toBeCloseTo(-7, 12);
    expect(Math.max(...profile.map((point) => point.x))).toBeCloseTo(13, 12);
    expect(Math.min(...profile.map((point) => point.y))).toBeCloseTo(-9, 12);
    expect(Math.max(...profile.map((point) => point.y))).toBeCloseTo(1, 12);
    expect(signedArea(profile)).toBeCloseTo(200, 9);
  });

  it('approximates a circle within a fraction of a percent of its area', () => {
    const profile = circleProfile(10);
    expect(profile).toHaveLength(48);
    const area = signedArea(profile);
    const analytic = Math.PI * 100;
    expect(area).toBeGreaterThan(analytic * 0.995);
    expect(area).toBeLessThan(analytic);
  });

  it('inscribes a polygon in its radius with a flat-symmetric first vertex', () => {
    const hex = polygonProfile(6, 10);
    expect(hex).toHaveLength(6);
    // The first point sits at the top so the shape is symmetric about x = 0.
    expect(hex[0]!.x).toBeCloseTo(0, 9);
    expect(hex[0]!.y).toBeCloseTo(10, 9);
    expect(signedArea(hex)).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 100, 9);
  });

  it('rejects nonsense profile dimensions', () => {
    expect(() => rectangleProfile(0, 10)).toThrow(/positive/);
    expect(() => circleProfile(-1)).toThrow(/positive/);
    expect(() => polygonProfile(6, 0)).toThrow(/positive/);
  });

  it('clamps circle segments and rejects unbounded polygon sides', () => {
    expect(circleProfile(5, 0, 0, 2)).toHaveLength(8);
    expect(circleProfile(5, 0, 0, 4096)).toHaveLength(128);
    expect(() => polygonProfile(2, 5)).toThrow(/3 to 64/);
    expect(() => polygonProfile(65, 5)).toThrow(/3 to 64/);
  });
});

describe('mesh welding', () => {
  const tetrahedron = {
    // Four triangles, each with its own copy of the shared corners.
    vertices: [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0,
      0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0
    ],
    indices: [...Array(12).keys()]
  };

  it('welds duplicated triangle corners into shared vertices', () => {
    const solid = solidFromTriangles(tetrahedron.vertices, tetrahedron.indices);
    expect(solid.vertices).toHaveLength(4);
    expect(solid.faces).toHaveLength(4);
    expect(validateSolid(solid).closed).toBe(true);
    expect(Math.abs(solidVolume(solid))).toBeCloseTo(1 / 6, 9);
  });

  it('drops degenerate triangles rather than emitting zero-area faces', () => {
    const solid = solidFromTriangles([0, 0, 0, 1, 0, 0, 0, 0, 0], [0, 1, 2]);
    expect(solid.faces).toHaveLength(0);
  });

  it('counts the open edges of a mesh that is not a closed shell', () => {
    // One triangle: three boundary edges, used once each.
    const open = solidFromTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const validation = validateSolid(open);
    expect(validation.closed).toBe(false);
    expect(validation.openEdgeCount).toBe(3);
    expect(validation.nonManifoldEdgeCount).toBe(0);
  });

  it('signs the volume by winding, so an inside-out mesh is detectable', () => {
    const solid = solidFromTriangles(tetrahedron.vertices, tetrahedron.indices);
    const flipped: Solid = {
      vertices: solid.vertices,
      faces: solid.faces.map((face) => [...face].reverse())
    };
    // Volume is signed, not absolute: reversing every loop reverses the sign.
    expect(solidVolume(flipped)).toBeCloseTo(-solidVolume(solid), 12);
    expect(Math.sign(solidVolume(flipped))).toBe(
      -Math.sign(solidVolume(solid))
    );
  });
});
