import * as THREE from 'three';
import type { BodyTopology, MeshGeometry } from '@openzcad/shared';

/**
 * The widest angle between the two faces' normals at which an edge still
 * reads as one smooth surface.
 *
 * The normals are measured on the display mesh, one side at a time, so each
 * is off the exact surface normal by up to the display tessellation's angular
 * deflection (`DISPLAY_ANGULAR_DEFLECTION`, 0.06 rad ≈ 3.4°). A fillet
 * meeting another curved face can therefore measure about 7° across an
 * exactly tangent edge. Twelve keeps clear of that while every sharp edge a
 * part is normally drawn with — 90° walls, 45° chamfers, drafts of 15° and
 * up — stays sharp.
 */
export const TANGENT_EDGE_MAX_ANGLE = THREE.MathUtils.degToRad(12);

/**
 * The topology ids of the edges whose two faces meet tangentially (G1): the
 * rim where a fillet rolls into the wall, or the joint between two halves of
 * one cylinder.
 *
 * The kernel publishes no smoothness, so this compares the faces on the
 * display mesh, which is welded at face boundaries. At every mesh vertex two
 * faces share, each face's own normal there is the angle-weighted mean of its
 * triangles at that vertex — the smoothing the face is shaded with. A face
 * pair is tangent when that angle stays within `TANGENT_EDGE_MAX_ANGLE` at
 * every vertex they share, and an edge is tangent when its pair is.
 *
 * It errs towards sharp, which is how every edge drew before: an edge with no
 * face pair, faces the hashes cannot tell apart (a sphere's two hemispheres
 * hash alike), a pair that shares no mesh vertex, or a pair with any one
 * corner that measures sharp. Two faces meeting along a tangent edge and a
 * sharp one both therefore count as sharp.
 *
 * One pass over the triangles with typed arrays and no per-vertex objects:
 * the overlay builds this on the main thread when a body is installed, and a
 * 20k-edge import has a mesh of hundreds of thousands of triangles.
 */
