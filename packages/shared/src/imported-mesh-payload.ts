import { documentNodesWithHistory } from './document-history';
import {
  UNIT_TO_MM,
  isImportedSourceReference,
  type FeatureData,
  type ImportedSourceReference,
  type ProjectDocument
} from './index';

/**
 * The canonical bytes behind an `imported-mesh` feature's `meshPayloadRef`.
 *
 * A mesh embedded in the document costs about 24 JSON values per triangle,
 * and it sat there twice — in the feature node and in its `import.mesh`
 * command — plus once more in the import's undo entry. From ~21k triangles
 * the account refused the document, and from ~100k the undo entry alone
 * outgrew the history budget. The reference form stores the triangles once,
 * here, outside the document.
 *
 * Layout, little-endian throughout:
 *
 * | offset | size | field                                   |
 * | ------ | ---- | --------------------------------------- |
 * | 0      | 6    | ASCII `OZMESH`                          |
 * | 6      | 2    | uint16 format version (1)               |
 * | 8      | 4    | uint32 vertex component count (3 × n)   |
 * | 12     | 4    | uint32 index count (3 × triangles)      |
 * | 16     | 8 v  | float64 vertex components               |
 * | 16+8 v | 4 i  | uint32 triangle vertex indices          |
 *
 * Float64 on purpose: the embedded form is JSON numbers, so this is lossless
 * against it, and a reference-form import rebuilds bit-identically to an
 * embedded one. The triangles are the document's — already in document units,
 * after any importer conversion — so replay never runs a file parser, and a
 * parser fix can never move existing geometry. The SHA-256 of these bytes is
 * the reference's identity; one encoding per content keeps it stable.
 *
 * The arrays are written and read through typed-array views, which use the
 * platform's byte order: little-endian on every engine the app runs on, and
 * the fixed size of the header keeps both arrays aligned for direct views.
 */
const HEADER = [0x4f, 0x5a, 0x4d, 0x45, 0x53, 0x48, 1, 0]; // "OZMESH", v1
const HEADER_BYTES = 16;

/** Content type of the archived payload artifact. */
export const IMPORTED_MESH_PAYLOAD_CONTENT_TYPE =
  'application/vnd.openzcad.mesh-payload';

export interface ImportedMeshTriangles {
  /** Flat xyz triples in document units. */
  vertices: ArrayLike<number>;
  /** Triangle vertex indices. */
  indices: ArrayLike<number>;
}

export interface DecodedImportedMeshPayload {
  vertices: Float64Array;
  indices: Uint32Array;
}

export function encodeImportedMeshPayload(
  mesh: ImportedMeshTriangles
): Uint8Array<ArrayBuffer> {
  const { vertices, indices } = mesh;
  const vertexCount = vertices.length;
  const indexCount = indices.length;
  if (
    vertexCount % 3 !== 0 ||
    indexCount % 3 !== 0 ||
    !Array.prototype.every.call(vertices, Number.isFinite) ||
    !Array.prototype.every.call(
      indices,
      (index: number) =>
        Number.isInteger(index) && index >= 0 && index <= 0xffffffff
    )
  ) {
    throw new Error('Imported mesh data is malformed.');
  }
  const bytes = new Uint8Array(HEADER_BYTES + vertexCount * 8 + indexCount * 4);
  bytes.set(HEADER);
  new Uint32Array(bytes.buffer, 8, 2).set([vertexCount, indexCount]);
  new Float64Array(bytes.buffer, HEADER_BYTES, vertexCount).set(vertices);
  new Uint32Array(bytes.buffer, HEADER_BYTES + vertexCount * 8, indexCount).set(
    indices
  );
  return bytes;
}

/**
 * Reads a payload back. Structural checks only — the header and the exact
 * length; whether the triangles make sense belongs to the one check every
 * mesh passes on its way into a kernel (`importedMeshStl`), whichever form it
 * came from.
 */
export function decodeImportedMeshPayload(
  bytes: Uint8Array
): DecodedImportedMeshPayload {
  // A copy owns an aligned buffer, whatever view it was handed.
  const owned = new Uint8Array(bytes);
  const [vertexCount = 0, indexCount = 0] =
    owned.byteLength >= HEADER_BYTES ? new Uint32Array(owned.buffer, 8, 2) : [];
  if (
    HEADER.some((value, offset) => owned[offset] !== value) ||
    owned.byteLength !== HEADER_BYTES + vertexCount * 8 + indexCount * 4
  ) {
    throw new Error('Imported mesh payload is unreadable.');
  }
  return {
    vertices: new Float64Array(owned.buffer, HEADER_BYTES, vertexCount),
    indices: new Uint32Array(
      owned.buffer,
      HEADER_BYTES + vertexCount * 8,
      indexCount
    )
  };
}

