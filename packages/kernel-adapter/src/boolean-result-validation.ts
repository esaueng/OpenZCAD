export interface TriangleMeshClosure {
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentWindingEdges: number;
  triangles: number;
}

interface MeshEdgeUse {
  count: number;
  directionBalance: number;
}

const POSITION_QUANTIZATION = 1e-4;
const IDENTITY_MATRIX = new Float64Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
]);

/**
 * Inspect a disposable triangle projection after welding coincident vertices.
 * A solid mesh has two oppositely directed triangle uses for every edge.
 */
export function inspectTriangleMeshClosure(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>
): TriangleMeshClosure {
  const quantize = (value: number): number =>
    Math.round(value / POSITION_QUANTIZATION);
  const vertexKey = (index: number): string => {
    const offset = index * 3;
    return `${quantize(positions[offset] ?? 0)},${quantize(
      positions[offset + 1] ?? 0
    )},${quantize(positions[offset + 2] ?? 0)}`;
  };

  const edgeUses = new Map<string, MeshEdgeUse>();
  let triangles = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const vertices = [
      vertexKey(indices[index] ?? 0),
      vertexKey(indices[index + 1] ?? 0),
      vertexKey(indices[index + 2] ?? 0)
    ];
    if (new Set(vertices).size !== 3) {
      continue;
    }
    triangles += 1;
    for (const [start, end] of [
      [vertices[0]!, vertices[1]!],
      [vertices[1]!, vertices[2]!],
      [vertices[2]!, vertices[0]!]
    ] as const) {
      const forward = start < end;
      const key = forward ? `${start}|${end}` : `${end}|${start}`;
      const use = edgeUses.get(key) ?? { count: 0, directionBalance: 0 };
      use.count += 1;
      use.directionBalance += forward ? 1 : -1;
      edgeUses.set(key, use);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentWindingEdges = 0;
  for (const use of edgeUses.values()) {
    if (use.count === 1) {
      boundaryEdges += 1;
    } else if (use.count > 2) {
      nonManifoldEdges += 1;
    } else if (Math.abs(use.directionBalance) === 2) {
      inconsistentWindingEdges += 1;
    }
  }
  return {
    boundaryEdges,
    nonManifoldEdges,
    inconsistentWindingEdges,
    triangles
  };
}

export function isClosedConsistentlyOrientedMesh(
  closure: TriangleMeshClosure
): boolean {
  return (
    closure.triangles > 0 &&
    closure.boundaryEdges === 0 &&
    closure.nonManifoldEdges === 0 &&
    closure.inconsistentWindingEdges === 0
  );
}

interface BooleanFaceUnifier {
  copyAndTransformSolid(solid: number, matrix: Float64Array): number;
  unifyFaces(solid: number): number;
}

/**
 * Face healing mutates a solid in place. Run it on a copy and keep the raw
 * boolean whenever healing throws or degrades an otherwise usable result.
 */
export function selectSafelyUnifiedSolid(
  kernel: BooleanFaceUnifier,
  rawSolid: number,
  isAcceptable: (solid: number) => boolean
): number {
  try {
    const candidate = kernel.copyAndTransformSolid(rawSolid, IDENTITY_MATRIX);
    kernel.unifyFaces(candidate);
    if (isAcceptable(candidate)) {
      return candidate;
    }
  } catch {
    // The raw result is still available because healing ran on a copy.
  }
  return rawSolid;
}
