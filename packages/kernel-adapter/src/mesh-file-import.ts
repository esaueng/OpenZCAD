import { MAX_IMPORT_TRIANGLES, writeAsciiStl } from '@openzcad/io-stl';
import { UNIT_TO_MM, type UnitSystem } from '@openzcad/shared';

import {
  MESH_IMPORT_POLICIES,
  meshImportTooLargeMessage,
  type MeshImportFormat,
  type MeshImportPolicy
} from './mesh-import-formats';
import { RemusKernel, loadRemusTranslators } from './remus-runtime';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { importMeshSolid } from './exact-shape-utils';
import {
  applyThreeMfTransform,
  readThreeMfPackage,
  transformDeterminant,
  type ThreeMfPackage,
  type ThreeMfPlacement
} from './three-mf-package';

/** What an `imported-mesh` feature needs, in millimetres. */
export interface ImportedMeshTriangles {
  /** Flat xyz triples. */
  vertices: number[];
  /** Triangle vertex indices into `vertices`. */
  indices: number[];
  triangleCount: number;
  /**
   * The length unit the file declared, for the formats that declare one.
   * The vertices above are already in millimetres; this is what they were
   * converted from, so the import can say so.
   */
  sourceUnit?: string;
}

/** One placement to tessellate: a solid, and the matrix that positions it. */
interface MeshPlacement {
  readonly solid: number;
  readonly transform: readonly number[] | null;
}

/**
 * One mesh file read into the triangles an `imported-mesh` feature stores.
 *
 * The kernel's translators already read 3MF, OBJ, glTF binary and PLY, each
 * with the same signature as the STL importer the adapter uses, and each
 * returning an arena document of one mesh-backed solid per object in the file.
 * Turning that back into a triangle list is what lets every one of these
 * formats join the import path STL already has: the document holds triangles,
 * so autosave, reopen, replay and export need to know nothing about where they
 * came from.
 *
 * The triangles are the file's own. A mesh-backed solid is one planar face per
 * triangle, and tessellating it returns those facets unchanged — verified on
 * the pinned kernel, where a 12-triangle box comes back as 12 triangles over 8
 * welded vertices with its volume intact — so nothing is refined, decimated or
 * re-meshed on the way in.
 *
 * Coordinates come out in millimetres. OBJ, PLY and glTF binary declare no
 * length unit, so their numbers are adopted as written — the STL convention. A
 * 3MF declares one, and also declares in its `<build>` section which of its
 * objects are placed, how often, and with what matrix; the pinned translator
 * reads neither, so both are read from the package here and applied. Anything
 * the package states that this import cannot carry out faithfully is refused
 * by name rather than dropped.
 *
 * One file becomes one mesh body, and whether a file can is decided by trying,
 * not by counting: the triangles are put through the very rebuild the document
 * will run — serialize to one ASCII STL solid, import, sew — before they are
 * returned. Several shells sew into one body more often than not, so counting
 * objects would refuse files that import perfectly well; but a file whose
 * triangles the rebuild cannot turn into a body is refused here, with the
 * kernel's own reason, instead of importing behind a success message and
 * leaving a feature with no body at all.
 *
 * That rebuild is run at the scale the document will store, which is why
 * `documentUnits` is required rather than assumed. The sew tolerance the
 * rebuild uses is derived from the numbers it is handed, so the same triangles
 * checked in millimetres and stored in metres are two different questions: a
 * 0.0002 mm plate sews cleanly as millimetres and collapses as metres —
 * measured on the pin — which is exactly the success-then-no-body this check
 * exists to close. The returned vertices are still millimetres; only the check
 * is scaled, as the commit will scale them.
 */
