/**
 * Draft display meshes for released direct edits, and their refinement.
 *
 * A face drag already meshes its frames at the drag tessellation
 * (`previewDisplayTessellation`). The commit that accepts the release keeps
 * every check it always ran — kernel validation, the edit's own guards,
 * strict-union closure — and its exact topology, face/edge measurements and
 * volume, but may draw the edited body with that same drag tessellation, so
 * the full-quality display mesh (the largest single cost of a warm commit)
 * is not on the path to "accepted". The next complete sync of the same
 * shape swaps in the full-quality mesh here, keeping everything else.
 *
 * Both paths publish the box through {@link publishedSolidBounds}, so a
 * refined body is exactly what a full-quality measurement would publish.
 */
import type { RemusKernel } from './remus-runtime';
import type { ExactShape, MeasuredShape } from './exact-types';
import {
  displayTessellationForExtents,
  heldDisplayTessellation,
  type DisplayTessellation
} from './display-tessellation';
import { refineBoundsAtSplineFaces, tightenBoundsToMesh } from './exact-bounds';
import {
  ownedMeshFaceOffsets,
  ownedMeshIndices,
  ownedMeshPositions
} from './owned-mesh-output';
import { inspectTriangleMeshClosure } from './boolean-result-validation';

/** The full-quality display tessellation of one solid with these bounds. */
export function solidDisplayTessellation(
  bounds: ArrayLike<number>,
  heldLinearDeflection: number | undefined
): DisplayTessellation {
  return heldDisplayTessellation(
    displayTessellationForExtents(
      bounds[3]! - bounds[0]!,
      bounds[4]! - bounds[1]!,
      bounds[5]! - bounds[2]!
    ),
    heldLinearDeflection
  );
}

/**
 * One solid's published box: the kernel's, tightened to its grouped display
 * mesh, and (at full display quality) certified at trimmed spline faces.
 * A draft mesh skips the spline certification, as a drag frame does: it may
 * re-mesh down to a sixteenth of the deflection, which is the cost a draft
 * exists to avoid. Its tightening slack is the draft deflection, so the box
 * stays a valid bound; the refinement publishes the certified one.
 */
export function publishedSolidBounds(
  kernel: RemusKernel,
  solid: number,
  kernelBounds: ArrayLike<number>,
  mesh: {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    faceOffsets: ArrayLike<number>;
  },
  surfaceTypes: readonly string[],
  tessellation: DisplayTessellation,
  certifySplineFaces: boolean
): readonly number[] {
  const tightened = tightenBoundsToMesh(
    kernelBounds,
    mesh.positions,
    tessellation.linearDeflection
  );
  if (!certifySplineFaces) return tightened;
  return refineBoundsAtSplineFaces(
    tightened,
    mesh,
    surfaceTypes.map((surfaceType) => ({ surfaceType })),
    tessellation.linearDeflection,
    (deflection) => {
      const fine = kernel.tessellateSolidGroupedBinary(
        solid,
        deflection,
        tessellation.angularDeflection
      );
      try {
        return {
          positions: ownedMeshPositions(fine),
          indices: ownedMeshIndices(fine),
          faceOffsets: Array.from(ownedMeshFaceOffsets(fine))
        };
      } finally {
        fine.free();
      }
    }
  );
}

/**
 * The full-quality display of a draft measurement: the same solids meshed at
 * the deflections the measurement recorded, with each face's triangle range
 * and the published box replaced. Topology identities, measurements, edges,
 * volume and validation verdicts are carried unchanged. Throws if the mesh
 * groups no longer line up with the measured faces; the caller treats that
 * like any other measurement-cache inconsistency.
 */
export function refineDraftDisplay<T extends Omit<MeasuredShape, 'volume'>>(
  kernel: RemusKernel,
  shape: ExactShape,
  measured: T
): T {
  const vertexChunks: Float32Array[] = [];
  const indexChunks: Uint32Array[] = [];
  let vertexFloatCount = 0;
  let indexCount = 0;
  const bbox = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };
  const faces = measured.topology.faces;
  const ranges: { triangleStart: number; triangleCount: number }[] = [];
  shape.solids.forEach((solid, solidIndex) => {
    const bounds = kernel.boundingBox(solid);
    const tessellation = solidDisplayTessellation(
      bounds,
      measured.displayLinearDeflections?.[solidIndex]
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid,
      tessellation.linearDeflection,
      tessellation.angularDeflection
    );
    try {
      const positions = ownedMeshPositions(mesh);
      const meshIndices = ownedMeshIndices(mesh);
      const faceOffsets = Array.from(ownedMeshFaceOffsets(mesh));
      const firstFace = ranges.length;
      const faceTotal = faceOffsets.length - 1;
      if (firstFace + faceTotal > faces.length)
        throw new Error('Draft display faces do not match the refined mesh.');
      const indexOffset = indexCount;
      for (let index = 0; index < faceTotal; index += 1)
        ranges.push({
          triangleStart: (indexOffset + faceOffsets[index]!) / 3,
          triangleCount: (faceOffsets[index + 1]! - faceOffsets[index]!) / 3
        });
      const published = publishedSolidBounds(
        kernel,
        solid,
        bounds,
        { positions, indices: meshIndices, faceOffsets },
        faces
          .slice(firstFace, firstFace + faceTotal)
          .map((face) => face.geometry?.surfaceType ?? ''),
        tessellation,
        true
      );
      const vertexOffset = vertexFloatCount / 3;
      const shifted =
        vertexOffset === 0 ? meshIndices : new Uint32Array(meshIndices.length);
      if (vertexOffset !== 0)
        for (let i = 0; i < meshIndices.length; i += 1)
          shifted[i] = meshIndices[i]! + vertexOffset;
      vertexChunks.push(positions);
      indexChunks.push(shifted);
      vertexFloatCount += positions.length;
      indexCount += shifted.length;
      bbox.min.x = Math.min(bbox.min.x, published[0]!);
      bbox.min.y = Math.min(bbox.min.y, published[1]!);
      bbox.min.z = Math.min(bbox.min.z, published[2]!);
      bbox.max.x = Math.max(bbox.max.x, published[3]!);
      bbox.max.y = Math.max(bbox.max.y, published[4]!);
      bbox.max.z = Math.max(bbox.max.z, published[5]!);
    } finally {
      mesh.free();
    }
  });
  if (ranges.length !== faces.length)
    throw new Error('Draft display faces do not match the refined mesh.');
  const vertices =
    vertexChunks.length === 1
      ? vertexChunks[0]!
      : new Float32Array(vertexFloatCount);
  const indices =
    indexChunks.length === 1 ? indexChunks[0]! : new Uint32Array(indexCount);
  if (vertexChunks.length !== 1) {
    let offset = 0;
    for (const chunk of vertexChunks) {
      vertices.set(chunk, offset);
      offset += chunk.length;
    }
    offset = 0;
    for (const chunk of indexChunks) {
      indices.set(chunk, offset);
      offset += chunk.length;
    }
  }
  const { draftDisplay: _draft, ...complete } = measured;
  return {
    ...complete,
    vertices,
    indices,
    bbox,
    // A strict union is never drafted; recompute rather than carry a
    // closure verdict about a mesh that is no longer the published one.
    meshClosure:
      measured.meshClosure === null
        ? null
        : inspectTriangleMeshClosure(vertices, indices),
    topology: {
      ...measured.topology,
      faces: faces.map((face, index) => ({ ...face, ...ranges[index]! }))
    }
  } as T;
}
