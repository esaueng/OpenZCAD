import { MAX_IMPORT_TRIANGLES, writeAsciiStl } from '@openzcad/io-stl';
import {
  decodeImportedMeshPayload,
  MAX_MESH_SOLID_CONVERSION_TRIANGLES,
  type ImportedMeshTriangles
} from '@openzcad/shared';
import type { ImportedMeshFeatureData } from './imported-mesh';

/** Validate the stored facets before building a reference or a solid. */
export function validateImportedMeshTriangles(
  feature: Pick<ImportedMeshFeatureData, 'triangleCount'> &
    ImportedMeshTriangles
): void {
  if (
    !Number.isSafeInteger(feature.triangleCount) ||
    feature.triangleCount < 0 ||
    feature.triangleCount > MAX_IMPORT_TRIANGLES ||
    feature.indices.length !== feature.triangleCount * 3 ||
    feature.vertices.length % 3 !== 0 ||
    (feature.triangleCount > MAX_MESH_SOLID_CONVERSION_TRIANGLES &&
      feature.vertices.length > feature.triangleCount * 9)
  ) {
    throw new Error(
      'Imported mesh data is malformed or exceeds the import limit.'
    );
  }
  for (let index = 0; index < feature.vertices.length; index++) {
    if (!Number.isFinite(feature.vertices[index])) {
      throw new Error(
        'Imported mesh data is malformed or exceeds the import limit.'
      );
    }
  }
  const vertexCount = feature.vertices.length / 3;
  for (let offset = 0; offset < feature.indices.length; offset += 3) {
    const a = feature.indices[offset]!;
    const b = feature.indices[offset + 1]!;
    const c = feature.indices[offset + 2]!;
    if (
      a === b ||
      b === c ||
      c === a ||
      !Number.isSafeInteger(a) ||
      a < 0 ||
      a >= vertexCount ||
      !Number.isSafeInteger(b) ||
      b < 0 ||
      b >= vertexCount ||
      !Number.isSafeInteger(c) ||
      c < 0 ||
      c >= vertexCount
    ) {
      throw new Error('Imported mesh contains an invalid triangle index.');
    }
  }
}

/** The kernel's STL importer owns welding and shell orientation for solids. */
export function importedMeshStl(
  feature: Pick<ImportedMeshFeatureData, 'sourceName' | 'triangleCount'> &
    ImportedMeshTriangles
): string {
  validateImportedMeshTriangles(feature);
  return writeAsciiStl(feature.sourceName, [
    {
      name: feature.sourceName,
      vertices: feature.vertices,
      indices: feature.indices
    }
  ]);
}

/**
 * The triangles an imported mesh feature rebuilds from, whichever form it
 * stores them in: embedded, or decoded from the payload its reference names.
 *
 * `payloads` holds the bytes the adapter fetched for reference-form imports,
 * keyed by checksum. A missing entry means this device could neither find the
 * payload locally nor fetch it, which is reported against the feature by name
 * rather than left to read as a malformed mesh.
 */
export function importedMeshTriangles(
  data: ImportedMeshFeatureData,
  payloads: ReadonlyMap<string, Uint8Array>
): ImportedMeshTriangles {
  // Embedded data wins over a reference, as `stepText` always has.
  if (data.vertices && data.indices) {
    if (data.triangleCount > MAX_MESH_SOLID_CONVERSION_TRIANGLES) {
      throw new Error('Large imported meshes require a stored mesh payload.');
    }
    return { vertices: data.vertices, indices: data.indices };
  }
  if (data.meshPayloadRef) {
    const bytes = payloads.get(data.meshPayloadRef.checksumSha256);
    if (!bytes) {
      throw new Error(
        `Mesh data for "${data.sourceName}" is not available on this device.`
      );
    }
    return decodeImportedMeshPayload(bytes);
  }
  throw new Error(
    'Imported mesh data is malformed or exceeds the import limit.'
  );
}
