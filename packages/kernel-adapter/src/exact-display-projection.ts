import type { BodyRepresentation } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { displayTessellationForExtents } from './display-tessellation';

/** A bounded, disposable upstream display. No topology, validation or exports. */
export function projectShapeMesh(
  kernel: RemusKernel,
  shape: ExactShape,
  maxBytes: number
): Pick<BodyRepresentation, 'mesh' | 'bbox'> {
  const vertices: Float32Array[] = [],
    indices: Uint32Array[] = [];
  let vertexCount = 0,
    indexCount = 0;
  const bbox = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };
  for (const solid of shape.solids) {
    const b = kernel.boundingBox(solid);
    const tess = displayTessellationForExtents(
      b[3]! - b[0]!,
      b[4]! - b[1]!,
      b[5]! - b[2]!
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid,
      tess.linearDeflection,
      tess.angularDeflection
    );
    try {
      // WASM accessors materialize arrays. Read each once before iterating.
      const sourcePositions = mesh.positions;
      const sourceIndices = mesh.indices;
      if (
        (vertexCount +
          indexCount +
          sourcePositions.length +
          sourceIndices.length) *
          4 >
        maxBytes
      )
        throw new Error('Upstream display exceeds its memory budget.');
      const positions = sourcePositions.slice();
      const shifted = new Uint32Array(sourceIndices.length);
      for (let i = 0; i < shifted.length; i++)
        shifted[i] = sourceIndices[i]! + vertexCount / 3;
      vertices.push(positions);
      indices.push(shifted);
      vertexCount += positions.length;
      indexCount += shifted.length;
    } finally {
      mesh.free();
    }
    (['x', 'y', 'z'] as const).forEach((axis, i) => {
      bbox.min[axis] = Math.min(bbox.min[axis], b[i]!);
      bbox.max[axis] = Math.max(bbox.max[axis], b[i + 3]!);
    });
  }
  const positions = new Float32Array(vertexCount),
    triangles = new Uint32Array(indexCount);
  let offset = 0;
  for (const chunk of vertices) {
    positions.set(chunk, offset);
    offset += chunk.length;
  }
  offset = 0;
  for (const chunk of indices) {
    triangles.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    bbox,
    mesh: { kind: 'mesh', vertices: positions, indices: triangles }
  };
}
