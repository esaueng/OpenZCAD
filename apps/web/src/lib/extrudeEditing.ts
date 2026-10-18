import { commandFactories } from '@openzcad/command-system';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureNode,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { listFeaturesInOrder } from '@openzcad/document-core';
import { affectedFeatureTargets } from './affectedFeatureTargets';
import { validatedFeatureRejection } from './featureValidation';
import type { ExtrudeFormValue } from '../components/forms/ExtrudeForm';

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
    throw new Error('Choose New Body, Add, or Cut when editing an extrusion.');
  }
  if (value.choice.operation !== 'new-body' && !value.choice.targetBodyId) {
    throw new Error('Select a target body for this extrusion.');
  }
  const throughAll = value.endCondition === 'through-all';
  return commandFactories.updateFeature(
    {
      featureId: feature.featureId,
      name: value.name,
      data: {
        ...feature.data,
        distance: value.distance,
        symmetric: value.symmetric,
        backDistance: value.backDistance,
        operation: value.choice.operation,
        targetBodyId:
          value.choice.operation === 'new-body'
            ? undefined
            : value.choice.targetBodyId,
        ...(throughAll
          ? {
              endCondition: 'through-all' as const,
              throughAllSide: value.throughAllSide ?? 'forward'
            }
          : {})
      },
      // Blind is the absent extent; a stale side must not outlive it.
      ...(!throughAll && feature.data.endCondition !== undefined
        ? { clearData: ['endCondition', 'throughAllSide'] }
        : {})
    },
    `Edit ${value.name}`
  );
}

/**
 * The magnitude an extrude edit preview is requested at. A through-all cut's
 * stored distance is dormant (the build derives the span), so it is never
 * resolved: a distance naming a since-deleted parameter must not block the
 * preview of an edit that Apply accepts.
 */
export function extrudePreviewMagnitude(
  value: Pick<ExtrudeFormValue, 'distance' | 'endCondition'>,
  resolve: (distance: ExtrudeFormValue['distance']) => number
): number {
  return value.endCondition === 'through-all'
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
      data.targetBodyIds.forEach((id) => unavailable.add(id));
    } else if (
      'targetBodyId' in data &&
      data.targetBodyId &&
      earlier.bodyId &&
      earlier.bodyId !== data.targetBodyId &&
      data.featureKind !== 'mirror' &&
      data.featureKind !== 'thicken'
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
          ? { clearData: ['endCondition', 'throughAllSide'] }
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
