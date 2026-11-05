import { describe, expect, it } from 'vitest';
import type { EdgeWitnessV1, FaceWitnessV1 } from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import {
  primitiveSphereFaceRoles,
  quantizedSphereCarrier,
  sphereCarrierOf,
  sphereWitnessTieResolver
} from './exact-sphere-patches';
import { faceWitnessOf } from './exact-witnesses';
import {
  edgeLiesOnFaceCarriers,
  orderPiecesAroundCylinderSeam,
  topologyHashOfWitness
} from './topology-lineage';
import {
  carryRemusUnchangedLineage,
  createRemusSemanticLineage,
  propagateRemusRigidTransformLineage,
  type RemusTopologyCandidate
} from './remus-lineage';
import type { FeatureId } from '@openzcad/shared';

const CURVE_SEGMENTS = 64;

function rotationAboutX(degrees: number, translation = [0, 0, 0]) {
  const t = (degrees * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    1,
    0,
    0,
    translation[0]!,
    0,
    c,
    -s,
    translation[1]!,
    0,
    s,
    c,
    translation[2]!,
    0,
    0,
    0,
    1
  ];
}

function faceCandidates(
  kernel: RemusKernel,
  solid: number
): RemusTopologyCandidate[] {
  return Array.from(kernel.getSolidFaces(solid), (handle) => ({
    handle,
    kind: 'face' as const,
    witness: faceWitnessOf(kernel, handle)
  }));
}

function distance(kernel: RemusKernel, face: number, point: number[]) {
  return kernel.pointToFaceDistance(point[0]!, point[1]!, point[2]!, face)[0]!;
}

