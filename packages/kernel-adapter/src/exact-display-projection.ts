import type { BodyRepresentation } from '@openzcad/shared';
import { profileDirectEditStage } from './direct-edit-profile';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import {
  displayTessellationForExtents,
  heldDisplayTessellation,
  previewDisplayTessellation
} from './display-tessellation';
import { tightenBoundsToMesh, refineBoundsAtSplineFaces } from './exact-bounds';
import { surfaceTypeOf } from './exact-sync-memo';
import {
  ownedMeshPositions,
  ownedMeshIndices,
  ownedMeshFaceOffsets
} from './owned-mesh-output';
import {
  takeUnionDisplayMeshForMeasurement,
  type StrictUnionVerdict
} from './exact-boolean-helpers';

/** Bounded display buffers and optional face ranges; acceptance stays with the caller. */
export function projectShapeMesh(
  kernel: RemusKernel,
  shape: ExactShape,
  maxBytes: number,
  heldLinearDeflections: readonly number[] = [],
  verdicts?: ReadonlyMap<number, StrictUnionVerdict>,
  includeFaces = false,
  preview = false
): Pick<BodyRepresentation, 'mesh' | 'bbox'> & {
  linearDeflections: number[];
  closureValidated: boolean;
  faceGroups: {
    handle: number;
    triangleStart: number;
    triangleCount: number;
  }[];
} {
  if (!shape.solids.length) throw new Error('Exact body contains no solids.');
  const vertices: Float32Array[] = [],
    indices: Uint32Array[] = [];
  let vertexCount = 0,
    indexCount = 0;
  const linearDeflections: number[] = [];
  let closureValidated = false;
  const faceGroups: {
    handle: number;
    triangleStart: number;
    triangleCount: number;
  }[] = [];
  const bbox = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };
  for (const solid of shape.solids) {
    const kernelBounds = kernel.boundingBox(solid);
    let b: readonly number[] = Array.from(kernelBounds);
    const fullQuality = heldDisplayTessellation(
      displayTessellationForExtents(
        b[3]! - b[0]!,
        b[4]! - b[1]!,
        b[5]! - b[2]!
      ),
      heldLinearDeflections[linearDeflections.length]
    );
    const tess = preview
      ? previewDisplayTessellation(fullQuality)
      : fullQuality;
    linearDeflections.push(tess.linearDeflection);
    const verdict = verdicts?.get(solid);
    const retained = takeUnionDisplayMeshForMeasurement(
      verdict,
      kernel,
      solid,
      tess.linearDeflection,
      tess.angularDeflection
    );
    const mesh =
      retained ??
      kernel.tessellateSolidGroupedBinary(
        solid,
        tess.linearDeflection,
        tess.angularDeflection
      );
    // Only a matching, same-sync, single-solid projection carries its closure
    // proof. Compound assembly still needs the combined mesh checked.
    closureValidated =
      shape.solids.length === 1 &&
      retained !== undefined &&
      verdict?.meshClosed === true;
    try {
      // WASM accessors materialize arrays. Read each once before iterating.
      const sourcePositions = profileDirectEditStage('meshPositions', () =>
        ownedMeshPositions(mesh)
      );
      const sourceIndices = profileDirectEditStage('meshIndices', () =>
        ownedMeshIndices(mesh)
      );
      let boundsFaces: { surfaceType: string }[] | undefined;
      let faceOffsets: Uint32Array | undefined;
      if (includeFaces) {
        const handles = kernel.getSolidFaces(solid),
          offsets = ownedMeshFaceOffsets(mesh);
        if (handles.length !== offsets.length - 1)
          throw new Error('Face handles do not match tessellation groups.');
        faceOffsets = offsets;
        boundsFaces = Array.from(handles, (handle) => ({
          surfaceType: surfaceTypeOf(kernel, handle)
        }));
        for (let i = 0; i < handles.length; i++)
          faceGroups.push({
            handle: handles[i]!,
            triangleStart: (indexCount + offsets[i]!) / 3,
            triangleCount: (offsets[i + 1]! - offsets[i]!) / 3
          });
      }
      if (
        (vertexCount +
          indexCount +
          sourcePositions.length +
          sourceIndices.length) *
          4 >
        maxBytes
      )
        throw new Error('Upstream display exceeds its memory budget.');
      const positions = sourcePositions;
      b = tightenBoundsToMesh(kernelBounds, positions, tess.linearDeflection);
      if (!preview && boundsFaces && faceOffsets) {
        // Same certification as completed measurement. A trimmed spline can
        // leave a sub-deflection gap that ordinary mesh tightening must keep.
        b = profileDirectEditStage('refineBounds', () =>
          refineBoundsAtSplineFaces(
            b,
            { positions, indices: sourceIndices, faceOffsets },
            boundsFaces,
            tess.linearDeflection,
            (deflection) => {
              const fine = kernel.tessellateSolidGroupedBinary(
                solid,
                deflection,
                tess.angularDeflection
              );
              try {
                return {
                  positions: ownedMeshPositions(fine),
                  indices: ownedMeshIndices(fine),
                  faceOffsets: ownedMeshFaceOffsets(fine)
                };
              } finally {
                fine.free();
              }
            }
          )
        );
      }
      const shifted =
        vertexCount === 0
          ? sourceIndices
          : new Uint32Array(sourceIndices.length);
      if (vertexCount !== 0)
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
  const positions =
      vertices.length === 1 ? vertices[0]! : new Float32Array(vertexCount),
    triangles =
      indices.length === 1 ? indices[0]! : new Uint32Array(indexCount);
  let offset = 0;
  for (const chunk of vertices.length === 1 ? [] : vertices) {
    positions.set(chunk, offset);
    offset += chunk.length;
  }
  offset = 0;
  for (const chunk of indices.length === 1 ? [] : indices) {
    triangles.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    linearDeflections,
    closureValidated,
    faceGroups,
    bbox,
    mesh: { kind: 'mesh', vertices: positions, indices: triangles }
  };
}
