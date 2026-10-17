import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  FeatureId,
  FeatureKind,
  FeatureNode,
  ProjectDocument
} from '@openzcad/shared';
import {
  modelingFeatureIsEditable,
  type EditableModelingKind
} from './modelingOperations';

/**
 * Feature kinds whose card is their creation card, reopened to edit: the
 * modeling operations, and the R01 datum plane, whose tool id is its kind.
 */
export function featureOpensEditCard(
  kind: FeatureKind
): kind is EditableModelingKind | 'datum-plane' {
  return kind === 'datum-plane' || modelingFeatureIsEditable(kind);
}

export interface HistoryEditorRequest {
  projectId: ProjectDocument['projectId'];
  featureId: FeatureId;
}

/** Resolve after the Move choice: a synced document may have changed the step. */
export function resolveHistoryFeature(
  document: ProjectDocument | null | undefined,
  request: HistoryEditorRequest
): FeatureNode | null {
  if (!document || document.projectId !== request.projectId) return null;
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.featureId === request.featureId
  );
  return feature ?? null;
}

/** Modeling cards accept only the live kinds supported by that editor host. */
export function resolveHistoryEditorFeature(
  document: ProjectDocument | null | undefined,
  request: HistoryEditorRequest
): FeatureNode | null {
  const feature = resolveHistoryFeature(document, request);
  return feature && featureOpensEditCard(feature.data.featureKind)
    ? feature
    : null;
}
