import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * R01: the datum axes a feature at `beforeFeatureId` may turn about: every
 * unsuppressed datum axis earlier in history (all of them for a feature
 * appended at the end), in history order, as the revolve, circular pattern
 * and Move pickers list them.
 */
export function datumAxisChoices(
  document: ProjectDocument | null | undefined,
  beforeFeatureId: FeatureId | null
): { featureId: FeatureId; name: string }[] {
  if (!document) return [];
  const axes: { featureId: FeatureId; name: string }[] = [];
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.featureId === beforeFeatureId) break;
    if (
      feature.data.featureKind === 'datum-axis' &&
      !isFeatureSuppressed(feature)
    )
      axes.push({ featureId: feature.featureId, name: feature.name });
  }
  return axes;
}
