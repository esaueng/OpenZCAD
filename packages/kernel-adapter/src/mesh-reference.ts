import type { BoundingBox, MeshGeometry } from '@openzcad/shared';
import type { ExactShape } from './exact-types';

type ReferenceMesh = NonNullable<ExactShape['referenceMesh']>;

/** Own display buffers; retain the Float64 source for replay and export. */
export function projectReferenceMesh(source: ReferenceMesh): {
  mesh: MeshGeometry;
  bbox: BoundingBox;
} {
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
    mesh: { kind: 'mesh', vertices, indices: source.indices.slice() },
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
