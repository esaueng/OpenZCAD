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
