import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Finds the literal cylinder primitive that owns one selected cylindrical wall.
 *
 * Fillets and chamfers create new BodyIds, so a wall on their result no longer
 * points directly at the primitive. Walk only that uninterrupted result-body
 * ancestry: crossing another body-producing feature would make a primitive
 * radius edit ambiguous. In-place transforms are deliberately transparent,
 * matching the existing transformed-cylinder behavior.
 *
 * Direct edits in the chain are transparent only for a planar face offset
 * that carries a v5 face reference: the operation is radius-independent and
 * re-resolves its face by lineage, so a primitive radius edit regenerates it
 * exactly. Every other direct edit — an absolute-radius wall resize above
 * all — remains a hard boundary, because its recorded measurements pin the
 * pre-edit geometry.
 */
export function primitiveCylinderRadiusAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId
): FeatureNode | null {
  const features = listFeaturesInOrder(document);
  const producerByBodyId = new Map(
    features.flatMap((feature) =>
      feature.bodyId ? [[feature.bodyId, feature] as const] : []
    )
  );
  const ancestryBodyIds = new Set<BodyId>();
  const consumerIndexByBodyId = new Map<BodyId, number>();
  let bodyId = selectedBodyId;
  let primitive: FeatureNode | null = null;

  while (!ancestryBodyIds.has(bodyId)) {
    ancestryBodyIds.add(bodyId);
    const producer = producerByBodyId.get(bodyId);
    if (!producer || isFeatureSuppressed(producer)) {
      return null;
    }
    if (
      producer.data.featureKind === 'primitive' &&
      producer.data.primitiveKind === 'cylinder' &&
      typeof producer.data.dimensions.radius === 'number'
    ) {
      primitive = producer;
      break;
    }
    if (
      producer.data.featureKind !== 'fillet' &&
      producer.data.featureKind !== 'chamfer'
    ) {
      return null;
    }
    consumerIndexByBodyId.set(
      producer.data.targetBodyId,
      features.indexOf(producer)
    );
    bodyId = producer.data.targetBodyId;
  }

  if (!primitive) {
    return null;
  }
  const hasBlockingDirectEdit = features.some((feature, index) => {
    if (
      isFeatureSuppressed(feature) ||
      feature.data.featureKind !== 'direct-edit' ||
      !ancestryBodyIds.has(feature.data.targetBodyId)
    ) {
      return false;
    }
    const producer = producerByBodyId.get(feature.data.targetBodyId);
    const producerIndex = producer ? features.indexOf(producer) : -1;
    const consumerIndex =
      consumerIndexByBodyId.get(feature.data.targetBodyId) ?? features.length;
    if (index <= producerIndex || index >= consumerIndex) {
      return false;
    }
    return !(
      feature.data.operation.kind === 'offset-face' &&
      feature.data.operation.faceReference
    );
  });
  return hasBlockingDirectEdit ? null : primitive;
}
