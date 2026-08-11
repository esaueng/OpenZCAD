export interface ParsedStl {
  name: string;
  triangleCount: number;
  format: 'ascii' | 'binary';
  /** Flat xyz triples, three vertices per triangle. */
  vertices: number[];
  /** Sequential triangle indices into `vertices`. */
  indices: number[];
}

const BINARY_STL_HEADER_BYTES = 84;
const BINARY_STL_TRIANGLE_BYTES = 50;
const ASCII_VERTEX_SOURCE =
  'vertex\\s+([-+0-9.eE]+)\\s+([-+0-9.eE]+)\\s+([-+0-9.eE]+)';

/** Guard against imports that would stall the browser tab. */
export const MAX_IMPORT_TRIANGLES = 200_000;

export class StlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StlParseError';
  }
}

function assertTriangleBudget(triangleCount: number): void {
  if (triangleCount > MAX_IMPORT_TRIANGLES) {
    throw new StlParseError(
      `STL has ${triangleCount} triangles; the browser import limit is ${MAX_IMPORT_TRIANGLES}.`
    );
  }
}

function parseBinaryStl(buffer: ArrayBuffer, fileName: string): ParsedStl {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  assertTriangleBudget(triangleCount);
  const vertices: number[] = [];
  const indices: number[] = [];
  let offset = BINARY_STL_HEADER_BYTES;
  for (let i = 0; i < triangleCount; i++) {
    offset += 12; // skip the stored facet normal; recomputed on export
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new StlParseError('Binary STL contains a non-finite vertex.');
      }
      vertices.push(x, y, z);
      offset += 12;
    }
    offset += 2; // attribute byte count
    const base = i * 3;
    indices.push(base, base + 1, base + 2);
  }
  return { name: fileName, triangleCount, format: 'binary', vertices, indices };
}

function assertBinaryStlLength(
  byteLength: number,
  triangleCount: number
): void {
  const requiredBytes =
    BINARY_STL_HEADER_BYTES + triangleCount * BINARY_STL_TRIANGLE_BYTES;
  if (requiredBytes > byteLength) {
    throw new StlParseError(
      `Binary STL declares ${triangleCount} triangles requiring ${requiredBytes} bytes, but the file has ${byteLength}.`
    );
  }
}

function parseAsciiStl(text: string, fileName: string): ParsedStl {
  const vertexPattern = new RegExp(ASCII_VERTEX_SOURCE, 'g');
  const vertices: number[] = [];
  for (const match of text.matchAll(vertexPattern)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new StlParseError('ASCII STL contains a malformed vertex.');
    }
    vertices.push(x, y, z);
    // Enforce the budget while accumulating so an oversized file is rejected
    // before its vertices are all held in memory.
    if (vertices.length > MAX_IMPORT_TRIANGLES * 9) {
      assertTriangleBudget(Math.ceil(vertices.length / 9));
    }
  }
  if (vertices.length === 0) {
    throw new StlParseError('ASCII STL contains no facets.');
  }
  if (vertices.length % 9 !== 0) {
    throw new StlParseError('ASCII STL vertex count is not a multiple of three.');
  }
  const triangleCount = vertices.length / 9;
  const indices: number[] = [];
  for (let i = 0; i < triangleCount; i++) {
    const base = i * 3;
    indices.push(base, base + 1, base + 2);
  }
  return { name: fileName, triangleCount, format: 'ascii', vertices, indices };
}

/**
 * Parses an STL file (binary or ASCII) into raw triangle geometry. A binary
 * STL is an 80-byte header, a uint32 triangle count, then 50 bytes per
 * triangle; the "solid" prefix alone is unreliable (binary exporters may
 * emit it too), so an exact size match takes precedence.
 */
export function parseStl(buffer: ArrayBuffer, fileName: string): ParsedStl {
  if (buffer.byteLength >= BINARY_STL_HEADER_BYTES) {
    const declared = new DataView(buffer).getUint32(80, true);
    if (
      BINARY_STL_HEADER_BYTES + declared * BINARY_STL_TRIANGLE_BYTES ===
      buffer.byteLength
    ) {
      return parseBinaryStl(buffer, fileName);
    }
  }

  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  if (head.trimStart().toLowerCase().startsWith('solid')) {
    const text = new TextDecoder().decode(bytes);
    // A binary exporter's "solid" header carries no vertex statements; only
    // commit to ASCII when the body has at least one, otherwise fall through
    // to the tolerant binary branch.
    if (
      new RegExp(ASCII_VERTEX_SOURCE).test(text) ||
      buffer.byteLength < BINARY_STL_HEADER_BYTES
    ) {
      return parseAsciiStl(text, fileName);
    }
  }

  if (buffer.byteLength >= BINARY_STL_HEADER_BYTES) {
    const declared = new DataView(buffer).getUint32(80, true);
    assertBinaryStlLength(buffer.byteLength, declared);
    return parseBinaryStl(buffer, fileName);
  }
  throw new StlParseError('File is too small to be a valid STL.');
}

export interface StlExportMesh {
  name: string;
  vertices: number[];
  indices: number[];
}

export class StlWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StlWriteError';
  }
}

function facetNormal(
  vertices: number[],
  a: number,
  b: number,
  c: number
): [number, number, number] {
  const ax = vertices[a * 3]!;
  const ay = vertices[a * 3 + 1]!;
  const az = vertices[a * 3 + 2]!;
  const ux = vertices[b * 3]! - ax;
  const uy = vertices[b * 3 + 1]! - ay;
  const uz = vertices[b * 3 + 2]! - az;
  const vx = vertices[c * 3]! - ax;
  const vy = vertices[c * 3 + 1]! - ay;
  const vz = vertices[c * 3 + 2]! - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length > 0) {
    nx /= length;
    ny /= length;
    nz /= length;
  }
  return [nx, ny, nz];
}

/** Writes an ASCII STL with per-facet normals computed from the geometry. */
export function writeAsciiStl(solidName: string, meshes: StlExportMesh[]): string {
  const safeName = solidName.replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || 'openzcad';
  const lines: string[] = [`solid ${safeName}`];
  for (const mesh of meshes) {
    const vertexCount = Math.floor(mesh.vertices.length / 3);
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = mesh.indices[i]!;
      const b = mesh.indices[i + 1]!;
      const c = mesh.indices[i + 2]!;
      for (const index of [a, b, c]) {
        if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
          throw new StlWriteError(
            `Mesh "${mesh.name}" references vertex ${index}, but it has ${vertexCount} vertices.`
          );
        }
        for (let axis = 0; axis < 3; axis++) {
          if (!Number.isFinite(mesh.vertices[index * 3 + axis])) {
            throw new StlWriteError(
              `Mesh "${mesh.name}" vertex ${index} has a non-finite component.`
            );
          }
        }
      }
      const [nx, ny, nz] = facetNormal(mesh.vertices, a, b, c);
      lines.push(
        `  facet normal ${nx} ${ny} ${nz}`,
        '    outer loop',
        `      vertex ${mesh.vertices[a * 3]} ${mesh.vertices[a * 3 + 1]} ${mesh.vertices[a * 3 + 2]}`,
        `      vertex ${mesh.vertices[b * 3]} ${mesh.vertices[b * 3 + 1]} ${mesh.vertices[b * 3 + 2]}`,
        `      vertex ${mesh.vertices[c * 3]} ${mesh.vertices[c * 3 + 1]} ${mesh.vertices[c * 3 + 2]}`,
        '    endloop',
        '  endfacet'
      );
    }
  }
  lines.push(`endsolid ${safeName}`, '');
  return lines.join('\n');
}