export async function importMeshFile(
  format: MeshImportFormat,
  data: Uint8Array,
  documentUnits: UnitSystem
): Promise<ImportedMeshTriangles> {
  const policy = MESH_IMPORT_POLICIES[format];
  if (data.byteLength > policy.maxInputBytes) {
    throw new Error(meshImportTooLargeMessage(format, data.byteLength));
  }
  // Read before parsing: a package that cannot be read, or that asks for
  // something this import will not do, refuses without spending the parse.
  const pkg = format === '3mf' ? await readThreeMfPackage(data) : null;
  const io = await loadRemusTranslators();
  let document: Uint8Array;
  try {
    document =
      format === '3mf'
        ? io.import3mf(data, policy.maxInputBytes, policy.maxEntities)
        : format === 'obj'
          ? io.importObj(data, policy.maxInputBytes, policy.maxEntities)
          : format === 'glb'
            ? io.importGlb(data, policy.maxInputBytes, policy.maxEntities)
            : io.importPly(data, policy.maxInputBytes, policy.maxEntities);
  } catch (error) {
    // The translator's own refusals name the budget that stopped it ("import
    // limit exceeded for input bytes: ...") and the parse position that failed,
    // so they are worth more to the user than a generic message. Keep them,
    // and say which format was being read.
    const detail =
      error instanceof Error ? error.message : 'unknown translator error';
    throw new Error(`${policy.label} import failed: ${detail}`, {
      cause: error
    });
  }
  if (document.length === 0) {
    throw new Error(`This ${policy.label} file contains no mesh.`);
  }

  const kernel = new RemusKernel();
  let vertices: number[];
  let indices: number[];
  try {
    const solids = Array.from(kernel.deserializeSolids(document));
    ({ vertices, indices } = tessellatePlacements(
      kernel,
      pkg ? threeMfPlacements(pkg, solids) : solids.map(identityPlacement)
    ));

    const triangleCount = indices.length / 3;
    if (triangleCount === 0) {
      throw new Error(`This ${policy.label} file contains no triangles.`);
    }
    if (triangleCount > MAX_IMPORT_TRIANGLES) {
      throw new Error(
        `${policy.label} has ${triangleCount} triangles; the browser import limit is ${MAX_IMPORT_TRIANGLES}.`
      );
    }
    if (pkg && pkg.unit.millimetres !== 1) {
      for (let index = 0; index < vertices.length; index += 1) {
        vertices[index]! *= pkg.unit.millimetres;
      }
    }
    verifyMeshRebuilds(kernel, policy, vertices, indices, documentUnits);
  } finally {
    kernel.free();
  }

  return {
    vertices,
    indices,
    triangleCount: indices.length / 3,
    ...(pkg ? { sourceUnit: pkg.unit.name } : {})
  };
}

function identityPlacement(solid: number): MeshPlacement {
  return { solid, transform: null };
}

/**
 * What a 3MF's `<build>` section asks the import to place.
 *
 * The translator returns one solid per `<object>` resource, in document order
 * — verified on the pin — and ignores `<build>` completely. So the mapping
 * from a build item to a solid is positional, and it is checked: if the
 * package's mesh objects and the translator's solids do not correspond one for
 * one, the correspondence is not established and the import refuses rather
 * than placing whichever solid happens to sit at that index.
 */
function threeMfPlacements(
  pkg: ThreeMfPackage,
  solids: readonly number[]
): MeshPlacement[] {
  if (solids.length !== pkg.meshObjectCount) {
    throw new Error(
      `This 3MF declares ${pkg.meshObjectCount} mesh object(s) but read as ` +
        `${solids.length}, so the import cannot tell which object its build ` +
        'places. Re-export the file, or import each object from its own file.'
    );
  }
  return pkg.placements.map((placement: ThreeMfPlacement) => ({
    solid: solids[placement.objectIndex]!,
    transform: placement.transform
  }));
}

/**
 * Every placement's triangles, in one list.
 *
 * A solid placed more than once is tessellated once and emitted once per
 * placement, so a build plate that repeats one object imports as many copies
 * as it asks for rather than the one the translator hands back.
 */