describe('primitive sphere patches (K06)', () => {
  it('names each hemisphere by the one pole it holds, though both share one witness', () => {
    const kernel = new RemusKernel();
    for (const radius of [0.5, 10, 73.5, 1000]) {
      const solid = kernel.makeSphere(radius, CURVE_SEGMENTS);
      const faces = Array.from(kernel.getSolidFaces(solid));
      // The collision the roles exist for: ADR-011 cannot separate them.
      const hashes = faces.map((face) =>
        topologyHashOfWitness('face', faceWitnessOf(kernel, face))
      );
      expect(new Set(hashes).size).toBe(1);

      const roles = primitiveSphereFaceRoles(kernel, solid)!;
      expect(roles).not.toBeNull();
      expect([...roles.values()].sort()).toEqual(['z-max', 'z-min']);
      for (const [face, role] of roles) {
        const pole = [0, 0, role === 'z-max' ? radius : -radius];
        const opposite = [0, 0, role === 'z-max' ? -radius : radius];
        // Independent oracle: the trimmed face holds its pole, not the other.
        expect(distance(kernel, face, pole)).toBeLessThan(
          1e-9 * radius + 1e-12
        );
        expect(distance(kernel, face, opposite)).toBeCloseTo(
          Math.SQRT2 * radius,
          6
        );
      }
    }
  });

  it('declines anything that is not one sphere in two patches', () => {
    const kernel = new RemusKernel();
    expect(
      primitiveSphereFaceRoles(kernel, kernel.makeBox(2, 2, 2))
    ).toBeNull();
    expect(
      primitiveSphereFaceRoles(kernel, kernel.makeCylinder(1, 2))
    ).toBeNull();
    expect(
      primitiveSphereFaceRoles(kernel, kernel.makeTorus(5, 1, CURVE_SEGMENTS))
    ).toBeNull();
  });

  it('carries each name through a rotation onto the patch holding the moved pole', () => {
    const kernel = new RemusKernel();
    const radius = 12;
    const source = kernel.makeSphere(radius, CURVE_SEGMENTS);
    const roles = primitiveSphereFaceRoles(kernel, source)!;
    const lineage = createRemusSemanticLineage(
      'feature_sphere' as FeatureId,
      'primitive',
      faceCandidates(kernel, source).map((candidate) => ({
        ...candidate,
        lineageName: `primitive.sphere.face.${roles.get(candidate.handle)}`
      }))
    );
    expect(lineage.faceReferences.size).toBe(2);
    const matrix = rotationAboutX(90, [3, -4, 5]);
    const moved = kernel.copyAndTransformSolid(
      source,
      new Float64Array(matrix)
    );
    const results = faceCandidates(kernel, moved);

    // Without the tie resolver the witness tie is a split: nothing carries.
    const blind = propagateRemusRigidTransformLineage(lineage, results, matrix);
    expect(blind.faceReferences.size).toBe(0);
    expect(blind.diagnostics.map((entry) => entry.code)).toContain(
      'transform-split'
    );

    const carried = propagateRemusRigidTransformLineage(
      lineage,
      results,
      matrix,
      false,
      sphereWitnessTieResolver(kernel, source, matrix)
    );
    expect(carried.faceReferences.size).toBe(2);
    // +90° about x sends the +z pole to −y, then the translation applies.
    const movedPoles = {
      'primitive.sphere.face.z-max': [3, -4 - radius, 5],
      'primitive.sphere.face.z-min': [3, -4 + radius, 5]
    } as const;
    for (const [handle, reference] of carried.faceReferences) {
      const pole = movedPoles[reference.lineageName as keyof typeof movedPoles];
      expect(pole).toBeDefined();
      expect(distance(kernel, handle, [...pole])).toBeLessThan(1e-6);
    }
  });

  it('resolves the identity copy a boolean probe takes, and refuses a foreign answer', () => {
    const kernel = new RemusKernel();
    const source = kernel.makeSphere(4, CURVE_SEGMENTS);
    const roles = primitiveSphereFaceRoles(kernel, source)!;
    const lineage = createRemusSemanticLineage(
      'feature_sphere' as FeatureId,
      'primitive',
      faceCandidates(kernel, source).map((candidate) => ({
        ...candidate,
        lineageName: `primitive.sphere.face.${roles.get(candidate.handle)}`
      }))
    );
    const copy = kernel.copySolid(source);
    const results = faceCandidates(kernel, copy);
    expect(
      carryRemusUnchangedLineage(lineage, results, 'boolean')!.faceReferences
        .size
    ).toBe(0);
    const carried = carryRemusUnchangedLineage(
      lineage,
      results,
      'boolean',
      'hash-only',
      sphereWitnessTieResolver(kernel, source)
    )!;
    expect(
      [...carried.faceReferences.values()]
        .map((entry) => entry.lineageName)
        .sort()
    ).toEqual(['primitive.sphere.face.z-max', 'primitive.sphere.face.z-min']);
    // A resolver naming a handle outside the tie publishes nothing.
    const rogue = carryRemusUnchangedLineage(
      lineage,
      results,
      'boolean',
      'hash-only',
      () => 999_999
    )!;
    expect(rogue.faceReferences.size).toBe(0);
  });

  it('declines a tie it cannot settle with a clean pole', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(2, 2, 2);
    const faces = Array.from(kernel.getSolidFaces(box));
    // Not a sphere: no probe, no answer.
    expect(
      sphereWitnessTieResolver(kernel, box)(
        'face',
        faces[0]!,
        faces.slice(1, 3)
      )
    ).toBeNull();
    const sphere = kernel.makeSphere(3, CURVE_SEGMENTS);
    const patches = Array.from(kernel.getSolidFaces(sphere));
    // Edges are never resolved this way.
    expect(
      sphereWitnessTieResolver(kernel, sphere)('edge', patches[0]!, patches)
    ).toBeNull();
    // A source that is not a face of the stated solid has no "others" to clear.
    expect(
      sphereWitnessTieResolver(kernel, box)('face', patches[0]!, patches)
    ).toBeNull();
  });

  it('measures the exact carrier the witness has no term for', () => {
    const kernel = new RemusKernel();
    const solid = kernel.copyAndTransformSolid(
      kernel.makeSphere(7.25, CURVE_SEGMENTS),
      new Float64Array([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])
    );
    for (const face of kernel.getSolidFaces(solid)) {
      expect(faceWitnessOf(kernel, face).analytic.kind).toBe('none');
      expect(quantizedSphereCarrier(sphereCarrierOf(kernel, face)!)).toEqual({
        center: [1_000_000, 2_000_000, 3_000_000],
        radius: 7_250_000
      });
    }
  });
});

