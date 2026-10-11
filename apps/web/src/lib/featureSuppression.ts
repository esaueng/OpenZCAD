import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { findFeature } from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureSuppressed,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { featureHistory, featureResultBodyIds } from './featureHistory';
import { FeatureBuildError, refusingWarning } from './featureValidation';

/** A later feature that cannot rebuild once the source is suppressed. */
export interface RefusedDependent {
  featureId: FeatureId;
  name: string;
  /** The rebuild's own reason. Kernel wording: for logs, never the UI. */
  reason: string;
}

/** How many dependents a refusal sentence names before it counts the rest. */
const NAMED_IN_SENTENCE = 3;

function listNames(names: readonly string[]): string {
  const named = names.slice(0, NAMED_IN_SENTENCE).map((name) => `"${name}"`);
  const rest = names.length - named.length;
  if (rest > 0) return `${named.join(', ')} and ${rest} more`;
  if (named.length <= 1) return named.join('');
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/**
 * The plain sentence for a refused suppression. It names features only: the
 * per-dependent reasons are kernel sentences that can carry internal ids, and
 * the dialog that answers this refusal lists the dependents by name anyway.
 */
export function suppressionRefusalMessage(
  sourceName: string,
  dependents: readonly Pick<RefusedDependent, 'name'>[]
): string {
  const count = dependents.length;
  return `"${sourceName}" is used by ${count} later ${count === 1 ? 'feature' : 'features'} that cannot rebuild without it: ${listNames(dependents.map((dependent) => dependent.name))}.`;
}

/**
 * Suppressing a feature that later features still need. Attributed to the
 * feature the user acted on, never to the first dependent: the user asked
 * about the source, and a failure record filed under a dependent reads as if
 * that dependent's own edit had been refused.
 */
export class FeatureSuppressionRefusal extends FeatureBuildError {
  constructor(
    source: Pick<FeatureNode, 'featureId' | 'name'>,
    public readonly dependents: readonly RefusedDependent[]
  ) {
    super(
      suppressionRefusalMessage(source.name, dependents),
      source.featureId,
      source.name
    );
    this.name = 'FeatureSuppressionRefusal';
  }
}

/**
 * Suppression may pass a body through, but never substitute a topology pick.
 * Judge every active dependent using the exact candidate rebuild, including
 * in-place edits, attached sketches and both split results. Report the whole
 * refused branch so the user can pause its dependents deliberately.
 *
 * `sources` is the set being suppressed together, the one the user acted on
 * first. Its members are not dependents of each other for this check: a
 * suppressed feature is meant to drop out of the build.
 */
export function suppressionRefusal(
  document: ProjectDocument,
  derived: ProjectDocument['derived'],
  sources: FeatureNode | readonly FeatureNode[]
): FeatureSuppressionRefusal | null {
  const list: readonly FeatureNode[] = Array.isArray(sources)
    ? sources
    : [sources as FeatureNode];
  const primary = list[0];
  if (!primary) return null;
  const paused = new Set(list.map((feature) => feature.featureId));
  const graph = featureHistory(document);
  const seen = new Set<FeatureId>();
  const dependents = list
    .flatMap((source) => graph.downstream(source.featureId))
    .filter((feature) => {
      if (seen.has(feature.featureId)) return false;
      seen.add(feature.featureId);
      return !paused.has(feature.featureId) && !isFeatureSuppressed(feature);
    });
  // History order, whatever order the sources arrived in.
  const order = new Map(
    graph.features.map((feature, index) => [feature.featureId, index])
  );
  dependents.sort(
    (a, b) => (order.get(a.featureId) ?? 0) - (order.get(b.featureId) ?? 0)
  );
  const refused = dependents.flatMap((feature): RefusedDependent[] => {
    const reason =
      refusingWarning(
        feature.name,
        derived.warnings,
        derived.featureWarnings,
        feature.featureId
      ) ??
      (featureResultBodyIds(feature).some(
        (id) => !derived.bodyRepresentations[id]
      )
        ? 'The dependent feature did not produce its result body.'
        : null);
    return reason
      ? [{ featureId: feature.featureId, name: feature.name, reason }]
      : [];
  });
  return refused.length
    ? new FeatureSuppressionRefusal(primary, refused)
    : null;
}

/** Throws the refusal, for a validated commit's `validateDerived` hook. */
export function validateFeatureSuppression(
  document: ProjectDocument,
  derived: ProjectDocument['derived'],
  sources: FeatureNode | readonly FeatureNode[]
): void {
  const refusal = suppressionRefusal(document, derived, sources);
  if (refusal) throw refusal;
}

/**
 * The features of a branch suppression as they stand in `document` now: the
 * source first, then the dependents, each resolved by feature id. A feature
 * deleted meanwhile is dropped, and so is one already suppressed, which needs
 * no command. The source is null when it is gone.
 */
export function resolveSuppressionBranch(
  document: ProjectDocument,
  sourceId: FeatureId,
  dependentIds: readonly FeatureId[]
): { source: FeatureNode | null; features: FeatureNode[] } {
  const source = findFeature(document, sourceId) ?? null;
  if (!source) return { source: null, features: [] };
  const features = [sourceId, ...dependentIds]
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .flatMap((id) => {
      const feature = findFeature(document, id);
      return feature ? [feature] : [];
    });
  return { source, features };
}

/** One metadata command per feature that is not suppressed already. */
export function suppressCommands(
  features: readonly FeatureNode[],
  label: string
): AnyCommand[] {
  return features
    .filter((feature) => !isFeatureSuppressed(feature))
    .map((feature) =>
      commandFactories.setNodeMetadata(
        {
          nodeId: feature.id,
          metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
        },
        label
      )
    );
}

function branchWords(sourceName: string, dependentCount: number): string {
  return dependentCount === 0
    ? sourceName
    : `${sourceName} and ${dependentCount} later ${dependentCount === 1 ? 'feature' : 'features'}`;
}

/** The undo label of a branch suppression: "Undo Suppress Boss and 2 …". */
export function suppressBranchLabel(
  sourceName: string,
  dependentCount: number
): string {
  return `Suppress ${branchWords(sourceName, dependentCount)}`;
}

/** The toast after a branch suppression lands. */
export function suppressedBranchMessage(
  sourceName: string,
  dependentCount: number
): string {
  return `Suppressed ${branchWords(sourceName, dependentCount)}`;
}
