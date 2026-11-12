import { isFeatureSuppressed } from '@openzcad/shared';
import type {
  FeatureId,
  FeatureNode,
  FeatureWarning,
  ProjectDocument
} from '@openzcad/shared';
import { featureHistory } from './featureHistory';

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

/**
 * Every feature the rebuild left needing repair, by id. Pass the rebuild's
 * typed warnings where they are known: a failed feature that replaces its
 * input passes that input through under its own id (ADR-017, November 2026),
 * so a missing body no longer finds it.
 */
export function featuresNeedingRepair(
  features: readonly FeatureNode[],
  representations: Readonly<Record<string, unknown>>,
  warnings?: readonly FeatureWarning[]
): Set<FeatureId> {
  const failed = failedFeatureIds(warnings);
  return new Set(
    features
      .filter((feature) => featureNeedsRepair(feature, representations, failed))
      .map((feature) => feature.featureId)
  );
}

/**
 * Features that built, but on a history with a failed step upstream of them,
 * each mapped to the earliest such failed step.
 *
 * A failed step hands its input on unchanged (ADR-017, November 2026), and a
 * failed in-place edit leaves its target as it was, so what builds after it
 * builds on a model the document does not describe. Those steps are not
 * failures; this says which ones stand on one. Read from the stored
 * dependency graph — a branch on another body is not affected — and the
 * typed failure record, so it adds no warning.
 */
export function builtOnFailedFeatures(
  document: ProjectDocument,
  failed: ReadonlySet<FeatureId>
): Map<FeatureId, FeatureNode> {
  const dependents = new Map<FeatureId, FeatureNode>();
  if (failed.size === 0) return dependents;
  const { features, parents } = featureHistory(document);
  const position = new Map(
    features.map((feature, index) => [feature.featureId, index])
  );
  // The earliest failed step each feature's inputs descend from.
  const origin = new Map<FeatureId, FeatureNode>();
  for (const feature of features) {
    const suppressed = isFeatureSuppressed(feature);
    const own = failed.has(feature.featureId) && !suppressed;
    let earliest: FeatureNode | undefined;
    for (const parent of parents.get(feature.featureId) ?? []) {
      const source = origin.get(parent);
      if (
        source &&
        (!earliest ||
          position.get(source.featureId)! < position.get(earliest.featureId)!)
      ) {
        earliest = source;
      }
    }
    if (earliest) {
      origin.set(feature.featureId, earliest);
      if (!own && !suppressed) dependents.set(feature.featureId, earliest);
    } else if (own) {
      origin.set(feature.featureId, feature);
    }
  }
  return dependents;
}