/** Absent, or a known unit where the field may appear at all. */
function isKnownUnit(value: unknown, allowed: boolean): boolean {
  return (
    value === undefined ||
    (allowed && typeof value === 'string' && Object.hasOwn(UNIT_TO_MM, value))
  );
}

/**
 * Why an imported mesh's `payloadUnits` (v153) cannot stand, if it cannot:
 * an unknown unit, or the field beside embedded triangles, which are always
 * in document units and which no load would scale. Commands that write the
 * field ask this before they commit, so a refused value never reaches the
 * document or its command log.
 */
export function importedMeshPayloadUnitsProblem(data: {
  payloadUnits?: unknown;
  meshPayloadRef?: unknown;
}): string | undefined {
  if (data.payloadUnits === undefined) return undefined;
  if (data.meshPayloadRef === undefined)
    return 'Mesh payload units describe a referenced mesh payload; embedded triangles are always in document units.';
  if (!isKnownUnit(data.payloadUnits, true))
    return `Unknown mesh payload units ${JSON.stringify(data.payloadUnits)}.`;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime payload contract for mesh imports received from storage or peers:
 * the triangles embedded, or a reference to them — exactly one of the two.
 * The arrays' contents are the kernel's to judge; this only keeps a document
 * from carrying a mesh no rebuild could even look for. `payloadUnits` (v153)
 * describes the referenced payload only, so it is refused beside embedded
 * triangles, which are always in document units.
 */
export function isImportedMeshSourceData(
  value: unknown
): value is Extract<FeatureData, { featureKind: 'imported-mesh' }> {
  if (!isRecord(value)) return false;
  const embedded =
    Array.isArray(value.vertices) && Array.isArray(value.indices);
  const neitherArray =
    value.vertices === undefined && value.indices === undefined;
  return (
    value.featureKind === 'imported-mesh' &&
    typeof value.artifactId === 'string' &&
    typeof value.sourceName === 'string' &&
    typeof value.triangleCount === 'number' &&
    isKnownUnit(value.assumedUnits, true) &&
    isKnownUnit(value.payloadUnits, value.meshPayloadRef !== undefined) &&
    (value.meshPayloadRef === undefined
      ? embedded
      : neitherArray && isImportedSourceReference(value.meshPayloadRef))
  );
}

/**
 * I03: an imported mesh whose payload states its own units needs v153, or an
 * older reader would read the triangles in the document's unit instead.
 */
export const MESH_PAYLOAD_UNITS_SCHEMA_VERSION = 153;

/**
 * Checks active mesh imports and those undo/redo can restore. Not a full
 * document validator. Servers that read nothing else of a document's
 * content (the account's save parser, the collaboration room) still run it,
 * so it also refuses `payloadUnits` on a document declaring a schema older
 * than v153: a v152 reader would open that document and draw the payload in
 * the document's unit, 25.4x off for a millimetre payload in an inch part.
 */
export function hasValidImportedMeshSources(
  document: ProjectDocument
): boolean {
  if (!isRecord(document.nodes)) return false;
  const version: unknown = document.schemaVersion;
  const payloadUnitsDeclared =
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version >= MESH_PAYLOAD_UNITS_SCHEMA_VERSION;
  for (const node of documentNodesWithHistory(document)) {
    if (!isRecord(node)) return false;
    if (node.kind !== 'feature') continue;
    if (!isRecord(node.data)) return false;
    if (
      (node.featureKind === 'imported-mesh' ||
        node.data.featureKind === 'imported-mesh') &&
      (!isImportedMeshSourceData(node.data) ||
        (node.data.payloadUnits !== undefined && !payloadUnitsDeclared))
    )
      return false;
  }
  return true;
}

/**
 * The content-addressed reference an import feature rebuilds from, if it has
 * one: a STEP source or a mesh payload. Embedded imports carry none — the
 * document itself holds what their rebuild needs.
 *
 * Every walk that has to find import bytes — local cleanup, archival, shares,
 * backups, the kernel's prefetch — goes through here, so a new kind of
 * referenced import cannot be honoured by some of them and silently missed by
 * the rest.
 */
export function importedSourceReferenceOf(
  data: FeatureData | undefined
): ImportedSourceReference | undefined {
  if (data?.featureKind === 'imported-step') return data.stepSourceRef;
  if (data?.featureKind === 'imported-mesh') return data.meshPayloadRef;
  return undefined;
}
