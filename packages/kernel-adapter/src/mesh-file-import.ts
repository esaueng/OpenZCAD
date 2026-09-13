import { MAX_IMPORT_TRIANGLES } from '@openzcad/io-stl';

import {
  MESH_IMPORT_POLICIES,
  meshImportTooLargeMessage,
  type MeshImportFormat
} from './mesh-import-formats';
import { RemusKernel, loadRemusTranslators } from './remus-runtime';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';

/** What an `imported-mesh` feature needs, in the file's own coordinates. */
export interface ImportedMeshTriangles {
  /** Flat xyz triples. */
  vertices: number[];
  /** Triangle vertex indices into `vertices`. */
  indices: number[];
  triangleCount: number;
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
 * Coordinates are adopted as written, which is the STL convention: the pinned
 * translators do not rescale by a declared unit (a 3MF marked `meter` imports
 * with the same numbers as one marked `millimeter`), so the caller applies the
 * document's unit scale exactly as it does for STL.
 */
export async function importMeshFile(
  format: MeshImportFormat,
  data: Uint8Array
): Promise<ImportedMeshTriangles> {
  const policy = MESH_IMPORT_POLICIES[format];
  if (data.byteLength > policy.maxInputBytes) {
    throw new Error(meshImportTooLargeMessage(format, data.byteLength));
  }
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
    const solids = kernel.deserializeSolids(document);
    vertices = [];
    indices = [];
    // A file may hold several objects — a 3MF build with two items imports as
    // two solids. They become one mesh feature, the same merge the mesh
    // exports perform in the other direction.
    for (const solid of solids) {
      const mesh = kernel.tessellateSolid(solid, MEASUREMENT_DEFLECTION);
      try {
        // WASM accessors materialize arrays. Read each once before iterating.
        const positions = mesh.positions;
        const triangles = mesh.indices;
        const base = vertices.length / 3;
        for (const value of positions) {
          vertices.push(value);
        }
        for (const index of triangles) {
          indices.push(index + base);
        }
      } finally {
        mesh.free();
      }
    }
  } finally {
    kernel.free();
  }

  const triangleCount = indices.length / 3;
  if (triangleCount === 0) {
    throw new Error(`This ${policy.label} file contains no triangles.`);
  }
  if (triangleCount > MAX_IMPORT_TRIANGLES) {
    throw new Error(
      `${policy.label} has ${triangleCount} triangles; the browser import limit is ${MAX_IMPORT_TRIANGLES}.`
    );
  }
  return { vertices, indices, triangleCount };
}