function tessellatePlacements(
  kernel: RemusKernel,
  placements: readonly MeshPlacement[]
): { vertices: number[]; indices: number[] } {
  const vertices: number[] = [];
  const indices: number[] = [];
  const tessellated = new Map<
    number,
    { positions: number[]; triangles: number[] }
  >();
  for (const placement of placements) {
    let facets = tessellated.get(placement.solid);
    if (!facets) {
      const mesh = kernel.tessellateSolid(placement.solid, MEASUREMENT_DEFLECTION);
      try {
        // WASM accessors materialize arrays. Read each once before iterating.
        facets = {
          positions: Array.from(mesh.positions),
          triangles: Array.from(mesh.indices)
        };
      } finally {
        mesh.free();
      }
      tessellated.set(placement.solid, facets);
    }
    const base = vertices.length / 3;
    const matrix = placement.transform;
    if (matrix) {
      for (let index = 0; index < facets.positions.length; index += 3) {
        const point = applyThreeMfTransform(
          matrix,
          facets.positions[index]!,
          facets.positions[index + 1]!,
          facets.positions[index + 2]!
        );
        vertices.push(point[0], point[1], point[2]);
      }
    } else {
      for (const value of facets.positions) {
        vertices.push(value);
      }
    }
    // A mirroring placement turns every triangle inside out; swapping two
    // corners back is what keeps the shell facing outwards.
    const mirrored = matrix !== null && transformDeterminant(matrix) < 0;
    for (let index = 0; index < facets.triangles.length; index += 3) {
      const a = facets.triangles[index]! + base;
      const b = facets.triangles[index + 1]! + base;
      const c = facets.triangles[index + 2]! + base;
      if (mirrored) {
        indices.push(a, c, b);
      } else {
        indices.push(a, b, c);
      }
    }
  }
  return { vertices, indices };
}

/**
 * Refuse now what the rebuild would refuse later.
 *
 * An `imported-mesh` feature has one body, and it builds it by serializing its
 * triangles to a single ASCII STL solid and sewing them — so the only honest
 * answer to "can this file be one body?" is to run that. It is run here, on
 * the triangles about to be returned, so a file that cannot come back is
 * refused while it is still a file, instead of importing behind "Imported
 * 24 triangles" and leaving a feature with no body.
 *
 * The kernel's own reason is carried through, and the count of vertex-disjoint
 * groups in the soup is added when there is more than one, because that is
 * what the user can act on.
 *
 * The triangles are scaled into the document's units first, by the very
 * factor the commit applies, because the rebuild's sew tolerance is derived
 * from the numbers it is given. A check run in millimetres against a document
 * stored in metres answers a question nobody asked.
 */
function verifyMeshRebuilds(
  kernel: RemusKernel,
  policy: MeshImportPolicy,
  vertices: readonly number[],
  indices: readonly number[],
  documentUnits: UnitSystem
): void {
  const stored = storedVertices(vertices, documentUnits);
  try {
    importMeshSolid(
      kernel,
      writeAsciiStl('import-check', [
        {
          name: 'import-check',
          vertices: stored,
          indices: indices as number[]
        }
      ])
    );
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'unknown kernel error';
    const shells = disjointGroupCount(indices, vertices.length / 3);
    const sentence = detail.endsWith('.') ? detail : `${detail}.`;
    throw new Error(
      `This ${policy.label} file could not be imported as a body: ${sentence}` +
        (shells > 1
          ? ` Its triangles form ${shells} groups that share no vertex, and a ` +
            'mesh import becomes one body — export it as a single closed ' +
            'mesh, or import each part from its own file.'
          : ''),
      { cause: error }
    );
  }
}

/**
 * The millimetre triangles as the document will hold them.
 *
 * `commitImportedMesh` adopts an imported mesh at `1 / UNIT_TO_MM[units]`, so
 * this is the same multiplication on the same values — identical bits, not an
 * approximation of them — and the check therefore sees exactly the vertices
 * the feature will store and the rebuild will sew.
 */
function storedVertices(
  vertices: readonly number[],
  documentUnits: UnitSystem
): number[] {
  const scale = 1 / UNIT_TO_MM[documentUnits];
  return scale === 1
    ? (vertices as number[])
    : vertices.map((value) => value * scale);
}

/** How many vertex-disjoint groups a triangle soup falls into. */
function disjointGroupCount(
  indices: readonly number[],
  vertexCount: number
): number {
  if (vertexCount === 0) {
    return 0;
  }
  const parent = new Int32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    parent[index] = index;
  }
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let cursor = value;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };
  const used = new Uint8Array(vertexCount);
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]!;
    const b = indices[index + 1]!;
    const c = indices[index + 2]!;
    used[a] = 1;
    used[b] = 1;
    used[c] = 1;
    union(a, b);
    union(a, c);
  }
  const roots = new Set<number>();
  for (let index = 0; index < vertexCount; index += 1) {
    if (used[index] === 1) {
      roots.add(find(index));
    }
  }
  return roots.size;
}
