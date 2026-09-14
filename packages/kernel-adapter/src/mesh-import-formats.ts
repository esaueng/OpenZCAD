import { MAX_IMPORT_TRIANGLES } from '@openzcad/io-stl';

/**
 * The mesh interchange formats an import can take, beside STL.
 *
 * Every one of them arrives as a triangle soup and becomes the same
 * `imported-mesh` feature an STL import produces, so nothing downstream — the
 * document, autosave, the rebuild, the exports — has a second mesh path to
 * learn. What differs between them is only how the bytes are read, which the
 * kernel's translators already do, and what a hostile file of that shape can
 * cost, which is the table below.
 *
 * `.gltf` is deliberately absent. The kernel reads glTF through `importGlb`,
 * which refuses a JSON glTF by magic number ("parse error: not a GLB file"),
 * and a JSON glTF's mesh usually lives in a sibling `.bin` that a browser file
 * picker never hands over. Advertising the extension would be advertising a
 * refusal.
 */
export type MeshImportFormat = '3mf' | 'obj' | 'glb' | 'ply';

export interface MeshImportPolicy {
  readonly format: MeshImportFormat;
  /** Lower-case and dot-prefixed, as a file input's `accept` list spells it. */
  readonly extensions: readonly string[];
  /** How a refusal names the format to the user. */
  readonly label: string;
  /**
   * Hostile-input byte budget, passed to the translator explicitly rather than
   * left at its default, and checked against the file's own declared size
   * before any of it is read.
   */
  readonly maxInputBytes: number;
  /**
   * Hostile-input entity budget, in whatever that format's reader counts.
   * Verified against the pinned kernel: 3MF, OBJ and PLY charge vertices and
   * triangles separately against this number, while glTF charges the sum of
   * every accessor's element count — positions plus indices — which is about
   * four times as much for the same mesh.
   */
  readonly maxEntities: number;
}

const MIB = 1024 * 1024;

/**
 * The entity fence sits at three times the document's own triangle ceiling.
 * A mesh the document would accept is therefore never refused by the budget —
 * not even one whose vertices are entirely unshared, which costs three
 * vertices per triangle — while a file orders of magnitude larger is refused
 * inside the parser, before it has built a solid the import would only throw
 * away.
 */
const MAX_MESH_ENTITIES = MAX_IMPORT_TRIANGLES * 3;

export const MESH_IMPORT_POLICIES: {
  readonly [K in MeshImportFormat]: MeshImportPolicy;
} = {
  // A 3MF is a Zip package, so its byte count is compressed and a small file
  // can expand into a large mesh. It gets the archive ceiling the Shapr3D
  // import already uses for the same reason; the entity budget is what
  // actually bounds the expansion.
  '3mf': {
    format: '3mf',
    extensions: ['.3mf'],
    label: '3MF',
    maxInputBytes: 32 * MIB,
    maxEntities: MAX_MESH_ENTITIES
  },
  obj: {
    format: 'obj',
    extensions: ['.obj'],
    label: 'OBJ',
    maxInputBytes: 128 * MIB,
    maxEntities: MAX_MESH_ENTITIES
  },
  glb: {
    format: 'glb',
    extensions: ['.glb'],
    label: 'glTF binary',
    maxInputBytes: 128 * MIB,
    maxEntities: MAX_MESH_ENTITIES * 4
  },
  ply: {
    format: 'ply',
    extensions: ['.ply'],
    label: 'PLY',
    maxInputBytes: 128 * MIB,
    maxEntities: MAX_MESH_ENTITIES
  }
};

/** Every extension the mesh importers take, for a file input's `accept`. */
export const MESH_IMPORT_EXTENSIONS: readonly string[] = Object.values(
  MESH_IMPORT_POLICIES
).flatMap((policy) => policy.extensions);

/** The format a file name selects, or null when it names no mesh import. */
export function meshImportFormatForFileName(
  fileName: string
): MeshImportFormat | null {
  const lower = fileName.toLowerCase();
  for (const policy of Object.values(MESH_IMPORT_POLICIES)) {
    if (policy.extensions.some((extension) => lower.endsWith(extension))) {
      return policy.format;
    }
  }
  return null;
}

/**
 * Megabytes, with enough precision that a file just over a whole-megabyte
 * ceiling does not print as the ceiling itself. Rounding both sides to whole
 * megabytes made a 32.04 MB file read "limited to 32 MB; this file is 32 MB",
 * which tells the user nothing and reads as a contradiction.
 */
function megabytes(bytes: number): string {
  const value = bytes / MIB;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function grouped(bytes: number): string {
  return String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The refusal a file too large for its format gets, naming the ceiling and
 * what was offered. Raised from the file's declared size, so nothing is read.
 *
 * The exact byte count is spelled out as well, because two decimal places
 * still collide for a file a few bytes over the line, and "how far over am I"
 * is the only question this message has to answer.
 */
export function meshImportTooLargeMessage(
  format: MeshImportFormat,
  bytes: number
): string {
  const policy = MESH_IMPORT_POLICIES[format];
  return (
    `${policy.label} import is limited to ${megabytes(policy.maxInputBytes)} MB ` +
    `(${grouped(policy.maxInputBytes)} bytes); this file is ` +
    `${megabytes(bytes)} MB (${grouped(bytes)} bytes).`
  );
}
