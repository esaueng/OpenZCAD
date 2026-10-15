import { MAX_IMPORT_TRIANGLES, writeAsciiStl } from '@openzcad/io-stl';
import {
  decodeImportedMeshPayload,
  type ImportedMeshTriangles
} from '@openzcad/shared';
import type { ImportedMeshFeatureData } from './imported-mesh';

/**
 * The single mesh handoff between a document and a kernel.
 *
 * An `imported-mesh` feature stores the triangle soup the STL parser produced.
 * Both exact kernels take meshes back in through their own STL importer — that
 * importer owns vertex welding and shell orientation, so the adapter must not
 * invent a second, divergent mesh-to-B-rep path. Serializing to ASCII STL here
 * keeps exactly one conversion in the tree.
 */
export function importedMeshStl(
  feature: Pick<ImportedMeshFeatureData, 'sourceName' | 'triangleCount'> &
    ImportedMeshTriangles
): string {
  if (
    !Number.isSafeInteger(feature.triangleCount) ||
    feature.triangleCount < 0 ||
    feature.triangleCount > MAX_IMPORT_TRIANGLES ||
    feature.indices.length !== feature.triangleCount * 3 ||
    feature.vertices.length % 3 !== 0 ||
    Array.prototype.some.call(
      feature.vertices,
      (value: number) => !Number.isFinite(value)
    )
  ) {
    throw new Error(
      'Imported mesh data is malformed or exceeds the import limit.'
    );
  }
  const vertexCount = feature.vertices.length / 3;
  for (let offset = 0; offset < feature.indices.length; offset += 3) {
    const triangle = [
      feature.indices[offset]!,
      feature.indices[offset + 1]!,
      feature.indices[offset + 2]!
    ];
    if (
      triangle.some(
        (index) =>
          !Number.isSafeInteger(index) || index < 0 || index >= vertexCount
      ) ||
      new Set(triangle).size !== 3
    ) {
      throw new Error('Imported mesh contains an invalid triangle index.');
    }
  }
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
