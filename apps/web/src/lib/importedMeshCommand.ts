import { commandFactories } from '@openzcad/command-system';
import type { BodyFeatureIds } from '@openzcad/document-core';
import { UNIT_TO_MM, type UnitSystem } from '@openzcad/shared';

/** A mesh as every importer hands it over. */
export interface MillimetreMesh {
  name: string;
  triangleCount: number;
  /** Millimetres, whatever the file declared. */
  vertices: number[];
  indices: number[];
}

/**
 * The `imported-mesh` command for a mesh read in millimetres, adopted into the
 * document's units.
 *
 * Every importer produces millimetres: a 3MF's declared unit and glTF's metres
 * are applied by the importer, and STL, OBJ and PLY declare none, so they
 * follow the STL interchange convention. The mesh exports multiply by
 * UNIT_TO_MM on the way out, so adopting the vertices at 1/UNIT_TO_MM keeps a
 * non-mm document's round trip at the same physical size.
 *
 * Every mesh import builds its command here, STL preview and commit included:
 * the STL arm once built its own, skipped the scaling, and landed a 25.4 mm
 * cube as 25.4 in in an inch project.
 */
export function importedMeshCommand(
  mesh: MillimetreMesh,
  units: UnitSystem,
  artifactId: string,
  ids?: BodyFeatureIds
) {
  const scale = 1 / UNIT_TO_MM[units];
  return commandFactories.importMesh({
    name: mesh.name,
    artifactId,
    sourceName: mesh.name,
    triangleCount: mesh.triangleCount,
    vertices:
      scale === 1 ? mesh.vertices : mesh.vertices.map((value) => value * scale),
    indices: mesh.indices,
    ids
  });
}
