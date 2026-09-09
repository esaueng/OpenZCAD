import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

export async function twoFilletCylinder(
  adapter: ExactKernelAdapter,
  bottomRadius = 4
) {
  let document = addPrimitiveFeature(
    createProjectDocument('Two rim fillets', toUserId('user_fixture')),
    {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 46, height: 33 }
    }
  );
  for (const [side, radius] of [
    ['end', 3],
    ['start', bottomRadius]
  ] as const) {
    const bodyId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    const edge = derived.bodyRepresentations[bodyId]!.topology!.edges.find(
      (candidate) =>
        candidate.reference?.lineageName.endsWith(`edge.rim.${side}`)
    );
    if (!edge?.reference)
      throw new Error(`Fixture rim ${side} has no reference`);
    document = filletEdges(document, {
      name: 'Fillet edges',
      targetBodyId: bodyId,
      size: radius,
      edgeHashes: [edge.hash],
      edgeReferences: [edge.reference]
    }).document;
  }
  const features = listFeaturesInOrder(document);
  return {
    document,
    top: features[1]!,
    bottom: features[2]!,
    bodyId: document.bodyOrder.at(-1)!
  };
}
