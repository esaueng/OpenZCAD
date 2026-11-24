import type { RemusKernel } from './remus-runtime';

/** The viewport generates its own per-face shading normals. */
export function groupedDisplayMesh(
  kernel: RemusKernel,
  solid: number,
  linear: number,
  angular: number
) {
  const bindings = kernel as RemusKernel & {
    tessellateSolidGroupedPositions?: RemusKernel['tessellateSolidGroupedBinary'];
  };
  return bindings.tessellateSolidGroupedPositions
    ? bindings.tessellateSolidGroupedPositions(solid, linear, angular)
    : kernel.tessellateSolidGroupedBinary(solid, linear, angular);
}

/** Getters and consume-once outputs both return owned JS arrays. */
export function ownedMeshPositions<T extends { positions: Float32Array }>(
  mesh: T
): Float32Array {
  const output = mesh as T & { takePositions?: () => Float32Array };
  return output.takePositions ? output.takePositions() : output.positions;
}

export function ownedMeshIndices<T extends { indices: Uint32Array }>(
  mesh: T
): Uint32Array {
  const output = mesh as T & { takeIndices?: () => Uint32Array };
  return output.takeIndices ? output.takeIndices() : output.indices;
}

export function ownedMeshFaceOffsets<T extends { faceOffsets: Uint32Array }>(
  mesh: T
): Uint32Array {
  const output = mesh as T & { takeFaceOffsets?: () => Uint32Array };
  return output.takeFaceOffsets ? output.takeFaceOffsets() : output.faceOffsets;
}
