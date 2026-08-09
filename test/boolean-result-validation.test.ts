import { describe, expect, it } from 'vitest';
import {
  countFaceConnectedComponents,
  droppedUnionOperandWarning,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh,
  selectSafelyUnifiedSolid
} from '../packages/kernel-adapter/src/boolean-result-validation';

const TETRAHEDRON_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const TETRAHEDRON_INDICES = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];

describe('boolean result validation', () => {
  it('diagnoses the exact extent lost by the M4 tangent-boss fuse', () => {
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Plate',
            bounds: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: 60, y: 40, z: 8 }
            }
          },
          {
            name: 'Boss',
            bounds: {
              min: { x: 0, y: 10, z: 0 },
              max: { x: 20, y: 30, z: 16 }
            }
          }
        ],
        result: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 60, y: 40, z: 8 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toBe(
      'Union dropped geometry from operand "Boss": the result\'s maximum z is 8 mm, but the operand reaches 16 mm (8 mm missing). A cylindrical boss can trigger this kernel failure at exact tangency; move the operand slightly off tangency while keeping positive overlap, then try again.'
    );
  });

  it('does not call a curved operand\'s facet sag "dropped geometry"', () => {
    // The reported case: a 12 mm-diameter cylinder fused to a box came back
    // faceted, so its polygonal wall inscribed 0.01232764 mm inside the exact
    // circle. The old bound allowed only 0.1% of the operand's span (0.012 mm)
    // and warned by a third of a micron, telling the user to move a body.
    // A faceted boundary may inscribe by up to the tessellation deflection,
    // which is what the operand is now allowed.
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Cylinder Body',
            bounds: {
              min: { x: -6, y: -6, z: 0 },
              max: { x: 6, y: 6, z: 24 }
            },
            curvedExtents: { min: { x: true } }
          }
        ],
        result: {
          min: { x: -5.987672, y: -6, z: 0 },
          max: { x: 6, y: 6, z: 24 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toBeNull();
  });

  it('still catches a curved operand losing more than the deflection', () => {
    // The allowance is the deflection, not a blank cheque: a drop an order of
    // magnitude past it is real geometry loss and must still be reported.
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Cylinder Body',
            bounds: {
              min: { x: -6, y: -6, z: 0 },
              max: { x: 6, y: 6, z: 24 }
            },
            curvedExtents: { min: { x: true } }
          }
        ],
        result: {
          min: { x: -5.1, y: -6, z: 0 },
          max: { x: 6, y: 6, z: 24 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toContain('Union dropped geometry from operand "Cylinder Body"');
  });

  it('keeps the tight bound for a planar operand, whose corners survive faceting', () => {
    // A box's extremes are vertices; faceting cannot inscribe them. A loss
    // there is real even when it is smaller than the deflection.
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Box Body',
            bounds: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: 30, y: 18, z: 24 }
            },
            curvedExtents: {}
          }
        ],
        result: {
          min: { x: 0.05, y: 0, z: 0 },
          max: { x: 30, y: 18, z: 24 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toContain('Union dropped geometry from operand "Box Body"');
  });

  it('keeps tight bounds on planar extrema of an otherwise curved operand', () => {
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Cylinder Body',
            bounds: {
              min: { x: -6, y: -6, z: 0 },
              max: { x: 6, y: 6, z: 24 }
            },
            curvedExtents: {
              min: { x: true, y: true },
              max: { x: true, y: true }
            }
          }
        ],
        result: {
          min: { x: -6, y: -6, z: 0 },
          max: { x: 6, y: 6, z: 23.95 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toContain('maximum z');
  });

  it('preserves contained, touching, overlapping, and crossing union extents', () => {
    const result = {
      min: { x: -3, y: 0, z: 0 },
      max: { x: 60, y: 40, z: 20 }
    };
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Plate',
            bounds: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: 60, y: 40, z: 8 }
            }
          },
          {
            name: 'Crossing boss',
            bounds: {
              min: { x: -3, y: 6, z: 0 },
              max: { x: 9, y: 18, z: 20 }
            }
          },
          {
            name: 'Contained insert',
            bounds: {
              min: { x: 10, y: 10, z: 1 },
              max: { x: 12, y: 12, z: 3 }
            }
          }
        ],
        result,
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toBeNull();
  });

  it('tolerates scale-aware AABB noise without hiding a material loss', () => {
    const operand = {
      name: 'Large body',
      bounds: {
        min: { x: 1_000_000, y: 0, z: 0 },
        max: { x: 2_000_000, y: 1_000_000, z: 1_000_000 }
      }
    };
    expect(
      droppedUnionOperandWarning({
        operands: [operand],
        result: {
          min: { ...operand.bounds.min },
          max: { ...operand.bounds.max, z: operand.bounds.max.z - 0.0001 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toBeNull();
    expect(
      droppedUnionOperandWarning({
        operands: [operand],
        result: {
          min: { ...operand.bounds.min },
          max: { ...operand.bounds.max, z: operand.bounds.max.z - 1 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toContain('1 mm missing');
  });

  it('leaves faceted curved-surface AABB shrinkage to the facet diagnostic', () => {
    expect(
      droppedUnionOperandWarning({
        operands: [
          {
            name: 'Cylinder',
            bounds: {
              min: { x: -20, y: -20, z: 0 },
              max: { x: 20, y: 20, z: 40 }
            }
          }
        ],
        result: {
          min: { x: -19.98754125, y: -20, z: 0 },
          max: { x: 20, y: 20, z: 40 }
        },
        units: 'mm',
        approximationTolerance: 0.08
      })
    ).toBeNull();
  });

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
