import { commandFactories } from '@openzcad/command-system';
import { deleteFeature, listFeaturesInOrder } from '@openzcad/document-core';
import {
  ownEntry,
  isFeatureSuppressed,
  type BodyId,
  type DirectEditOperation,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument,
  type TopologySelection
} from '@openzcad/shared';
import { featureHistory, featureResultBodyIds } from './featureHistory';
import { FeatureBuildError, refusingWarning } from './featureValidation';
import {
  isRemovableDetail,
  resolveSelectionTopology
} from './selectionFeature';
import { importedBlendSnapshot } from './interaction/filletFaceEdit';

/** STEP has no feature history to delete: append a validated, undoable heal. */
export function importedFaceDeletion(
  document: ProjectDocument,
  selection: TopologySelection
) {
  const imported = listFeaturesInOrder(document).find(
    (feature) =>
      feature.bodyId === selection.bodyId &&
      feature.data.featureKind === 'imported-step' &&
      !isFeatureSuppressed(feature)
  );
  if (!imported) {
    throw new Error('Select a current face on an imported STEP part.');
  }
  return singleFaceDeletion(document, selection, {
    missing: 'Select a current face on an imported STEP part.',
    blend: ['Remove imported fillet', 'Removed the selected imported fillet.'],
    face: ['Remove imported feature', 'Removed the selected imported feature.']
  });
}

/**
 * A face a subtract cut (the wall of a hole a cylinder cut through a part):
 * healed in place, as an imported face is. Deleting the feature the face is
 * inferred to — the cutting tool — would leave the subtract with nothing to
 * cut and every step after it unbuilt; the heal closes just this cut.
 */
export function cutFaceDeletion(
  document: ProjectDocument,
  selection: TopologySelection
) {
  return singleFaceDeletion(document, selection, {
    missing: 'Select a current face of a cut.',
    blend: ['Remove fillet', 'Removed the selected fillet.'],
    face: ['Fill the cut', 'Filled the cut and healed the body.']
  });
}

/** One face healed by a replayable direct edit: a blend resized away, or
 * the face removed and its neighbours extended over it. */
function singleFaceDeletion(
  document: ProjectDocument,
  selection: TopologySelection,
  names: {
    missing: string;
    blend: [name: string, success: string];
    face: [name: string, success: string];
  }
) {
  const body = ownEntry(document.derived.bodyRepresentations, selection.bodyId);
  const resolved = resolveSelectionTopology(body, selection);
  if (!body || body.consumed || resolved?.kind !== 'face') {
    throw new Error(names.missing);
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
  const [name, successMessage] = blend ? names.blend : names.face;
  const command = commandFactories.directEditBody({
    name,
    targetBodyId: selection.bodyId,
    operation
  });
  return {
    command,
    target: {
      featureName: name,
      ...(command.payload.ids
        ? { featureId: command.payload.ids.featureId }
        : {}),
      resultBodyId: selection.bodyId
    },
    successMessage
  };
}

/**
 * Several faces of one body deleted together, as one replayable direct edit:
 * the faces around them extend until the body closes again. Selecting every
 * wall of a window or pocket and deleting them fills it. Works on any body,
 * native or imported; the exact rebuild refuses a set it cannot heal (three
 * walls of a four-walled window) and leaves the body as it was.
 */
export function faceSetDeletion(
  document: ProjectDocument,
  selections: readonly TopologySelection[]
) {
  const bodyId = selections[0]?.bodyId;
  if (
    !bodyId ||
    selections.length < 2 ||
    selections.some(
      (selection) => selection.bodyId !== bodyId || selection.kind !== 'face'
    )
  ) {
    throw new Error('Select two or more faces on one body to delete them.');
  }
  const body = ownEntry(document.derived.bodyRepresentations, bodyId);
  if (!body || body.consumed) {
    throw new Error('Select faces on a current body.');
  }
  const faces = selections.map((selection) => {
    const resolved = resolveSelectionTopology(body, selection);
    const face =
      resolved?.kind === 'face'
        ? body.topology?.faces.find(
            (candidate) => candidate.topologyId === resolved.topologyId
          )
        : undefined;
    if (!face?.geometry) {
      throw new Error(
        'A selected face is no longer on the model. Select the faces again.'
      );
    }
    return {
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      sourceSurfaceType: face.geometry.surfaceType,
      sourceArea: face.geometry.area,
      sourceCenter: face.geometry.center
    };
  });
  if (new Set(faces.map((face) => face.faceHash)).size !== faces.length) {
    throw new Error('The same face is selected twice. Select the faces again.');
  }
  const [first, ...additionalFaces] = faces;
  const name = `Delete ${faces.length} faces`;
  const command = commandFactories.directEditBody({
    name,
    targetBodyId: bodyId,
    operation: { kind: 'remove-faces', ...first!, additionalFaces }
  });
  return {
    command,
    target: {
      featureName: name,
      ...(command.payload.ids
        ? { featureId: command.payload.ids.featureId }
        : {}),
      resultBodyId: bodyId
    },
    successMessage: `Deleted ${faces.length} faces and closed the gap.`
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
            (id) => !ownEntry(derived.bodyRepresentations, id)
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
      if (!ownEntry(derived.bodyRepresentations, data.targetBodyId)) {
        throw new FeatureBuildError(
          `Cannot remove "${feature.name}": its original body could not rebuild.`,
          feature.featureId,
          feature.name
        );
      }
    }
  };
}

