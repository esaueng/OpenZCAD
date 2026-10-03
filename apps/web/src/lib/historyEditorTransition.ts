import { listFeaturesInOrder } from '@openzcad/document-core';
import type { FeatureId, FeatureNode, ProjectDocument } from '@openzcad/shared';
import { modelingFeatureIsEditable } from './modelingOperations';

export interface HistoryEditorRequest {
  projectId: ProjectDocument['projectId'];
  featureId: FeatureId;
}

/** Resolve after the Move choice: a synced document may have changed the step. */
export function resolveHistoryEditorFeature(
  document: ProjectDocument | null | undefined,
  request: HistoryEditorRequest
): FeatureNode | null {
  if (!document || document.projectId !== request.projectId) return null;
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.featureId === request.featureId
  );
  return feature && modelingFeatureIsEditable(feature.data.featureKind)
    ? feature
    : null;
}
