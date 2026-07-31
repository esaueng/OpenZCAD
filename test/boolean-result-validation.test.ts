import { describe, expect, it } from 'vitest';
import {
  countFaceConnectedComponents,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh,
  selectSafelyUnifiedSolid
} from '../packages/kernel-adapter/src/boolean-result-validation';

const TETRAHEDRON_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const TETRAHEDRON_INDICES = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];

describe('boolean result validation', () => {
  it('counts exact face-connected components from edge adjacency', () => {
    expect(
      countFaceConnectedComponents([10, 20, 30, 40], {
        edgeA: [10, 20],
        edgeB: [20, 30],
        edgeC: [30],
        edgeD: [40]
      })
    ).toBe(2);
    expect(
      countFaceConnectedComponents([10, 20, 30], {
        edgeA: [10, 20],
        edgeB: [20, 30]
      })
    ).toBe(1);
  });

  it('accepts only closed, manifold, consistently wound triangle meshes', () => {
    const closed = inspectTriangleMeshClosure(
      TETRAHEDRON_POSITIONS,
      TETRAHEDRON_INDICES
    );
    expect(closed).toEqual({
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentWindingEdges: 0,
      triangles: 4
    });
    expect(isClosedConsistentlyOrientedMesh(closed)).toBe(true);

    const translatedAndScaled = inspectTriangleMeshClosure(
      TETRAHEDRON_POSITIONS.map(
        (value, index) => value * 1e6 + [1e9, -2e9, 5e8][index % 3]!
      ),
      TETRAHEDRON_INDICES
    );
    expect(isClosedConsistentlyOrientedMesh(translatedAndScaled)).toBe(true);

    const open = inspectTriangleMeshClosure(
      TETRAHEDRON_POSITIONS,
      TETRAHEDRON_INDICES.slice(0, 9)
    );
    expect(open.boundaryEdges).toBe(3);
    expect(isClosedConsistentlyOrientedMesh(open)).toBe(false);

    const reversedFace = inspectTriangleMeshClosure(TETRAHEDRON_POSITIONS, [
      0,
      1,
      2,
      ...TETRAHEDRON_INDICES.slice(3)
    ]);
    expect(reversedFace.inconsistentWindingEdges).toBe(3);
    expect(isClosedConsistentlyOrientedMesh(reversedFace)).toBe(false);

    const branching = inspectTriangleMeshClosure(TETRAHEDRON_POSITIONS, [
      ...TETRAHEDRON_INDICES,
      0,
      2,
      1
    ]);
    expect(branching.nonManifoldEdges).toBe(3);
    expect(isClosedConsistentlyOrientedMesh(branching)).toBe(false);
  });

  it('keeps the raw boolean when face unification degrades its copy', () => {
    const unified: number[] = [];
    const matrices: Float64Array[] = [];
    const kernel = {
      copyAndTransformSolid: (_solid: number, matrix: Float64Array) => {
        matrices.push(matrix);
        return 2;
      },
      unifyFaces: (solid: number) => {
        unified.push(solid);
        return 1;
      }
    };

    expect(selectSafelyUnifiedSolid(kernel, 1, (solid) => solid === 1)).toBe(1);
    expect(unified).toEqual([2]);
    expect(Array.from(matrices[0]!)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
    ]);
  });

  it('uses a face-unified copy only after it passes validation', () => {
    const kernel = {
      copyAndTransformSolid: () => 2,
      unifyFaces: () => 1
    };
    expect(selectSafelyUnifiedSolid(kernel, 1, (solid) => solid === 2)).toBe(2);
  });
});
