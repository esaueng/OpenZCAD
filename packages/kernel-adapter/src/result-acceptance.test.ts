import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { kernelRefusalRecordOf } from './kernel-refusal';
import {
  assertWallResizeAccepted,
  cutKeptToolMaterialRefusal,
  cutRetainedToolMaterialWitness,
  ResultAcceptanceRefusal,
  type WallResizeAcceptance
} from './result-acceptance';
import { measureFaceGeometry } from './exact-measure';

/**
 * Regressions for the K10 `wrong` cells: silent wrong geometry the kernel
 * reports as built. See docs/plans/kernel-robustness-plan-2026-11-05.md
 * ("Matrix results").
 */
const translation = (x: number, y: number, z: number) =>
  new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);

const AXIS = { x: 0, y: 0, z: 1 };

function bossOnBlock(
  kernel: RemusKernel,
  options: { seamFillet: boolean }
): { solid: number; wall: number } {
  const block = kernel.makeBox(60, 60, 20);
  const boss = kernel.makeCylinder(6, 30);
  kernel.transformSolid(boss, translation(30, 30, 10));
  let solid = kernel.fuse(block, boss);
  if (options.seamFillet) {
    const seam = Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
      if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
      const point = kernel.tessellateEdge(edge, 4);
      return Math.abs(point[2]! - 20) < 1e-9;
    });
    expect(seam).toHaveLength(1);
    solid = kernel.fillet(solid, new Uint32Array(seam), 2);
  }
  const walls = Array.from(kernel.getSolidFaces(solid)).filter((face) => {
    const geometry = measureFaceGeometry(kernel, face);
    return (
      geometry?.surfaceType === 'cylinder' &&
      Math.abs((geometry.radius ?? 0) - 6) < 1e-9
    );
  });
  expect(walls).toHaveLength(1);
  return { solid, wall: walls[0]! };
}

function resizeInput(
  solid: number,
  wall: number,
  output: number,
  newRadius: number
): WallResizeAcceptance {
  return {
    sourceSolid: solid,
    sourceWall: wall,
    sourceRadius: 6,
    output,
    newRadius,
    axisPoint: { x: 30, y: 30, z: 10 },
    axisDirection: AXIS,
    axisTolerance: 1e-6,
    radiusTolerance: 6e-5
  };
}

function refusalOf(run: () => void): ResultAcceptanceRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ResultAcceptanceRefusal);
    return error as ResultAcceptanceRefusal;
  }
  throw new Error('expected a refusal');
}

describe('cut acceptance (K10 box − half-embedded torus)', () => {
  it('finds the tool material a cut kept, and the refusal is typed', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 60, 20);
    const torus = kernel.makeTorus(15, 4, 64);
    kernel.transformSolid(torus, translation(30, 30, 20));
    const cut = kernel.cut(box, torus);
    // The defect this gate exists for. When the kernel cuts this pair
    // properly the witness search must come back empty instead.
    const kept =
      Math.abs(kernel.volume(cut, 0.08) - kernel.volume(box, 0.08)) < 1e-6;
    const witness = cutRetainedToolMaterialWitness(kernel, box, torus, cut);
    if (!kept) {
      expect(witness).toBeNull();
      return;
    }
    expect(witness).not.toBeNull();
    const [x, y, z] = witness!;
    // Strictly inside the analytic torus and the box, so a correct cut
    // removes it.
    expect(Math.hypot(Math.hypot(x - 30, y - 30) - 15, z - 20)).toBeLessThan(4);
    expect(z).toBeLessThan(20);
    const refusal = cutKeptToolMaterialRefusal('subtract', witness!);
    expect(refusal.message.split('\n')[0]).toBe(
      'Subtract refused: the exact kernel returned the target without ' +
        'removing the material the tool overlaps. The target and tools ' +
        'were left unchanged.'
    );
    expect(kernelRefusalRecordOf(refusal)).toEqual({
      family: 'validation',
      category: 'internal',
      code: 'cut_kept_tool_material'
    });
  });

  it('accepts a cut that removed the shared material', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 60, 20);
    const drill = kernel.makeCylinder(6, 30);
    kernel.transformSolid(drill, translation(30, 30, 10));
    const cut = kernel.cut(box, drill);
    expect(cutRetainedToolMaterialWitness(kernel, box, drill, cut)).toBeNull();
  });

  it('accepts a tool that only touches the target', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 60, 20);
    const lid = kernel.makeBox(60, 60, 5);
    kernel.transformSolid(lid, translation(0, 0, 20));
    expect(cutRetainedToolMaterialWitness(kernel, box, lid, box)).toBeNull();
  });
});

describe('wall resize acceptance (K10 boss under a seam fillet)', () => {
  it('refuses a resize that leaves the seam fillet behind', () => {
    const kernel = new RemusKernel();
    const { solid, wall } = bossOnBlock(kernel, { seamFillet: true });
    const output = kernel.resizeCylindricalFace(solid, wall, 7);
    const refusal = refusalOf(() =>
      assertWallResizeAccepted(kernel, resizeInput(solid, wall, output, 7))
    );
    expect(refusal.acceptanceCode).toBe('resize_left_blend_behind');
    expect(refusal.category).toBe('unsupported');
    expect(refusal.message.split('\n')[0]).toBe(
      'The wall could not be resized to radius 7: the blend or chamfer ' +
        'along its edge would be left behind at the old size. Remove the ' +
        'blend, resize the wall, then add the blend again.'
    );
    expect(refusal.kernelMessage).toContain('before the resize: 1 torus');
  });

  it('accepts a plain boss resize in both directions', () => {
    const kernel = new RemusKernel();
    const { solid, wall } = bossOnBlock(kernel, { seamFillet: false });
    for (const radius of [7, 5]) {
      const output = kernel.resizeCylindricalFace(solid, wall, radius);
      expect(() =>
        assertWallResizeAccepted(
          kernel,
          resizeInput(solid, wall, output, radius)
        )
      ).not.toThrow();
    }
  });

  it('refuses a volume change far from the swept sleeve', () => {
    const kernel = new RemusKernel();
    const { solid, wall } = bossOnBlock(kernel, { seamFillet: false });
    const output = kernel.resizeCylindricalFace(solid, wall, 7);
    // The same wall, but measured against a source the resize did not
    // start from: a volume change of the whole boss, not its sleeve.
    const block = kernel.makeBox(60, 60, 20);
    const refusal = refusalOf(() =>
      assertWallResizeAccepted(kernel, {
        ...resizeInput(solid, wall, output, 7),
        sourceSolid: block
      })
    );
    expect(refusal.acceptanceCode).toBe('resize_volume_mismatch');
  });
});
