import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { measureFaceGeometry } from './exact-measure';
import {
  recognizeWallBlends,
  resizeWallThroughBlends,
  type IncidentBlend
} from './exact-direct-edit-reblend';
import { assertWallResizeAccepted } from './result-acceptance';

/**
 * WS6 ladder step 2 (remove the blends, resize the wall, rebuild the
 * blends) on the upright imported-twin shape: a round post standing in a
 * block with its seam and its top rim filleted, the R2 reference scenario of
 * docs/plans/kernel-robustness-plan-2026-11-05.md. The volume oracle is
 * closed form (Pappus), never the kernel's own measurement of another body.
 */
const translation = (x: number, y: number, z: number) =>
  new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);

const BLOCK = { width: 60, height: 40, depth: 20 };
const POST = { radius: 6, height: 30, base: { x: 30, y: 20, z: 10 } };
const SEAM = 2;
const RIM = 1;
const AXIS = { x: 0, y: 0, z: 1 };

/** Distance of a fillet spandrel's centroid from its corner, per unit size. */
const SPANDREL_CENTROID = (10 - 3 * Math.PI) / (12 - 3 * Math.PI);
const spandrelArea = (size: number) => size * size * (1 - Math.PI / 4);

/**
 * Block ∪ post, the seam's concave fillet adding a ring outside the post
 * and the rim's convex fillet removing one inside it.
 */
function postVolume(
  radius: number,
  blends: { seam?: number; rim?: number }
): number {
  const top = POST.base.z + POST.height;
  const blockTop = BLOCK.depth;
  let volume =
    BLOCK.width * BLOCK.height * BLOCK.depth +
    Math.PI * radius * radius * (top - blockTop);
  if (blends.seam) {
    volume +=
      2 *
      Math.PI *
      (radius + SPANDREL_CENTROID * blends.seam) *
      spandrelArea(blends.seam);
  }
  if (blends.rim) {
    volume -=
      2 *
      Math.PI *
      (radius - SPANDREL_CENTROID * blends.rim) *
      spandrelArea(blends.rim);
  }
  return volume;
}

function circleAt(kernel: RemusKernel, solid: number, z: number): number[] {
  return Array.from(kernel.getSolidEdges(solid)).filter(
    (edge) =>
      kernel.getEdgeCurveType(edge) === 'CIRCLE' &&
      Math.abs(kernel.tessellateEdge(edge, 4)[2]! - z) < 1e-9
  );
}

function wallAt(kernel: RemusKernel, solid: number, radius: number): number {
  const walls = Array.from(kernel.getSolidFaces(solid)).filter((face) => {
    const geometry = measureFaceGeometry(kernel, face);
    return (
      geometry?.surfaceType === 'cylinder' &&
      Math.abs((geometry.radius ?? 0) - radius) < 1e-9
    );
  });
  expect(walls).toHaveLength(1);
  return walls[0]!;
}

function post(
  kernel: RemusKernel,
  seam: boolean,
  rim: boolean
): { solid: number; wall: number } {
  const block = kernel.makeBox(BLOCK.width, BLOCK.height, BLOCK.depth);
  const cylinder = kernel.makeCylinder(POST.radius, POST.height);
  kernel.transformSolid(
    cylinder,
    translation(POST.base.x, POST.base.y, POST.base.z)
  );
  let solid = kernel.fuse(block, cylinder);
  if (seam) {
    const edges = new Uint32Array(circleAt(kernel, solid, BLOCK.depth));
    expect(edges).toHaveLength(1);
    const built = kernel.filletDetailed(solid, edges, SEAM, true);
    expect(built.status).toBe('ok');
    solid = built.value!;
  }
  if (rim) {
    const edges = new Uint32Array(
      circleAt(kernel, solid, POST.base.z + POST.height)
    );
    expect(edges).toHaveLength(1);
    solid = kernel.fillet(solid, edges, RIM);
  }
  return { solid, wall: wallAt(kernel, solid, POST.radius) };
}

