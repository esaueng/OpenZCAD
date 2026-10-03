import type { BodyTopology, EdgeTopology } from '@openzcad/shared';

/** Physical edges that bound one published face. */
export function boundaryEdgesOfFace(
  topology: BodyTopology,
  faceHash: number
): EdgeTopology[] {
  return topology.edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      edge.adjacentFaceHashes?.includes(faceHash) === true
  );
}

/**
 * Physical edges that bound a set of faces as one region. An edge between
 * two faces of the set lies inside the region and is left out, so the faces
 * a History row lights are rimmed around their outline rather than along
 * every edge between them. One face is {@link boundaryEdgesOfFace}.
 */
export function boundaryEdgesOfFaces(
  topology: BodyTopology,
  faceHashes: readonly number[]
): EdgeTopology[] {
  if (faceHashes.length === 1) {
    return boundaryEdgesOfFace(topology, faceHashes[0]!);
  }
  const region = new Set(faceHashes);
  return topology.edges.filter((edge) => {
    if (edge.displayRole === 'seam') {
      return false;
    }
    const adjacent = edge.adjacentFaceHashes ?? [];
    return (
      adjacent.some((hash) => region.has(hash)) &&
      adjacent.some((hash) => !region.has(hash))
    );
  });
}
