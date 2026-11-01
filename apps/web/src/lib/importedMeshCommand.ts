import { commandFactories } from '@openzcad/command-system';
import type { BodyFeatureIds } from '@openzcad/document-core';
import {
  UNIT_TO_MM,
  type ImportedSourceReference,
  type UnitSystem
} from '@openzcad/shared';

/** A mesh as every importer hands it over. */
export interface MillimetreMesh {
  name: string;
  triangleCount: number;
  /** Millimetres, whatever the file declared. */
  vertices: number[];
  indices: number[];
}

/** Triangles in the units of the document they are about to join. */
export interface DocumentUnitTriangles {
  vertices: number[];
  indices: number[];
}

/**
 * Where an imported mesh's triangles live: embedded in the feature, or in the
 * source blob store behind a content-addressed reference
 * (`holdImportedMeshPayload`).
 */
export type ImportedMeshPayloadForm =
  DocumentUnitTriangles | { meshPayloadRef: ImportedSourceReference };

/**
 * A millimetre mesh adopted into the document's units.
 *
 * Every importer produces millimetres: a 3MF's declared unit and glTF's metres
 * are applied by the importer, and STL, OBJ and PLY declare none, so they
 * follow the STL interchange convention. The mesh exports multiply by
 * UNIT_TO_MM on the way out, so adopting the vertices at 1/UNIT_TO_MM keeps a
 * non-mm document's round trip at the same physical size.
 *
 * Every mesh import scales here, STL preview and commit included: the STL arm
 * once built its own command, skipped the scaling, and landed a 25.4 mm cube
 * as 25.4 in in an inch project. The payload a reference names is encoded
 * from this result, so the reference and the embedded form hold the same
 * numbers.
 */
export function meshInDocumentUnits(
  mesh: MillimetreMesh,
  units: UnitSystem
): DocumentUnitTriangles {
  const scale = 1 / UNIT_TO_MM[units];
  return {
    vertices:
      scale === 1 ? mesh.vertices : mesh.vertices.map((value) => value * scale),
    indices: mesh.indices
  };
}

/**
 * The `imported-mesh` command for a mesh whose triangles are already in
 * document units — embedded, or by reference. Every mesh import builds its
 * command here, so a body from a 3MF is indistinguishable downstream from one
 * out of an STL.
 */
export function importedMeshCommand(
  mesh: Pick<MillimetreMesh, 'name' | 'triangleCount'> & {
    /** The unit a file that stated none was read in, recorded on the feature. */
    assumedUnits?: UnitSystem;
  },
  payload: ImportedMeshPayloadForm,
  artifactId: string,
  ids?: BodyFeatureIds
) {
  return commandFactories.importMesh({
    name: mesh.name,
    artifactId,
    sourceName: mesh.name,
    triangleCount: mesh.triangleCount,
    ...('meshPayloadRef' in payload
      ? { meshPayloadRef: payload.meshPayloadRef }
      : { vertices: payload.vertices, indices: payload.indices }),
    ...(mesh.assumedUnits ? { assumedUnits: mesh.assumedUnits } : {}),
    ids
  });
}