describe('sphere carriers in boolean seam evidence', () => {
  const sphere = {
    center: [0, 0, 0] as [number, number, number],
    radius: 10_000_000
  };
  const sphereFace: FaceWitnessV1 = {
    surfaceType: 'sphere',
    perimeter: 1,
    centroid: null,
    analytic: { kind: 'none' },
    closure: { u: 'closed', v: 'open' }
  };
  const wall: FaceWitnessV1 = {
    surfaceType: 'cylinder',
    perimeter: 1,
    centroid: null,
    analytic: {
      kind: 'cylinder',
      axis: [0, 0, 1000],
      axisFoot: [0, 0, 0],
      radius: 6_000_000
    },
    closure: { u: 'closed', v: 'open' }
  };
  const q = (x: number, y: number, z: number): [number, number, number] => [
    Math.round(x * 1e6),
    Math.round(y * 1e6),
    Math.round(z * 1e6)
  ];
  // Points on both the r=6 wall and the r=10 sphere: z = 8.
  const onBoth = (degrees: number) => {
    const t = (degrees * Math.PI) / 180;
    return q(6 * Math.cos(t), 6 * Math.sin(t), 8);
  };
  const arc = (from: number, to: number): EdgeWitnessV1 => ({
    curveType: 'BSPLINE_CURVE',
    length: 1,
    closed: false,
    endpoints: [onBoth(from), onBoth(to)],
    midpoint: onBoth((from + to) / 2)
  });

  it('accepts a seam on the sphere only against the exact sphere', () => {
    const edge = arc(10, 80);
    expect(edgeLiesOnFaceCarriers(edge, [sphereFace, wall])).toBe(false);
    expect(
      edgeLiesOnFaceCarriers(edge, [sphereFace, wall], [sphere, undefined])
    ).toBe(true);
    // A different sphere is not this seam's carrier.
    expect(
      edgeLiesOnFaceCarriers(
        edge,
        [sphereFace, wall],
        [{ center: sphere.center, radius: 10_000_100 }, undefined]
      )
    ).toBe(false);
  });

  const seam: EdgeWitnessV1 = {
    curveType: 'LINE',
    length: 1,
    closed: false,
    endpoints: [q(6, 0, 8), q(6, 0, 20)],
    midpoint: q(6, 0, 14)
  };

  it('orders pieces around the wall from its seam, whatever order they arrive in', () => {
    const pieces = [arc(120, 240), arc(0.5, 120), arc(240, 359.5)];
    expect(
      orderPiecesAroundCylinderSeam(pieces, wall.analytic, [seam, ...pieces])
    ).toEqual([1, 0, 2]);
  });

  it('declines without exactly one seam, near the seam, or off the wall', () => {
    const pieces = [arc(0.5, 120), arc(120, 240), arc(240, 359.5)];
    expect(
      orderPiecesAroundCylinderSeam(pieces, wall.analytic, pieces)
    ).toBeNull();
    const second: EdgeWitnessV1 = {
      ...seam,
      endpoints: [q(-6, 0, 8), q(-6, 0, 20)],
      midpoint: q(-6, 0, 14)
    };
    expect(
      orderPiecesAroundCylinderSeam(pieces, wall.analytic, [seam, second])
    ).toBeNull();
    // A midpoint on the seam could fall either side of it after an edit.
    expect(
      orderPiecesAroundCylinderSeam(
        [arc(-10, 10), arc(10, 350)],
        wall.analytic,
        [seam]
      )
    ).toBeNull();
    const off: EdgeWitnessV1 = {
      curveType: 'BSPLINE_CURVE',
      length: 1,
      closed: false,
      endpoints: [onBoth(10), onBoth(80)],
      midpoint: q(7, 0, 8)
    };
    expect(
      orderPiecesAroundCylinderSeam([off, arc(100, 200)], wall.analytic, [seam])
    ).toBeNull();
    expect(
      orderPiecesAroundCylinderSeam(pieces, { kind: 'none' }, [seam])
    ).toBeNull();
  });
});
