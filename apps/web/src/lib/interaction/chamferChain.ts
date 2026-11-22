import { edgeRunSelections } from '@openzcad/viewport/edge-chain';
import type {
  BodyRepresentation,
  EdgeTopology,
  TopologySelection
} from '@openzcad/shared';

type TopologyBody = Pick<BodyRepresentation, 'topology'> | undefined;

/**
 * Whether an edge is one a fillet or chamfer can take: a drawn feature edge
 * with a real crease. A seam only closes a periodic surface's UV, and a G1
 * boundary (a flat face running into the round it is tangent to) has no
 * corner to cut. `isSmooth` absent is an older projection that never said,
 * so it is kept, as the rest of the edge tools keep it.
 */
function blendable(edge: EdgeTopology): boolean {
  return edge.displayRole !== 'seam' && edge.isSmooth !== true;
}

function selectionOf(
  bodyId: TopologySelection['bodyId'],
  edge: EdgeTopology
): TopologySelection {
  return {
    bodyId,
    kind: 'edge',
    topologyId: edge.topologyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

/**
 * The whole smooth outline one picked edge belongs to, when that outline
 * lies on a single flat face — the rim of a filleted plate, or the bottom of
 * a box unioned with a boss — and otherwise just the pick.
 *
 * The smooth walk alone is not enough: at its 50 degree tolerance it can turn
 * up a vertical blend and leave the outline. Requiring every edge of the run
 * to bound one planar face the pick also bounds keeps it on the rim.
 *
 * Any flat face qualifies, not only a downward one: picking the top rim of a
 * part and wanting all of it is the same request as picking the bottom one.
 */
export function outlineChamferChain(
  body: TopologyBody,
  picked: TopologySelection
): TopologySelection[] {
  const edges = body?.topology?.edges;
  const faces = body?.topology?.faces;
  const seed = edges?.find((e) => e.topologyId === picked.topologyId);
  if (!edges || !faces || !seed || !picked.topologyId) return [picked];
  const supports = faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      seed.adjacentFaceHashes?.includes(face.hash)
  );
  if (supports.length === 0) return [picked];
  const chain = edgeRunSelections(edges, picked.topologyId, picked.bodyId);
  if (chain.length < 2) return [picked];
  const onSupport = supports.some((support) =>
    chain.every((selection) =>
      edges
        .find((e) => e.topologyId === selection.topologyId)
        ?.adjacentFaceHashes?.includes(support.hash)
    )
  );
  return onSupport ? chain : [picked];
}

/**
 * Every edge a fillet or chamfer can take around one picked face: its outer
 * outline and the rim of any hole through it, as a CAD user means when they
 * pick a face and ask to chamfer "its edges".
 *
 * Empty when the face is not on the body or bounds no such edge (a sphere,
 * or a face whose every boundary is tangent).
 */
export function faceBoundaryEdges(
  body: TopologyBody,
  face: Pick<TopologySelection, 'bodyId' | 'topologyId' | 'hash'>
): TopologySelection[] {
  const topology = body?.topology;
  if (!topology) return [];
  const target =
    (face.topologyId !== undefined
      ? topology.faces.find((f) => f.topologyId === face.topologyId)
      : undefined) ??
    (face.hash !== undefined
      ? topology.faces.find((f) => f.hash === face.hash)
      : undefined);
  if (!target) return [];
  return topology.edges
    .filter(
      (edge) =>
        blendable(edge) && edge.adjacentFaceHashes?.includes(target.hash)
    )
    .map((edge) => selectionOf(face.bodyId, edge));
}

/**
 * M03: the edges a tangent-chain pick adds to a blend's picks — the smooth
 * run through the last picked edge, in run order, less the edges already
 * picked and anything the blend cannot take (a seam, or for a chamfer a
 * boundary that is already smooth).
 *
 * Empty when the last pick is on no shown body or its run is just itself.
 * The chain is offered, never applied for the user: a run can climb a round
 * the user meant to leave, and the blend then decides each edge exactly or
 * refuses it by name (a variable radius along an arc is one it refuses).
 */
export function tangentChainAdditions(
  body: TopologyBody,
  picks: readonly Pick<TopologySelection, 'topologyId' | 'hash'>[],
  bodyId: TopologySelection['bodyId'],
  chamfer: boolean
): TopologySelection[] {
  const edges = body?.topology?.edges;
  const seed = picks.at(-1);
  if (!edges || !seed?.topologyId) return [];
  if (!edges.some((edge) => edge.topologyId === seed.topologyId)) return [];
  const picked = new Set(picks.map((pick) => pick.hash));
  return edgeRunSelections(edges, seed.topologyId, bodyId).filter(
    (selection) => {
      if (picked.has(selection.hash)) return false;
      const edge = edges.find(
        (candidate) => candidate.topologyId === selection.topologyId
      );
      return (
        edge !== undefined &&
        edge.displayRole !== 'seam' &&
        (!chamfer || edge.isSmooth !== true)
      );
    }
  );
}
