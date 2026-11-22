export interface PatternMesh {
  positions: Float32Array;
  indices: Uint32Array;
  faceOffsets: Uint32Array;
}

export const MAX_PATTERN_MESH_BYTES = 2 * 1024 * 1024;
