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
/** One coordinate as an ASCII STL writes it: a plain decimal, nothing else. */
const ASCII_COORDINATE = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
/** What follows the `vertex` keyword: exactly three coordinates. */
const ASCII_VERTEX_TAIL = new RegExp(
  `^[ \\t]+(${ASCII_COORDINATE})[ \\t]+(${ASCII_COORDINATE})[ \\t]+(${ASCII_COORDINATE})[ \\t]*$`
);

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

/** A statement short enough to quote in a refusal. */
function quoted(statement: string): string {
  const trimmed = statement.trim();
  return `"${trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed}"`;
}

/**
 * Whether the text holds a `vertex` statement opening a line, in either
 * letter case. A literal search with a look back over the blanks before each
 * hit: anchoring the pattern itself to line starts made the sniff of a large
 * whitespace-padded file several times slower.
 */
function hasVertexStatement(text: string): boolean {
  for (const match of text.matchAll(/vertex\s/gi)) {
    let index = match.index - 1;
    while (text[index] === ' ' || text[index] === '\t') index -= 1;
    if (index < 0 || text[index] === '\n' || text[index] === '\r') return true;
  }
  return false;
}

/**
 * Reads an ASCII STL by its facet structure: each `facet … endfacet` block is
 * one triangle, and must hold exactly three `vertex` statements of three
 * finite numbers each. Keywords match in either letter case, since exporters
 * write both.
 *
 * Nothing is skipped. Pairing vertex statements three at a time wherever they
 * appear let one unreadable coordinate (`nan`, `1.#QNAN`, `-1.#IND`) shift
 * every later vertex into a triangle the file does not contain, so a vertex
 * this reader cannot read refuses the file, naming the facet. The facet
 * normal is not read — exports recompute it — so an exporter's `facet normal
 * nan nan nan` on a degenerate facet is not a refusal.
 */
function parseAsciiStl(text: string, fileName: string): ParsedStl {
  const vertices: number[] = [];
  let facets = 0;
  /** Vertices read in the open facet, or -1 between facets. */
  let facetVertices = -1;
  // Each statement: its first word, then the rest of its line.
  for (const [line, word, rest] of text.matchAll(/^[ \t]*(\S+)([^\r\n]*)/gm)) {
    const keyword = word!.toLowerCase();
    if (keyword === 'facet') {
      if (facetVertices >= 0) {
        throw new StlParseError(
          `ASCII STL facet ${facets} is not closed by "endfacet".`
        );
      }
      facets += 1;
      // Charged per facet, so an oversized file is refused before its
      // vertices are all held in memory.
      assertTriangleBudget(facets);
      facetVertices = 0;
    } else if (keyword === 'vertex') {
      if (facetVertices < 0) {
        throw new StlParseError(
          `ASCII STL has a vertex outside any facet: ${quoted(line)}.`
        );
      }
      // A tail that is not three coordinates reads as NaN, and so refuses.
      const coordinates = ASCII_VERTEX_TAIL.exec(rest!) ?? [];
      const x = Number(coordinates[1]);
      const y = Number(coordinates[2]);
      const z = Number(coordinates[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new StlParseError(
          `ASCII STL facet ${facets} has a vertex that is not three finite numbers: ${quoted(line)}.`
        );
      }
      if (facetVertices === 3) {
        throw new StlParseError(
          `ASCII STL facet ${facets} has more than three vertices.`
        );
      }
      vertices.push(x, y, z);
      facetVertices += 1;
    } else if (keyword === 'endfacet') {
      if (facetVertices !== 3) {
        throw new StlParseError(
          facetVertices < 0
            ? 'ASCII STL has an "endfacet" with no facet open.'
            : `ASCII STL facet ${facets} has ${facetVertices} vertices; a facet needs three.`
        );
      }
      facetVertices = -1;
    } else if (keyword === 'endsolid' && facetVertices >= 0) {
      throw new StlParseError(
        `ASCII STL facet ${facets} is not closed by "endfacet".`
      );
    }
  }
  if (facetVertices >= 0) {
    throw new StlParseError(
      `ASCII STL ends inside facet ${facets}; the file may be truncated.`
    );
  }
  if (facets === 0) {
    throw new StlParseError('ASCII STL contains no facets.');
  }
  const triangleCount = facets;
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
    // to the tolerant binary branch. Either letter case: an upper-case ASCII
    // file read as binary was refused as a corrupt binary one.
    if (
      hasVertexStatement(text) ||
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
      // A shared-edge tessellation can contain a collapsed seam facet. It
      // carries no area or volume and makes the emitted STL non-manifold, so
      // omit only the exact zero-area case; no welding tolerance is involved.
      if (nx === 0 && ny === 0 && nz === 0) continue;
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