export function tangentEdgeIds(
  mesh: Pick<MeshGeometry, 'vertices' | 'indices'>,
  topology: Pick<BodyTopology, 'faces' | 'edges'>
): Set<string> {
  const tangent = new Set<string>();
  const faces = topology.faces;
  const faceCount = faces.length;
  const vertexCount = Math.floor(mesh.vertices.length / 3);
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (faceCount < 2 || vertexCount === 0 || triangleCount === 0) {
    return tangent;
  }
  const indices = mesh.indices;
  const positions = mesh.vertices;
  const triangleRange = (face: BodyTopology['faces'][number]) =>
    [
      Math.max(0, Math.floor(face.triangleStart)),
      Math.min(
        triangleCount,
        Math.ceil(face.triangleStart + face.triangleCount)
      )
    ] as const;

  // Vertices touched by triangles of two or more faces.
  const firstFace = new Int32Array(vertexCount).fill(-1);
  const shared = new Uint8Array(vertexCount);
  let sharedCorners = 0;
  for (let face = 0; face < faceCount; face += 1) {
    const [start, end] = triangleRange(faces[face]!);
    for (let corner = start * 3; corner < end * 3; corner += 1) {
      const vertex = indices[corner]!;
      if (vertex >= vertexCount) continue;
      if (firstFace[vertex]! < 0) {
        firstFace[vertex] = face;
      } else if (firstFace[vertex] !== face) {
        shared[vertex] = 1;
      }
    }
  }
  for (let face = 0; face < faceCount; face += 1) {
    const [start, end] = triangleRange(faces[face]!);
    for (let corner = start * 3; corner < end * 3; corner += 1) {
      if (shared[indices[corner]!]) sharedCorners += 1;
    }
  }
  if (sharedCorners === 0) {
    return tangent;
  }

  // One slot per (shared vertex, face), chained per vertex: a vertex is shared
  // by two faces along an edge and three or four at a corner, so the chain
  // walk is shorter than any hash lookup.
  const headSlot = new Int32Array(vertexCount).fill(-1);
  const nextSlot = new Int32Array(sharedCorners);
  const slotFace = new Int32Array(sharedCorners);
  const slotNormal = new Float64Array(sharedCorners * 3);
  let slotCount = 0;
  const accumulate = (
    vertex: number,
    face: number,
    nx: number,
    ny: number,
    nz: number,
    angle: number
  ) => {
    let slot = headSlot[vertex]!;
    while (slot >= 0 && slotFace[slot] !== face) slot = nextSlot[slot]!;
    if (slot < 0) {
      slot = slotCount;
      slotCount += 1;
      slotFace[slot] = face;
      nextSlot[slot] = headSlot[vertex]!;
      headSlot[vertex] = slot;
    }
    slotNormal[slot * 3] = slotNormal[slot * 3]! + nx * angle;
    slotNormal[slot * 3 + 1] = slotNormal[slot * 3 + 1]! + ny * angle;
    slotNormal[slot * 3 + 2] = slotNormal[slot * 3 + 2]! + nz * angle;
  };
  for (let face = 0; face < faceCount; face += 1) {
    const [start, end] = triangleRange(faces[face]!);
    for (let triangle = start; triangle < end; triangle += 1) {
      const offset = triangle * 3;
      const v0 = indices[offset]!;
      const v1 = indices[offset + 1]!;
      const v2 = indices[offset + 2]!;
      if (v0 >= vertexCount || v1 >= vertexCount || v2 >= vertexCount) {
        continue;
      }
      if (!shared[v0] && !shared[v1] && !shared[v2]) continue;
      const p0 = v0 * 3;
      const p1 = v1 * 3;
      const p2 = v2 * 3;
      const ax = positions[p1]! - positions[p0]!;
      const ay = positions[p1 + 1]! - positions[p0 + 1]!;
      const az = positions[p1 + 2]! - positions[p0 + 2]!;
      const bx = positions[p2]! - positions[p0]!;
      const by = positions[p2 + 1]! - positions[p0 + 1]!;
      const bz = positions[p2 + 2]! - positions[p0 + 2]!;
      const cx = positions[p2]! - positions[p1]!;
      const cy = positions[p2 + 1]! - positions[p1 + 1]!;
      const cz = positions[p2 + 2]! - positions[p1 + 2]!;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      // A sliver has no direction to contribute.
      if (length === 0) continue;
      nx /= length;
      ny /= length;
      nz /= length;
      if (shared[v0]) {
        accumulate(v0, face, nx, ny, nz, angleBetween(ax, ay, az, bx, by, bz));
      }
      if (shared[v1]) {
        accumulate(
          v1,
          face,
          nx,
          ny,
          nz,
          angleBetween(-ax, -ay, -az, cx, cy, cz)
        );
      }
      if (shared[v2]) {
        accumulate(
          v2,
          face,
          nx,
          ny,
          nz,
          angleBetween(-bx, -by, -bz, -cx, -cy, -cz)
        );
      }
    }
  }

  // The smallest normal agreement every face pair reaches at a shared vertex.
  const pairDot = new Map<number, number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let a = headSlot[vertex]!; a >= 0; a = nextSlot[a]!) {
      for (let b = nextSlot[a]!; b >= 0; b = nextSlot[b]!) {
        const dot = unitDot(slotNormal, a, b);
        const key = pairKey(slotFace[a]!, slotFace[b]!, faceCount);
        const previous = pairDot.get(key);
        if (previous === undefined || dot < previous) pairDot.set(key, dot);
      }
    }
  }

  // A hash two faces share names neither of them.
  const faceByHash = new Map<number, number>();
  faces.forEach((face, index) => {
    faceByHash.set(face.hash, faceByHash.has(face.hash) ? -1 : index);
  });
  const tangentDot = Math.cos(TANGENT_EDGE_MAX_ANGLE);
  for (const edge of topology.edges) {
    const hashes = [...new Set(edge.adjacentFaceHashes ?? [])];
    if (hashes.length !== 2) continue;
    const first = faceByHash.get(hashes[0]!) ?? -1;
    const second = faceByHash.get(hashes[1]!) ?? -1;
    if (first < 0 || second < 0) continue;
    const dot = pairDot.get(pairKey(first, second, faceCount));
    if (dot !== undefined && dot >= tangentDot) tangent.add(edge.topologyId);
  }
  return tangent;
}

function pairKey(first: number, second: number, faceCount: number) {
  return first < second
    ? first * faceCount + second
    : second * faceCount + first;
}

function angleBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
) {
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(
    Math.sqrt(cx * cx + cy * cy + cz * cz),
    ax * bx + ay * by + az * bz
  );
}

function unitDot(normals: Float64Array, a: number, b: number) {
  const ax = normals[a * 3]!;
  const ay = normals[a * 3 + 1]!;
  const az = normals[a * 3 + 2]!;
  const bx = normals[b * 3]!;
  const by = normals[b * 3 + 1]!;
  const bz = normals[b * 3 + 2]!;
  const scale =
    Math.sqrt(ax * ax + ay * ay + az * az) *
    Math.sqrt(bx * bx + by * by + bz * bz);
  return scale > 0 ? (ax * bx + ay * by + az * bz) / scale : -1;
}
