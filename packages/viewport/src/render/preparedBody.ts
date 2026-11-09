import type { GeometryBodyRepresentation } from '@openzcad/shared';
import type { SilhouetteCandidates } from './silhouette';

export interface ExactSmoothingLayout {
  sourceIndices: Uint32Array;
  sourceVertexCount: number;
  faceRanges: number[];
  renderSources: Uint32Array;
  normalSums: Float64Array;
}

export interface PreparedBodyGeometry {
  positions: Float32Array;
  normals: Float32Array;
  depth: Float32Array;
  indices: Uint16Array | Uint32Array;
  outline?: Float32Array;
  layout?: ExactSmoothingLayout;
}

export interface PreparedBody {
  geometry: PreparedBodyGeometry;
  tangentIds: Set<string>;
  silhouettes: SilhouetteCandidates | null;
}

// Keyed by the actual immutable projection, never by a persistent body id.
// Replacing or abandoning a projection releases its preparation with it.
export const preparedBodies = new WeakMap<
  GeometryBodyRepresentation,
  PreparedBody
>();
