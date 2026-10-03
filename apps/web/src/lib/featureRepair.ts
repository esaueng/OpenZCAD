import { isFeatureSuppressed } from '@openzcad/shared';
import type { FeatureId, FeatureNode } from '@openzcad/shared';

/**
 * The history row's "needs repair": a feature that should build a body and
 * did not. Suppressed features build nothing on purpose, and a sketch never
 * owns a body, so neither counts.
 */
export function featureNeedsRepair(
  feature: Pick<FeatureNode, 'metadata' | 'bodyId' | 'featureKind'>,
  representations: Readonly<Record<string, unknown>>
): boolean {
  return (
    !isFeatureSuppressed(feature) &&
    feature.bodyId !== undefined &&
    feature.featureKind !== 'sketch' &&
    representations[feature.bodyId] === undefined
  );
}

/** Every feature the rebuild left needing repair, by id. */
export function featuresNeedingRepair(
  features: readonly FeatureNode[],
  representations: Readonly<Record<string, unknown>>
): Set<FeatureId> {
  return new Set(
    features
      .filter((feature) => featureNeedsRepair(feature, representations))
      .map((feature) => feature.featureId)
  );
}