function ladder(
  kernel: RemusKernel,
  solid: number,
  blends: readonly IncidentBlend[],
  newRadius: number
): number {
  return resizeWallThroughBlends(kernel, {
    solid,
    blends,
    sourceRadius: POST.radius,
    newRadius,
    axisPoint: POST.base,
    axisDirection: AXIS,
    axisTolerance: 1e-6,
    radiusTolerance: 6e-5,
    resize: (sharp, wall) => kernel.resizeCylindricalFace(sharp, wall, newRadius)
  });
}

describe('WS6 remove-blend, resize, re-blend for a cylindrical wall', () => {
  it('recognises the seam and rim bands of the post, with their supports', () => {
    const kernel = new RemusKernel();
    const { solid, wall } = post(kernel, true, true);
    const blends = recognizeWallBlends(kernel, solid, wall);
    expect(blends).not.toBeNull();
    expect(
      blends!
        .map((blend) => [blend.carrier.surfaceClass, blend.radius])
        .sort((left, right) => Number(left[1]) - Number(right[1]))
    ).toEqual([
      ['torus', RIM],
      ['torus', SEAM]
    ]);
    // Each band's other support is a plane: the block top and the post cap.
    expect(blends!.map((blend) => blend.support.kind)).toEqual([
      'plane',
      'plane'
    ]);
  });

  for (const radius of [7, 5]) {
    it(`resizes the post to r ${radius} and rebuilds both bands exactly`, () => {
      const kernel = new RemusKernel();
      const { solid, wall } = post(kernel, true, true);
      expect(kernel.volume(solid, 0.01)).toBeCloseTo(
        postVolume(POST.radius, { seam: SEAM, rim: RIM }),
        6
      );
      const blends = recognizeWallBlends(kernel, solid, wall)!;
      const output = ladder(kernel, solid, blends, radius);
      expect(kernel.validateSolidRelaxed(output)).toBe(0);
      expect(kernel.volume(output, 0.01)).toBeCloseTo(
        postVolume(radius, { seam: SEAM, rim: RIM }),
        6
      );
      // The rebuilt wall carries both bands again, at their own radii.
      const rebuiltWall = wallAt(kernel, output, radius);
      const again = recognizeWallBlends(kernel, output, rebuiltWall);
      expect(again?.map((blend) => blend.radius).sort()).toEqual([RIM, SEAM]);
      // The acceptance gates the plain route answers to pass as well.
      expect(() =>
        assertWallResizeAccepted(kernel, {
          sourceSolid: solid,
          sourceWall: wall,
          sourceRadius: POST.radius,
          output,
          newRadius: radius,
          axisPoint: POST.base,
          axisDirection: AXIS,
          axisTolerance: 1e-6,
          radiusTolerance: 6e-5
        })
      ).not.toThrow();
    });
  }

  it('recognises nothing on a sharp post, so the plain route answers alone', () => {
    const kernel = new RemusKernel();
    const { solid, wall } = post(kernel, false, false);
    expect(recognizeWallBlends(kernel, solid, wall)).toBeNull();
  });

  it('fails closed when a curved neighbour is not a blend band', () => {
    const kernel = new RemusKernel();
    // A boss grown out of a sphere with its top rim filleted: the rim is a
    // proven band, but the sphere the wall meets is not one the ladder can
    // remove and rebuild, so the whole ladder declines and the plain
    // route's refusal stands.
    const sphere = kernel.makeSphere(20, 64);
    const boss = kernel.makeCylinder(6, 30);
    let solid = kernel.fuse(sphere, boss);
    const rim = new Uint32Array(circleAt(kernel, solid, 30));
    expect(rim).toHaveLength(1);
    const built = kernel.filletDetailed(solid, rim, RIM, true);
    expect(built.status).toBe('ok');
    solid = built.value!;
    const wall = wallAt(kernel, solid, 6);
    expect(recognizeWallBlends(kernel, solid, wall)).toBeNull();
  });

  it('refuses a rebuild that cannot restore a band, leaving the caller to refuse', () => {
    const kernel = new RemusKernel();
    const { solid, wall } = post(kernel, true, true);
    const blends = recognizeWallBlends(kernel, solid, wall)!;
    // Shrinking the post below the rim fillet leaves no cap to blend into
    // at that radius: the rebuild has to refuse, not ship a partial body.
    expect(() => ladder(kernel, solid, blends, 0.5)).toThrow();
  });
});
