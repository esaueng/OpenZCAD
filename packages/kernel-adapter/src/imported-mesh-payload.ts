import { MAX_IMPORT_TRIANGLES, writeAsciiStl } from '@openzcad/io-stl';
import {
  decodeImportedMeshPayload,
  MAX_MESH_SOLID_CONVERSION_TRIANGLES,
  millimetresPerUnit,
  type ImportedMeshTriangles,
  type UnitSystem
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
 *
 * A payload stored in other units than the document's (`payloadUnits`, I03)
 * is scaled into `documentUnits` here, the one place every consumer — the
 * solid conversion, the reference-mesh fallback, and through them display,
 * export and analysis — reads it from. Embedded triangles are always in
 * document units and are returned untouched.
 */
export function importedMeshTriangles(
  data: ImportedMeshFeatureData,
  payloads: ReadonlyMap<string, Uint8Array>,
  documentUnits: UnitSystem
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
    const decoded = decodeImportedMeshPayload(bytes);
    const scale = importedMeshPayloadScale(data, documentUnits);
    // The decoder hands back views on its own copy, so scaling in place
    // never touches the fetched bytes another feature may share.
    if (scale !== 1) {
      for (let index = 0; index < decoded.vertices.length; index++)
        decoded.vertices[index]! *= scale;
    }
    return decoded;
  }
  throw new Error(
    'Imported mesh data is malformed or exceeds the import limit.'
  );
}

/**
 * The factor a referenced payload's coordinates are multiplied by to read
 * them in `documentUnits`: 1 when `payloadUnits` is absent (the payload is in
 * document units, as every payload written before v153 is) or names the
 * document's unit.
 */
export function importedMeshPayloadScale(
  data: Pick<ImportedMeshFeatureData, 'payloadUnits'>,
  documentUnits: UnitSystem
): number {
  const payloadUnits = data.payloadUnits;
  if (payloadUnits === undefined || payloadUnits === documentUnits) return 1;
  return millimetresPerUnit(payloadUnits) / millimetresPerUnit(documentUnits);
}
