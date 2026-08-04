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
 * matching the existing transformed-cylinder behavior, while any direct edit
 * on a body in the chain remains a hard boundary.
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
  const hasDependentDirectEdit = features.some((feature, index) => {
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
    return index > producerIndex && index < consumerIndex;
  });
  return hasDependentDirectEdit ? null : primitive;
}
