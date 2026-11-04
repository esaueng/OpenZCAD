import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

export async function nativeDetail(
  adapter: ExactKernelAdapter,
  kind: 'hole' | 'chamfer',
  hole: {
    style?: 'simple' | 'counterbore';
    depthMode?: 'through' | 'blind';
  } = {},
  chamferEdgeCount = 1
) {
  const source = addPrimitiveFeature(
    createProjectDocument('Picked detail', toUserId('user_fixture')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 24, depth: 18 }
    }
  );
  const sourceId = source.bodyOrder[0]!;
  const derived = await adapter.syncDocument(source);
  const body = derived.bodyRepresentations[sourceId]!;
  const top = body.topology!.faces.find(
    (face) => face.reference?.lineageName === 'primitive.box.face.z-max'
  )!;
  const edges = body
    .topology!.edges.filter(
      (candidate) =>
        candidate.displayRole !== 'seam' &&
        (chamferEdgeCount === 1 ||
          Math.abs(candidate.points[2]! - candidate.points.at(-1)!) > 1)
    )
    .slice(0, chamferEdgeCount);
  const result =
    kind === 'hole'
      ? holeBody(source, {
          name: 'Hole',
          targetBodyId: sourceId,
          faceHash: top.hash,
          faceReference: top.reference,
          style: hole.style ?? 'simple',
          diameter: 6,
          depthMode: hole.depthMode ?? 'through',
          depth: 8,
          counterboreDiameter: 10,
          counterboreDepth: 3,
          position: { u: 0, v: 0 }
        })
      : chamferEdges(source, {
          name: 'Chamfer',
          targetBodyId: sourceId,
          size: 2,
          edgeHashes: edges.map((edge) => edge.hash),
          ...(edges.every((edge) => edge.reference)
            ? { edgeReferences: edges.map((edge) => edge.reference!) }
            : {})
        });
  return {
    ...result,
    source,
    sourceId,
    feature: listFeaturesInOrder(result.document).at(-1)!
  };
}
