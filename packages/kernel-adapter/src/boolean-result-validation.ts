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

const POSITION_QUANTIZATION_RATIO = 1e-6;
const MIN_POSITION_QUANTIZATION = 1e-9;
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
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let maximumMagnitude = 0;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      if (!Number.isFinite(value)) {
        continue;
      }
      minimum[axis] = Math.min(minimum[axis]!, value);
      maximum[axis] = Math.max(maximum[axis]!, value);
      maximumMagnitude = Math.max(maximumMagnitude, Math.abs(value));
    }
  }
  const extent = Math.max(
    ...minimum.map((value, axis) => maximum[axis]! - value),
    0
  );
  // The projection crosses WASM as f32. Weld at one part per million of the
  // body extent, while accounting for f32 precision loss far from the origin.
  const positionQuantization = Math.max(
    MIN_POSITION_QUANTIZATION,
    extent * POSITION_QUANTIZATION_RATIO,
    maximumMagnitude * 2 ** -22
  );
  const quantize = (value: number): number =>
    Math.round(value / positionQuantization);
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

/**
 * Count face-connected components from a solid's exact edge-to-face adjacency.
 * This is a stronger contact oracle than vertex/face distance for solids that
 * meet across the interiors of coplanar faces, where neither operand has a
 * vertex on the other's boundary.
 */
export function countFaceConnectedComponents(
  faceHandles: ArrayLike<number>,
  edgeToFaces: Readonly<Record<string, readonly number[]>>
): number {
  const faces = [...new Set(Array.from(faceHandles))];
  if (faces.length === 0) {
    return 0;
  }

  const faceSet = new Set(faces);
  const parent = new Map(faces.map((face) => [face, face]));
  const rank = new Map(faces.map((face) => [face, 0]));
  const find = (face: number): number => {
    let root = face;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let current = face;
    while (parent.get(current) !== current) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    if (rank.get(leftRoot)! < rank.get(rightRoot)!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent.set(rightRoot, leftRoot);
    if (rank.get(leftRoot) === rank.get(rightRoot)) {
      rank.set(leftRoot, rank.get(leftRoot)! + 1);
    }
  };

  for (const adjacentFaces of Object.values(edgeToFaces)) {
    const connectedFaces = adjacentFaces.filter((face) => faceSet.has(face));
    const first = connectedFaces[0];
    if (first === undefined) {
      continue;
    }
    for (let index = 1; index < connectedFaces.length; index += 1) {
      union(first, connectedFaces[index]!);
    }
  }

  return new Set(faces.map((face) => find(face))).size;
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
