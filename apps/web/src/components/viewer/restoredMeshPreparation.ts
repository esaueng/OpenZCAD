import {
  sameMeshBuffer,
  type GeometryBodyRepresentation
} from '@openzcad/shared';
import type {
  PreparedBody,
  PreparedBodyGeometry
} from '../../../../../packages/viewport/src/render/preparedBody';
import { facetedSource } from '../../../../../packages/viewport/src/render/edgeOverlay';

interface Entry {
  bodyId: GeometryBodyRepresentation['bodyId'];
  source: GeometryBodyRepresentation['source'];
  vertices: Float32Array;
  indices: Uint32Array;
  faces: Float64Array;
  edges: { id: string; neighbours: readonly number[] }[];
  faceted: boolean;
  tangentIds: Set<string>;
  geometry: PreparedBodyGeometry;
  silhouettes: PreparedBody['silhouettes'];
}

// Keep at most two recent dense meshes per mounted viewport. ViewerShell
// remounts it on project changes. Count backing buffers, including subarrays.
// Reserve room for a second revision of a similarly sized mesh.
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

export class RestoredMeshPreparation {
  private entries: Entry[] = [];

  remember(body: GeometryBodyRepresentation, prepared: PreparedBody) {
    const { geometry, silhouettes } = prepared;
    if (
      !geometry ||
      !body.topology?.faces.length ||
      !body.topology.edges.length
    )
      return;
    const { vertices, indices } = body.mesh;
    const faces = body.topology.faces;
    const buffers = new Set([
      vertices.buffer,
      indices.buffer,
      geometry.positions.buffer,
      geometry.normals.buffer,
      geometry.depth.buffer,
      geometry.indices.buffer
    ]);
    if (geometry.outline) buffers.add(geometry.outline.buffer);
    if (geometry.layout) {
      buffers.add(geometry.layout.sourceIndices.buffer);
      buffers.add(geometry.layout.renderSources.buffer);
    }
    if (silhouettes) {
      buffers.add(silhouettes.positions.buffer);
      buffers.add(silhouettes.normalsA.buffer);
      buffers.add(silhouettes.normalsB.buffer);
    }
    let bytes =
      3 * Float64Array.BYTES_PER_ELEMENT * faces.length +
      8 * (geometry.layout?.faceRanges.length ?? 0);
    for (const buffer of buffers) bytes += buffer.byteLength;
    if (bytes > MAX_ENTRY_BYTES) return;
    const edges = body.topology.edges;
    for (const edge of edges) {
      // Include record/string overhead and the face hashes it references.
      bytes +=
        128 +
        edge.topologyId.length * 4 +
        (edge.adjacentFaceHashes?.length ?? 0) * 8;
      if (bytes > MAX_ENTRY_BYTES) return;
    }
    const faceInputs = new Float64Array(faces.length * 3);
    faces.forEach((face, i) => {
      faceInputs[i * 3] = face.triangleStart;
      faceInputs[i * 3 + 1] = face.triangleCount;
      faceInputs[i * 3 + 2] = face.hash;
    });
    this.retain({
      bodyId: body.bodyId,
      source: body.source,
      vertices,
      indices,
      faces: faceInputs,
      edges: edges.map((edge) => ({
        id: edge.topologyId,
        neighbours: edge.adjacentFaceHashes?.slice() ?? []
      })),
      faceted: facetedSource(body.source),
      tangentIds: prepared.tangentIds,
      geometry,
      silhouettes
    });
  }

  private retain(entry: Entry) {
    // Prefer this body's preceding revision so Undo can find it after another
    // body was prepared. A cross-ID hit also claims a slot for its checked body.
    const prior =
      this.entries.find((saved) => saved.bodyId === entry.bodyId) ??
      this.entries[0];
    this.entries = [entry];
    if (
      prior &&
      (prior.bodyId !== entry.bodyId || prior.geometry !== entry.geometry)
    ) {
      this.entries.push(prior);
    }
  }

  restore(body: GeometryBodyRepresentation): PreparedBody | undefined {
    const topology = body.topology;
    if (!topology?.faces.length || !topology.edges.length) return;
    const entry = this.entries.find(
      (saved) =>
        // A new blend's preview and checked commit allocate independent body IDs.
        // Rendering depends on the mesh and topology inputs compared below.
        (saved.bodyId === body.bodyId ||
          (body.source === 'fillet' && saved.source === 'fillet')) &&
        saved.faces.length === topology.faces.length * 3 &&
        saved.edges.length === topology.edges.length &&
        saved.faceted === facetedSource(body.source) &&
        saved.vertices.length === body.mesh.vertices.length &&
        saved.indices.length === body.mesh.indices.length &&
        topology.faces.every(
          (face, i) =>
            face.triangleStart === saved.faces[3 * i] &&
            face.triangleCount === saved.faces[3 * i + 1] &&
            face.hash === saved.faces[3 * i + 2]
        ) &&
        topology.edges.every((edge, i) => {
          const previous = saved.edges[i]!;
          const neighbours = edge.adjacentFaceHashes;
          return (
            edge.topologyId === previous.id &&
            (neighbours?.length ?? 0) === previous.neighbours.length &&
            (!neighbours ||
              neighbours.every((hash, j) => hash === previous.neighbours[j]))
          );
        }) &&
        sameMeshBuffer(saved.vertices, body.mesh.vertices) &&
        sameMeshBuffer(saved.indices, body.mesh.indices)
    );
    if (!entry) return;
    if (entry.bodyId !== body.bodyId) {
      this.retain({ ...entry, bodyId: body.bodyId });
    } else if (this.entries[1] === entry) {
      this.entries.reverse();
    }
    // Keep a separate wrapper: installation releases its geometry field.
    // Picking receives the restored projection and all of its current data.
    return {
      geometry: entry.geometry,
      silhouettes: entry.silhouettes,
      tangentIds: entry.tangentIds
    };
  }
}
