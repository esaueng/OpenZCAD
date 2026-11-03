import { commandFactories } from '@openzcad/command-system';
import { deleteFeature, listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { featureHistory, featureResultBodyIds } from './featureHistory';
import { FeatureBuildError, refusingWarning } from './featureValidation';

/** Remove an operation, keeping its input and all rebuildable later steps.
 * Only body operands are reconnected. A pick of a deleted bore/band must
 * refuse in the exact rebuild; it is never guessed onto a different face.
 */
export function nativeFeatureDeletion(
  document: ProjectDocument,
  feature: FeatureNode
) {
  const data = feature.data;
  if (
    data.featureKind !== 'hole' &&
    data.featureKind !== 'fillet' &&
    data.featureKind !== 'chamfer'
  ) {
    throw new Error('This feature is not a removable native detail.');
  }
  const input = { featureId: feature.featureId, reconnectInput: true };
  const candidate = deleteFeature(document, input);
  const dependents = featureHistory(document)
    .downstream(feature.featureId)
    .filter((dependent) => !isFeatureSuppressed(dependent));
  const survivors = listFeaturesInOrder(candidate);
  return {
    command: commandFactories.deleteFeature(input, `Delete ${feature.name}`),
    validateDerived(derived: ProjectDocument['derived']) {
      const refused = dependents.filter((dependent) => {
        const live = survivors.find(
          (entry) => entry.featureId === dependent.featureId
        )!;
        return (
          refusingWarning(
            live.name,
            derived.warnings,
            derived.featureWarnings,
            live.featureId
          ) ||
          featureResultBodyIds(live).some(
            (id) => !derived.bodyRepresentations[id]
          )
        );
      });
      if (refused.length) {
        const names = refused
          .slice(0, 3)
          .map((entry) => `"${entry.name}"`)
          .join(', ');
        throw new FeatureBuildError(
          `Cannot remove "${feature.name}": ${names}${refused.length > 3 ? ` and ${refused.length - 3} more features` : ''} still need its geometry. Edit or remove those features first.`,
          feature.featureId,
          feature.name
        );
      }
      if (!derived.bodyRepresentations[data.targetBodyId]) {
        throw new FeatureBuildError(
          `Cannot remove "${feature.name}": its original body could not rebuild.`,
          feature.featureId,
          feature.name
        );
      }
    }
  };
}
