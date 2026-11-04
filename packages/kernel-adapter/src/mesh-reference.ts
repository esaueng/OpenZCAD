import type { BoundingBox, MeshGeometry } from '@openzcad/shared';
import type { ExactShape } from './exact-types';

type ReferenceMesh = NonNullable<ExactShape['referenceMesh']>;

interface ReferenceDisplay {
  vertices: Float32Array;
  indices: Uint32Array;
  bbox: BoundingBox;
}

/**
 * Display projections by source mesh. Reference meshes are immutable (the
 * history cache and the imported-mesh cache share them across rebuilds), so
 * one projection serves every sync of the same object, and it goes when the
 * mesh does.
 */
const projections = new WeakMap<ReferenceMesh, ReferenceDisplay>();

/**
 * Own display buffers; retain the Float64 source for replay and export.
 *
 * A derived state is caller-owned and may be mutated or transferred, so
 * every call returns fresh buffers; a repeat call copies the kept
 * projection instead of narrowing and scanning the source again.
 */
export function projectReferenceMesh(source: ReferenceMesh): {
  mesh: MeshGeometry;
  bbox: BoundingBox;
} {
  const kept = projections.get(source) ?? project(source);
  projections.set(source, kept);
  return {
    mesh: {
      kind: 'mesh',
      vertices: kept.vertices.slice(),
      indices: kept.indices.slice()
    },
    bbox: { min: { ...kept.bbox.min }, max: { ...kept.bbox.max } }
  };
}

function project(source: ReferenceMesh): ReferenceDisplay {
  const vertices = Float32Array.from(source.vertices);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    if (!Number.isFinite(vertices[i])) {
      throw new Error('Mesh coordinates exceed the browser display range.');
    }
    const axis = i % 3;
    min[axis] = Math.min(min[axis]!, source.vertices[i]!);
    max[axis] = Math.max(max[axis]!, source.vertices[i]!);
  }
  return {
    vertices,
    indices: source.indices.slice(),
    bbox: {
      min: { x: min[0]!, y: min[1]!, z: min[2]! },
      max: { x: max[0]!, y: max[1]!, z: max[2]! }
    }
  };
}

/** Apply the same row-major affine transform as the exact kernel. */
export function transformReferenceMesh(
  source: ReferenceMesh,
  matrix: Float64Array
): ReferenceMesh {
  const vertices = new Float64Array(source.vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    const x = source.vertices[i]!,
      y = source.vertices[i + 1]!,
      z = source.vertices[i + 2]!;
    for (let row = 0; row < 3; row++) {
      const j = row * 4;
      vertices[i + row] =
        matrix[j]! * x +
        matrix[j + 1]! * y +
        matrix[j + 2]! * z +
        matrix[j + 3]!;
    }
  }
  return { vertices, indices: source.indices };
}
