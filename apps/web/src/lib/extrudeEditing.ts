import { commandFactories } from '@openzcad/command-system';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureNode,
  type FeatureId,
  type ProjectDocument,
  isTransformCopy
} from '@openzcad/shared';
import {
  booleanConsumedBodyIds,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { affectedFeatureTargets } from './affectedFeatureTargets';
import { validatedFeatureRejection } from './featureValidation';
import type { ExtrudeDraftInitial, ExtrudeFormValue } from './extrudeDraft';

type ExtrudeData = Extract<FeatureNode['data'], { featureKind: 'extrude' }>;

/**
 * What an extrude edit opens on (U09): the stored feature as the in-place
 * Extrude's draft reads it, expressions as written, the extent with its face
 * or side, and the stored operation (an edit never infers one).
 */
export function extrudeEditInitial(feature: FeatureNode): ExtrudeDraftInitial {
  if (feature.data.featureKind !== 'extrude') {
    throw new Error(`${feature.name} is not an extrusion.`);
  }
  const data = feature.data;
  return {
    name: feature.name,
    sketchId: data.sketchId,
    distance: data.distance,
    ...(data.symmetric ? { symmetric: true } : {}),
    ...(data.backDistance !== undefined
      ? { backDistance: data.backDistance }
      : {}),
    operation: data.operation ?? 'new-body',
    ...(data.targetBodyId ? { targetBodyId: data.targetBodyId } : {}),
    ...(data.endCondition === 'through-all'
      ? {
          endCondition: 'through-all' as const,
          ...(data.throughAllSide
            ? { throughAllSide: data.throughAllSide }
            : {})
        }
      : {}),
    ...(data.endCondition === 'to-face' && data.toFace
      ? { endCondition: 'to-face' as const, toFace: data.toFace }
      : {}),
    ...(data.draftAngleDeg !== undefined
      ? { draftAngleDeg: data.draftAngleDeg }
      : {})
  };
}

/** A stored value that reads as zero: a number, or its text. */
function storedZero(value: unknown): boolean {
  return value === 0 || (typeof value === 'string' && Number(value) === 0);
}

/**
 * The extrude's data as an edit leaves it. A field at the value its absence
 * means (one-sided, no back distance, a new body, straight walls, a blind
 * extent) keeps the form it was stored in, so an edit that changes nothing
 * writes the feature back exactly as it was.
 */
export function extrudeEditData(
  stored: ExtrudeData,
  value: ExtrudeFormValue
): ExtrudeData {
  const throughAll = value.endCondition === 'through-all';
  const toFace = value.endCondition === 'to-face';
  const {
    symmetric: _symmetric,
    backDistance: _backDistance,
    operation: _operation,
    targetBodyId: _targetBodyId,
    endCondition: _endCondition,
    throughAllSide: _throughAllSide,
    toFace: _toFace,
    draftAngleDeg: _draftAngleDeg,
    ...kept
  } = stored;
  const operation = value.choice.operation as Exclude<
    ExtrudeFormValue['choice']['operation'],
    'automatic'
  >;
  const target =
    value.choice.operation !== 'new-body' && 'targetBodyId' in value.choice
      ? value.choice.targetBodyId
      : undefined;
  return {
    ...kept,
    distance: value.distance,
    ...(value.symmetric
      ? { symmetric: true }
      : stored.symmetric !== undefined
        ? { symmetric: false }
        : {}),
    ...(storedZero(value.backDistance) && stored.backDistance === undefined
      ? {}
      : { backDistance: value.backDistance }),
    ...(operation === 'new-body' && stored.operation === undefined
      ? {}
      : { operation }),
    ...(target ? { targetBodyId: target } : {}),
    ...(throughAll
      ? {
          endCondition: 'through-all' as const,
          throughAllSide: value.throughAllSide ?? 'forward'
        }
      : toFace
        ? { endCondition: 'to-face' as const, toFace: value.toFace! }
        : stored.endCondition === 'blind'
          ? { endCondition: 'blind' as const }
          : {}),
    ...(value.draftAngleDeg !== undefined
      ? { draftAngleDeg: value.draftAngleDeg }
      : storedZero(stored.draftAngleDeg)
        ? { draftAngleDeg: stored.draftAngleDeg! }
        : {})
  };
}

export function extrudeEditCommand(
  feature: FeatureNode,
  value: ExtrudeFormValue
) {
  if (
    feature.data.featureKind !== 'extrude' ||
    feature.data.sketchId !== value.sketchId
  ) {
    throw new Error(
      'Changing an Extrude source sketch requires profile reselection.'
    );
  }
  if (value.choice.operation === 'automatic') {
    throw new Error(
      'Choose New Body, Add, Cut, or Intersect when editing an extrusion.'
    );
  }
  if (value.choice.operation !== 'new-body' && !value.choice.targetBodyId) {
    throw new Error('Select a target body for this extrusion.');
  }
  if (value.endCondition === 'to-face' && !value.toFace) {
    throw new Error('Pick the face this extrusion reaches.');
  }
  const data = extrudeEditData(feature.data, value);
  // A field the edit no longer uses is cleared, never left stale beside
  // the others (a through-all side on a blind extrude). A target goes with
  // New body itself: the update drops it when the operation is written.
  const clearData = (
    ['endCondition', 'throughAllSide', 'toFace', 'draftAngleDeg'] as const
  ).filter((key) => key in feature.data && !(key in data));
  return commandFactories.updateFeature(
    {
      featureId: feature.featureId,
      name: value.name,
      data,
      ...(clearData.length > 0 ? { clearData } : {})
    },
    `Edit ${value.name}`
  );
}

/**
 * The magnitude an extrude edit preview is requested at. A through-all cut's
 * or a to-face extrude's stored distance is dormant (the build derives the
 * span), so it is never
 * resolved: a distance naming a since-deleted parameter must not block the
 * preview of an edit that Apply accepts.
 */
export function extrudePreviewMagnitude(
  value: Pick<ExtrudeFormValue, 'distance' | 'endCondition'>,
  resolve: (distance: ExtrudeFormValue['distance']) => number
): number {
  return value.endCondition === 'through-all' ||
    value.endCondition === 'to-face'
    ? 1
    : Math.abs(resolve(value.distance));
}

/** Validate at the feature's history position, not against today's live bodies. */
export function extrudeEditTargets(
  document: ProjectDocument,
  feature: FeatureNode
) {
  if (feature.data.featureKind !== 'extrude') return [];
  const options: { bodyId: BodyId; name: string }[] = [];
  const unavailable = new Set<BodyId>();
  const features = listFeaturesInOrder(document);
  for (const earlier of features) {
    if (earlier.featureId === feature.featureId) break;
    if (isFeatureSuppressed(earlier)) continue;
    const data = earlier.data;
    if (data.featureKind === 'boolean') {
      // M11: a kept input stays a legal target after the Boolean.
      booleanConsumedBodyIds(data).forEach((id) => unavailable.add(id));
    } else if (
      'targetBodyId' in data &&
      data.targetBodyId &&
      earlier.bodyId &&
      earlier.bodyId !== data.targetBodyId &&
      data.featureKind !== 'mirror' &&
      data.featureKind !== 'thicken' &&
      !(data.featureKind === 'split' && data.keepOriginal === true) &&
      !isTransformCopy(data)
    ) {
      unavailable.add(data.targetBodyId);
    }
  }
  for (const bodyId of document.bodyOrder) {
    if (unavailable.has(bodyId)) continue;
    try {
      // The probe asks only "may this body be a target here?". A through-all
      // extent is cut-only, so it is cleared from the probe, not the feature.
      const command = commandFactories.updateFeature({
        featureId: feature.featureId,
        data: { operation: 'add', targetBodyId: bodyId },
        ...(feature.data.endCondition !== undefined
          ? {
              clearData: [
                'endCondition',
                ...(feature.data.throughAllSide !== undefined
                  ? ['throughAllSide']
                  : []),
                ...(feature.data.toFace !== undefined ? ['toFace'] : [])
              ]
            }
          : {})
      });
      command.validate(document);
      const body = Object.values(document.nodes).find(
        (node) => node.kind === 'body' && node.bodyId === bodyId
      );
      const producer =
        body?.kind === 'body'
          ? features.find((entry) => entry.featureId === body.featureId)
          : undefined;
      if (body && producer && !isFeatureSuppressed(producer)) {
        options.push({ bodyId, name: body.name });
      }
    } catch {
      // Self, downstream, and previously consumed bodies are not legal targets.
    }
  }
  return options;
}

/** Preview and Apply use the same attributed checks for affected geometry. */
export function extrudePreviewError(
  document: ProjectDocument,
  featureId: FeatureId,
  derived: ProjectDocument['derived']
): string | null {
  for (const target of affectedFeatureTargets(document, featureId)) {
    const rejection = validatedFeatureRejection({
      featureName: target.featureName,
      featureId: target.featureId,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings,
      bodyPresent: Boolean(derived.bodyRepresentations[target.resultBodyId]),
      documentMoved: false
    });
    if (rejection) return `${target.featureName}: ${rejection.message}`;
  }
  return null;
}
