import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * A 40 × 30 × 20 box with its four vertical edges rounded at R 5, so its top
 * outline is one tangent chain of four lines and four arcs (M03 tangent-chain
 * fixture). `sync` is an exact adapter's `syncDocument`.
 */
export const CORNER_RADIUS = 5;

export async function roundedCornerBox(
  sync: (document: ProjectDocument) => Promise<{
    bodyRepresentations: Record<
      string,
      { volume: number; topology?: { edges: EdgeTopology[] } } | undefined
    >;
  }>
): Promise<{
  document: ProjectDocument;
  bodyId: BodyId;
  volume: number;
  topOutline: EdgeTopology[];
}> {
  let document = addPrimitiveFeature(
    createProjectDocument('Rounded corners', toUserId('user_tangent_chain')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    }
  );
  const box = document.bodyOrder.at(-1) as BodyId;
  const ends = (edge: EdgeTopology) => {
    const witness = edge.reference?.witness;
    return witness && !witness.closed
      ? witness.endpoints.map((point) => point.map((v) => v * 1e-6))
      : [];
  };
  const built = (await sync(document)).bodyRepresentations[box]!;
  const vertical = built.topology!.edges.filter((edge) => {
    const [p, q] = ends(edge);
    return p !== undefined && q !== undefined && Math.abs(p[2]! - q[2]!) > 1;
  });
  const rounded = filletEdges(document, {
    name: 'Corners',
    targetBodyId: box,
    edgeHashes: vertical.map((edge) => edge.hash),
    edgeReferences: vertical.map((edge) => edge.reference!),
    size: CORNER_RADIUS
  });
  document = rounded.document;
  const body = (await sync(document)).bodyRepresentations[rounded.bodyId]!;
  const topOutline = body.topology!.edges.filter((edge) => {
    const points = ends(edge);
    return (
      points.length === 2 && points.every((point) => point[2]! > 20 - 1e-6)
    );
  });
  return { document, bodyId: rounded.bodyId, volume: body.volume, topOutline };
}

/**
 * Volume a constant R `r` round takes off the rounded box's top outline:
 * the corner section (1 − π/4)·r² along the straight runs, and around each
 * corner arc by Pappus at its centroid, (10 − 3π)/(3(4 − π))·r in from the
 * outline.
 */
export function topOutlineRoundRemoval(
  r: number,
  straightLength: number
): number {
  const section = (1 - Math.PI / 4) * r * r;
  const inset = (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
  return (
    section * (straightLength + 4 * (Math.PI / 2) * (CORNER_RADIUS - inset))
  );
}
