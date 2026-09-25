import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeAsciiStl } from '@openzcad/io-stl';
import { RemusKernel, loadRemusTranslators } from './remus-runtime';
import { importMeshSolid } from './exact-shape-utils';
import { healPipelineSolid, unifyFacesReport } from './kernel-validation';

/**
 * The mesh-import unify, pinned at `importMeshSolid`.
 *
 * A sewn mesh's same-domain merge is decided by the kernel's transactional
 * heal pipeline: it either commits a merge its validators accept or refuses
 * and leaves the sewn shell standing. No strict validation of the sewn shell
 * or of the merged body decides anything here; the volume and bounds oracle
 * is what gates publishing.
 */

/** The 2 x 3 x 4 box, `offsets.length` times along x, as outward triangles. */
function boxSoup(offsets: readonly number[], dropTriangles = 0): string {
  const corners = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 3, 0],
    [0, 3, 0],
    [0, 0, 4],
    [2, 0, 4],
    [2, 3, 4],
    [0, 3, 4]
  ] as const;
  const triangles = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7]
  ] as const;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const dx of offsets) {
    const base = vertices.length / 3;
    for (const [x, y, z] of corners) vertices.push(x + dx, y, z);
    for (const [a, b, c] of triangles) {
      indices.push(a + base, b + base, c + base);
    }
  }
  indices.splice(indices.length - 3 * dropTriangles, 3 * dropTriangles);
  return writeAsciiStl('mesh', [{ name: 'mesh', vertices, indices }]);
}

function spyOnMeshUnify() {
  return {
    plain: vi.spyOn(RemusKernel.prototype, 'validateSolid'),
    detailed: vi.spyOn(RemusKernel.prototype, 'validateSolidDetailed'),
    heal: vi.spyOn(RemusKernel.prototype, 'runHealPipeline')
  };
}

beforeAll(async () => {
  await loadRemusTranslators();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importMeshSolid face unification', () => {
  it('adopts an accepted unify: a triangulated box comes back as six faces', () => {
    const kernel = new RemusKernel();
    const spies = spyOnMeshUnify();

    const solid = importMeshSolid(kernel, boxSoup([0]));

    expect(spies.heal).toHaveBeenCalledTimes(1);
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
    expect(kernel.getSolidFaces(solid).length).toBe(6);
    expect(kernel.volume(solid, 0.01)).toBeCloseTo(24, 9);
  });

  it('keeps the sewn faces when the unify is refused on an open mesh', () => {
    const kernel = new RemusKernel();
    const spies = spyOnMeshUnify();

    // One triangle short of a box: the sew closes nothing, and the kernel
    // refuses to merge the open shell's faces.
    const solid = importMeshSolid(kernel, boxSoup([0], 1));

    expect(spies.heal).toHaveBeenCalledTimes(1);
    expect(spies.heal.mock.results[0]!.type).toBe('throw');
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
    // All eleven sewn triangles stand, unmerged.
    expect(kernel.getSolidFaces(solid).length).toBe(11);
  });

  it('keeps the sewn faces of two disjoint boxes, whose unify is refused', () => {
    const kernel = new RemusKernel();
    const spies = spyOnMeshUnify();

    const solid = importMeshSolid(kernel, boxSoup([0, 10]));

    expect(spies.heal.mock.results[0]!.type).toBe('throw');
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
    expect(kernel.getSolidFaces(solid).length).toBe(24);
    expect(kernel.volume(solid, 0.01)).toBeCloseTo(48, 9);
  });

  /**
   * Why this path is not on `unifyFacesChecked` like the union gate.
   *
   * Measured on the pin: the checked unify agrees with the heal pipeline on a
   * closed box, a faceted cylinder and an open shell, but not on two disjoint
   * boxes. There the pipeline refuses the merge (its check validator counts
   * the second shell) while `unifyFacesChecked` merges both boxes cleanly.
   * Switching would turn a two-object file's 24 imported triangles into 12
   * faces, which is a change in what a user can select and in what a saved
   * document's face references resolve to. If this case ever starts to agree,
   * the swap becomes behaviour-neutral and this test says so.
   */
  it('records where the checked unify and the heal pipeline disagree', () => {
    const sewnPair = (kernel: RemusKernel) => {
      const faces: number[] = [];
      for (const dx of [0, 10]) {
        const box = kernel.copyAndTransformSolid(
          kernel.makeBox(2, 3, 4),
          Float64Array.of(1, 0, 0, dx, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
        );
        faces.push(...kernel.getSolidFaces(box));
      }
      return kernel.sewFaces(Uint32Array.from(faces), 1e-5);
    };

    const pipeline = new RemusKernel();
    expect(
      healPipelineSolid(pipeline, sewnPair(pipeline), ['unify_same_domain'])
    ).toBeNull();

    const checked = new RemusKernel();
    const report = unifyFacesReport(checked, sewnPair(checked));
    expect(report).toMatchObject({
      inputErrors: 0,
      resultErrors: 0,
      reverted: false
    });
  });
});
