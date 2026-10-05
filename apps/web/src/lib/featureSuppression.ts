import {
  isFeatureSuppressed,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { featureHistory, featureResultBodyIds } from './featureHistory';
import { FeatureBuildError, refusingWarning } from './featureValidation';

/**
 * Suppression may pass a body through, but never substitute a topology pick.
 * Judge every active dependent using the exact candidate rebuild, including
 * in-place edits, attached sketches and both split results. Report the whole
 * refused branch so the user can pause its dependents deliberately.
 */
export function validateFeatureSuppression(
  document: ProjectDocument,
  derived: ProjectDocument['derived'],
  source: FeatureNode
): void {
  const failures = featureHistory(document)
    .downstream(source.featureId)
    .filter((feature) => !isFeatureSuppressed(feature))
    .flatMap((feature) => {
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
      return reason ? [{ feature, reason }] : [];
    });
  const first = failures[0];
  if (!first) return;
  throw new FeatureBuildError(
    `Cannot suppress "${source.name}". Dependent features cannot rebuild: ${failures.map(({ feature, reason }) => `"${feature.name}": ${reason}`).join('; ')}`,
    first.feature.featureId,
    first.feature.name
  );
}
