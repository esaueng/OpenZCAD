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
 * Every feature with a failed step upstream of it, each mapped to the
 * earliest such step: the failure to fix first.
 *
 * A failed step hands its input on unchanged (ADR-017, November 2026), and a
 * failed in-place edit leaves its target as it was, so what follows it builds
 * on a model the document does not describe. Read from the stored dependency
 * graph — a branch on another body is not affected — and the typed failure
 * record, so it adds no warning. A suppressed step is no failure of its own,
 * but one built on a failure passes that failure on.
 *
 * A failed step with an entry failed after an earlier failure; a failed step
 * without one is a first failure (`historyFailureTier`).
 */
export function failureLineage(
  document: ProjectDocument,
  failed: ReadonlySet<FeatureId>
): Map<FeatureId, FeatureNode> {
  return walkFailureLineage(document, failed).lineage;
}

function walkFailureLineage(
  document: ProjectDocument,
  failed: ReadonlySet<FeatureId>
): { features: FeatureNode[]; lineage: Map<FeatureId, FeatureNode> } {
  const lineage = new Map<FeatureId, FeatureNode>();
  if (failed.size === 0) return { features: [], lineage };
  const { features, parents } = featureHistory(document);
  const position = new Map(
    features.map((feature, index) => [feature.featureId, index])
  );
  // The earliest failed step each feature's inputs descend from, or the
  // feature itself when it is a first failure.
  const origin = new Map<FeatureId, FeatureNode>();
  for (const feature of features) {
    const own = failed.has(feature.featureId) && !isFeatureSuppressed(feature);
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
      lineage.set(feature.featureId, earliest);
    } else if (own) {
      origin.set(feature.featureId, feature);
    }
  }
  return { features, lineage };
}

/**
 * Features that built, but on a history with a failed step upstream of them,
 * each mapped to the earliest such failed step (`failureLineage` without the
 * failed and suppressed steps). Those steps are not failures; this says which
 * ones stand on one.
 */
export function builtOnFailedFeatures(
  document: ProjectDocument,
  failed: ReadonlySet<FeatureId>
): Map<FeatureId, FeatureNode> {
  const { features, lineage } = walkFailureLineage(document, failed);
  const dependents = new Map<FeatureId, FeatureNode>();
  for (const feature of features) {
    const root = lineage.get(feature.featureId);
    if (
      root &&
      !failed.has(feature.featureId) &&
      !isFeatureSuppressed(feature)
    ) {
      dependents.set(feature.featureId, root);
    }
  }
  return dependents;
}

/**
 * How a History row reads a failure: `root`, the first failure in its chain
 * and the one to fix; `downstream`, a step that failed after an earlier
 * failure; `built-on-failed`, a step that built, on a failed step's input.
 */
export type HistoryFailureTier = 'root' | 'downstream' | 'built-on-failed';

export function historyFailureTier(
  featureId: FeatureId,
  needsRepair: boolean,
  lineage: ReadonlyMap<FeatureId, FeatureNode>
): HistoryFailureTier | null {
  const root = lineage.has(featureId);
  if (needsRepair) return root ? 'downstream' : 'root';
  return root ? 'built-on-failed' : null;
}

/**
 * The steps that need repair in the order to visit them: the first failures,
 * then the steps that failed after them, each in history order.
 */
export function failedStepsInRepairOrder<
  T extends Pick<FeatureNode, 'featureId'>
>(
  features: readonly T[],
  needsRepair: ReadonlySet<FeatureId>,
  lineage: ReadonlyMap<FeatureId, FeatureNode>
): T[] {
  const failed = features.filter((feature) =>
    needsRepair.has(feature.featureId)
  );
  return [
    ...failed.filter((feature) => !lineage.has(feature.featureId)),
    ...failed.filter((feature) => lineage.has(feature.featureId))
  ];
}
