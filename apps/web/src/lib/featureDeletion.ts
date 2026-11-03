import { commandFactories } from '@openzcad/command-system';
import { deleteFeature, listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DirectEditOperation,
  type FeatureNode,
  type ProjectDocument,
  type TopologySelection
} from '@openzcad/shared';
import { featureHistory, featureResultBodyIds } from './featureHistory';
import { FeatureBuildError, refusingWarning } from './featureValidation';
import { resolveSelectionTopology } from './selectionFeature';
import { importedBlendSnapshot } from './interaction/filletFaceEdit';

/** STEP has no feature history to delete: append a validated, undoable heal. */
export function importedFaceDeletion(
  document: ProjectDocument,
  selection: TopologySelection
) {
  const body = document.derived.bodyRepresentations[selection.bodyId];
  const imported = listFeaturesInOrder(document).find(
    (feature) =>
      feature.bodyId === selection.bodyId &&
      feature.data.featureKind === 'imported-step' &&
      !isFeatureSuppressed(feature)
  );
  const resolved = resolveSelectionTopology(body, selection);
  if (!imported || !body || body.consumed || resolved?.kind !== 'face') {
    throw new Error('Select a current face on an imported STEP part.');
  }
  const face = body.topology!.faces.find(
    (candidate) => candidate.topologyId === resolved.topologyId
  )!;
  const geometry = face.geometry;
  if (!geometry) throw new Error('Exact face geometry is unavailable.');
  const blend = importedBlendSnapshot(face);
  const identity = {
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {})
  };
  const operation: DirectEditOperation = blend
    ? {
        kind: 'resize-blend',
        ...identity,
        surfaceClass: blend.surfaceClass,
        recordedRadius: blend.radius,
        recordedCenter: blend.center,
        recordedAxis: blend.axis,
        newRadius: 0
      }
    : {
        kind: 'remove-face-feature',
        ...identity,
        sourceSurfaceType: geometry.surfaceType,
        sourceArea: geometry.area,
        sourceCenter: geometry.center,
        sourceDiameter: geometry.diameter,
        sourceAxisStart: geometry.axisStart,
        sourceAxisEnd: geometry.axisEnd
      };
  const name = blend ? 'Remove imported fillet' : 'Remove imported feature';
  const command = commandFactories.directEditBody({
    name,
    targetBodyId: selection.bodyId,
    operation
  });
  return {
    command,
    target: {
      featureName: name,
      ...(command.payload.ids ? { featureId: command.payload.ids.featureId } : {}),
      resultBodyId: selection.bodyId
    },
    successMessage: blend
      ? 'Removed the selected imported fillet.'
      : 'Removed the selected imported feature.'
  };
}

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
