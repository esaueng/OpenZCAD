import { isFeatureSuppressed } from '@openzcad/shared';
import type { FeatureId, FeatureNode, FeatureWarning } from '@openzcad/shared';

/**
 * Features the rebuild could not build, or refused, by the typed warning
 * record. Advisory and suppressed warnings are not failures.
 */
export function failedFeatureIds(
  warnings: readonly FeatureWarning[] | undefined
): Set<FeatureId> {
  return new Set(
    (warnings ?? [])
      .filter(
        (warning) =>
          warning.kind === 'build-failed' || warning.kind === 'refusal'
      )
      .map((warning) => warning.featureId)
  );
}

/**
 * The history row's "needs repair": a feature that should build a body and
 * did not, or one the rebuild reported as failed. The second case covers
 * features that own no body — a transform edits its target in place, so the
 * target still exists when the transform fails. Suppressed features build
 * nothing on purpose, and a sketch never owns a body, so neither counts.
 */
export function featureNeedsRepair(
  feature: Pick<FeatureNode, 'metadata' | 'bodyId' | 'featureKind'> & {
    featureId?: FeatureId;
  },
  representations: Readonly<Record<string, unknown>>,
  failed?: ReadonlySet<FeatureId>
): boolean {
  if (isFeatureSuppressed(feature) || feature.featureKind === 'sketch') {
    return false;
  }
  if (
    feature.featureId !== undefined &&
    failed?.has(feature.featureId) === true
  ) {
    return true;
  }
  return (
    feature.bodyId !== undefined &&
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
