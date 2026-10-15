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
const ASCII_COORDINATE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
/**
 * The words that open or close an ASCII STL statement. A token after a
 * vertex's third coordinate must be one of them.
 */
const ASCII_KEYWORDS = new Set([
  'solid',
  'endsolid',
  'facet',
  'normal',
  'outer',
  'loop',
  'vertex',
  'endloop',
  'endfacet'
]);

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

/** Whether a UTF-16 code unit is ASCII whitespace, which separates tokens. */
function isSeparator(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/** A vertex statement as read, short enough to quote in a refusal. */
function vertexStatement(...tokens: (string | null)[]): string {
  const statement = ['vertex', ...tokens].filter(Boolean).join(' ');
  return `"${statement.length > 60 ? `${statement.slice(0, 60)}…` : statement}"`;
}

/** A coordinate token's value, or NaN when it is not a plain decimal. */
function coordinate(token: string | null): number {
  return token !== null && ASCII_COORDINATE.test(token) ? Number(token) : NaN;
}

/**
 * A token that reads as a coordinate, well formed or not: a sign, then a
 * digit, a decimal point, `nan` or `inf`, then anything. Broad on purpose — an
 * ASCII file whose vertices hold `nan`, `1.#QNAN`, `-1.#IND` or `inf` must
 * still reach the ASCII reader to be refused there — but never a plain word.
 */
const SNIFFED_COORDINATE = String.raw`\s+[-+]?(?:\d|\.\d|nan|inf)\S*`;
/** `vertex` followed by three coordinate-like tokens, in either letter case. */
const SNIFFED_VERTEX = new RegExp(`vertex${SNIFFED_COORDINATE.repeat(3)}`, 'gi');

/**
 * Whether the text holds a `vertex` statement: the keyword, in either letter
 * case, at the start or after whitespace, followed by three coordinate-like
 * tokens — wherever the line breaks fall. A binary STL's 80-byte header is
 * free text that may say `solid … vertex colors`, and a padded binary file
 * fails the exact-size test, so the keyword alone would send it to the ASCII
 * reader to be refused. A literal search that checks the one character
 * before each hit: putting that alternation in the pattern made the sniff of
 * a large whitespace-padded file several times slower.
 */
function hasVertexStatement(text: string): boolean {
  for (const match of text.matchAll(SNIFFED_VERTEX)) {
    if (match.index === 0 || isSeparator(text.charCodeAt(match.index - 1))) {
      return true;
    }
  }
  return false;
}

/**
 * Reads an ASCII STL by its facet structure: each `facet … endfacet` block is
 * one triangle, and must hold exactly three `vertex` statements of three
 * finite numbers each. Keywords match in either letter case, since exporters
 * write both.
 *
 * The text is read as whitespace-separated tokens, not lines: line breaks
 * carry no meaning in the format, so a file written on one line, or with CRLF
 * or bare CR endings, reads the same as one statement per line.
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
  const length = text.length;
  let index = 0;
  /** Where the token `next` last returned starts. */
  let start = 0;
  /** The next token, or null at the end of the text. */
  const next = (): string | null => {
    while (index < length && isSeparator(text.charCodeAt(index))) index += 1;
    if (index >= length) return null;
    start = index;
    while (index < length && !isSeparator(text.charCodeAt(index))) index += 1;
    return text.slice(start, index);
  };
  /** A token's keyword, lower-cased, or '' for any other token. */
  const keywordOf = (token: string): string => {
    // Only a letter can start a keyword, so numbers stop here.
    const letter = token.charCodeAt(0) | 0x20;
    if (letter < 0x61 || letter > 0x7a) return '';
    if (ASCII_KEYWORDS.has(token)) return token;
    const word = token.toLowerCase();
    return ASCII_KEYWORDS.has(word) ? word : '';
  };
  /**
   * The next line break at or after `index` (the text's length when there is
   * none). Searched again only once `index` has passed the last answer, so a
   * file of many solids is still searched once over.
   */
  let lineBreak = -1;
  const nextLineBreak = (): number => {
    if (index > lineBreak) {
      const found = /[\r\n]/g;
      found.lastIndex = index;
      lineBreak = found.exec(text)?.index ?? length;
    }
    return lineBreak;
  };
  /** The keyword of the token after the current one, without consuming it. */
  const peekKeyword = (): string => {
    const mark = index;
    const token = next();
    index = mark;
    return token === null ? '' : keywordOf(token);
  };
  /** Whether the whole file is one line, trailing line breaks aside. */
  const body = text.trimEnd();
  const oneLine = !body.includes('\n') && !body.includes('\r');
  const inlineFacetBody =
    /\s+(?:normal\s+\S+\s+\S+\s+\S+\s+)?outer\s+loop\s+vertex(?:\s|$)/iy;
  /**
   * Skips the name after `solid` or `endsolid`. Names may hold keywords; an
   * inline facet's `outer loop vertex` body distinguishes it from a name in
   * a file with later line breaks. Its vertices are validated by the reader,
   * so malformed inline geometry cannot disappear into the name. A
   * one-line file has no line end to stop at, so there the name ends at the
   * first `facet` followed by `normal` or `outer`, and everything from it on
   * is geometry — a malformed facet is refused, never read as a name. The
   * cost is that a one-line file whose name itself says `facet normal` is
   * refused.
   */
  const skipName = () => {
    const lineEnd = oneLine ? length : nextLineBreak();
    for (;;) {
      const mark = index;
      const token = next();
      if (token === null) return;
      inlineFacetBody.lastIndex = index;
      if (
        start > lineEnd ||
        (keywordOf(token) === 'facet' &&
          (oneLine
            ? ['normal', 'outer'].includes(peekKeyword())
            : inlineFacetBody.test(text)))
      ) {
        index = mark;
        return;
      }
    }
  };

  let facets = 0;
  /** Vertices read in the open facet, or -1 between facets. */
  let facetVertices = -1;
  /** The last token read was a vertex's third coordinate, `a b c`. */
  let afterVertex = false;
  let a: string | null = null;
  let b: string | null = null;
  let c: string | null = null;
  for (let token = next(); token !== null; token = next()) {
    const keyword = keywordOf(token);
    // Exactly three coordinates: whatever follows them opens a statement.
    if (afterVertex && keyword === '') {
      throw new StlParseError(
        `ASCII STL facet ${facets} has a vertex that is not three finite numbers: ${vertexStatement(a, b, c, token)}.`
      );
    }
    afterVertex = false;
    if (keyword === 'solid' || keyword === 'endsolid') {
      if (facetVertices >= 0) {
        throw new StlParseError(
          `ASCII STL facet ${facets} is not closed by "endfacet".`
        );
      }
      skipName();
    } else if (keyword === 'facet') {
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
      a = next();
      b = next();
      c = next();
      if (facetVertices < 0) {
        throw new StlParseError(
          `ASCII STL has a vertex outside any facet: ${vertexStatement(a, b, c)}.`
        );
      }
      const x = coordinate(a);
      const y = coordinate(b);
      const z = coordinate(c);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new StlParseError(
          `ASCII STL facet ${facets} has a vertex that is not three finite numbers: ${vertexStatement(a, b, c)}.`
        );
      }
      if (facetVertices === 3) {
        throw new StlParseError(
          `ASCII STL facet ${facets} has more than three vertices.`
        );
      }
      vertices.push(x, y, z);
      facetVertices += 1;
      afterVertex = true;
    } else if (keyword === 'endfacet') {
      if (facetVertices !== 3) {
        throw new StlParseError(
          facetVertices < 0
            ? 'ASCII STL has an "endfacet" with no facet open.'
            : `ASCII STL facet ${facets} has ${facetVertices} vertices; a facet needs three.`
        );
      }
      facetVertices = -1;
    }
    // `normal`, `outer`, `loop`, `endloop` and the normal's components carry
    // nothing this reader needs.
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
