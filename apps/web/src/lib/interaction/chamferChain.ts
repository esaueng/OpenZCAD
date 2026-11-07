import { edgeRunSelections } from '@openzcad/viewport/edge-chain';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';

/** Expand a lower planar outline, keeping other edge picks and explicit sets.
 * The common supporting face prevents a smooth walk from leaving the outline.
 */
export function bottomChamferChain(
  body: Pick<BodyRepresentation, 'topology'> | undefined,
  picked: TopologySelection
): TopologySelection[] {
  const edges = body?.topology?.edges;
  const seed = edges?.find((e) => e.topologyId === picked.topologyId);
  const bottom = body?.topology?.faces.find(
    (f) =>
      f.geometry?.surfaceType === 'plane' &&
      (f.geometry.normal?.z ?? 0) < -0.999 &&
      seed?.adjacentFaceHashes?.includes(f.hash)
  );
  if (!edges || !bottom || !picked.topologyId) return [picked];
  const chain = edgeRunSelections(edges, picked.topologyId, picked.bodyId);
  return chain.length > 1 &&
    chain.every((s) =>
      edges
        .find((e) => e.topologyId === s.topologyId)
        ?.adjacentFaceHashes?.includes(bottom.hash)
    )
    ? chain
    : [picked];
}