/**
 * Removes several history steps as one undoable transaction.
 *
 * Latest first: a datum plane or axis whose every user is in the selection
 * has none left by its turn, and each hole, fillet or chamfer reconnects its
 * input exactly as it would alone. Only a detail's promise is validated —
 * a step built on a removed detail must keep building — and only for steps
 * that do not also rest on a removed non-detail step, which the confirm
 * already named as rebuilding without it.
 */
export function batchFeatureDeletion(
  document: ProjectDocument,
  featureIds: readonly FeatureId[]
) {
  const ids = new Set(featureIds);
  const ordered = listFeaturesInOrder(document);
  const selected = ordered.filter((feature) => ids.has(feature.featureId));
  if (selected.length === 0) throw new Error('Select steps to delete.');
  const history = featureHistory(document);
  const dependentIds = new Set<FeatureId>();
  const brokenIds = new Set<FeatureId>();
  for (const feature of selected) {
    for (const dependent of history.downstream(feature.featureId)) {
      if (ids.has(dependent.featureId)) continue;
      dependentIds.add(dependent.featureId);
      if (!isRemovableDetail(feature)) brokenIds.add(dependent.featureId);
    }
  }
  const dependents = ordered.filter((feature) =>
    dependentIds.has(feature.featureId)
  );
  const inputs = [...selected]
    .reverse()
    .map((feature) =>
      isRemovableDetail(feature)
        ? { featureId: feature.featureId, reconnectInput: true }
        : { featureId: feature.featureId }
    );
  // Applied up front so a refusal (a datum still in use) surfaces before any
  // rebuild, and so the checks read the reconnected survivors.
  let candidate = document;
  for (const input of inputs) candidate = deleteFeature(candidate, input);
  const survivors = new Map(
    listFeaturesInOrder(candidate).map((feature) => [
      feature.featureId,
      feature
    ])
  );
  const label = `Delete ${selected.length} ${selected.length === 1 ? 'feature' : 'features'}`;
  const commands = inputs.map((input) =>
    commandFactories.deleteFeature(
      input,
      `Delete ${findName(selected, input.featureId)}`
    )
  );
  const details = selected.filter(isRemovableDetail);
  const removedBodies = new Set(
    selected.flatMap((feature) => (feature.bodyId ? [feature.bodyId] : []))
  );
  const detailInput = (feature: FeatureNode): BodyId | undefined => {
    const data = feature.data;
    return data.featureKind === 'hole' ||
      data.featureKind === 'fillet' ||
      data.featureKind === 'chamfer'
      ? data.targetBodyId
      : undefined;
  };
  const detailInputs = new Map<BodyId, BodyId>();
  for (const detail of details) {
    const input = detailInput(detail);
    if (detail.bodyId && input) detailInputs.set(detail.bodyId, input);
  }
  const validateDerived = details.length
    ? (derived: ProjectDocument['derived']) => {
        for (const detail of details) {
          const refused = history
            .downstream(detail.featureId)
            .filter(
              (dependent) =>
                !ids.has(dependent.featureId) &&
                !brokenIds.has(dependent.featureId) &&
                !isFeatureSuppressed(dependent)
            )
            .map((dependent) => survivors.get(dependent.featureId)!)
            .filter(
              (live) =>
                refusingWarning(
                  live.name,
                  derived.warnings,
                  derived.featureWarnings,
                  live.featureId
                ) ||
                featureResultBodyIds(live).some(
                  (id) => !ownEntry(derived.bodyRepresentations, id)
                )
            );
          if (refused.length) {
            const names = refused
              .slice(0, 3)
              .map((entry) => `"${entry.name}"`)
              .join(', ');
            throw new FeatureBuildError(
              `Cannot remove "${detail.name}": ${names}${refused.length > 3 ? ` and ${refused.length - 3} more features` : ''} still need its geometry. Edit or remove those features first.`,
              detail.featureId,
              detail.name
            );
          }
          // The body the detail sat on, past any removed detail beneath it.
          let input = detailInput(detail);
          const seen = new Set<BodyId>();
          while (input && detailInputs.has(input) && !seen.has(input)) {
            seen.add(input);
            input = detailInputs.get(input);
          }
          if (
            input &&
            !removedBodies.has(input) &&
            !ownEntry(derived.bodyRepresentations, input)
          ) {
            throw new FeatureBuildError(
              `Cannot remove "${detail.name}": its original body could not rebuild.`,
              detail.featureId,
              detail.name
            );
          }
        }
      }
    : undefined;
  return {
    label,
    commands,
    names: selected.map((feature) => feature.name),
    dependents,
    validateDerived
  };
}

function findName(features: readonly FeatureNode[], id: FeatureId): string {
  return features.find((feature) => feature.featureId === id)?.name ?? 'step';
}
