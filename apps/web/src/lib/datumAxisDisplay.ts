import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DatumAxisLine,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/** A datum axis as the viewport draws it: presentation only. */
export interface DatumAxisDisplay {
  featureId: FeatureId;
  name: string;
  axis: DatumAxisLine;
  selected: boolean;
}

/**
 * The resolved, shown datum axes. An axis with no line (failed, suppressed
 * or still building) draws nothing rather than a guess.
 */
export function datumAxisDisplays(
  document: ProjectDocument,
  hidden: ReadonlySet<string>,
  selectedFeatureId: FeatureId | null
): DatumAxisDisplay[] {
  const lines = document.derived.datumAxes ?? {};
  return listFeaturesInOrder(document).flatMap((feature) => {
    const axis = lines[feature.featureId];
    return feature.data.featureKind === 'datum-axis' &&
      axis &&
      !isFeatureSuppressed(feature) &&
      !hidden.has(feature.featureId)
      ? [
          {
            featureId: feature.featureId,
            name: feature.name,
            axis,
            selected: feature.featureId === selectedFeatureId
          }
        ]
      : [];
  });
}
