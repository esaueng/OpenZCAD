import { listFeaturesInOrder } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';

/** A new operation from a successful local command, independent of selection. */
export interface LocalHistoryAppend {
  projectId: string;
  nodeId: string;
  version: number;
}

/** Preserve an unseen local operation through same-project remote hydration. */
export function retainLocalHistoryAppend(
  append: LocalHistoryAppend | null,
  document: ProjectDocument
): LocalHistoryAppend | null {
  return append?.projectId === document.projectId &&
    document.nodes[append.nodeId]?.kind === 'feature'
    ? append
    : null;
}

export function localHistoryAppend(
  before: ProjectDocument,
  after: ProjectDocument
): LocalHistoryAppend | null {
  if (
    before.projectId !== after.projectId ||
    before.featureOrder === after.featureOrder
  )
    return null;
  const features = listFeaturesInOrder(after);
  for (let index = features.length - 1; index >= 0; index--) {
    const feature = features[index]!;
    if (!before.nodes[feature.id])
      return {
        projectId: after.projectId,
        nodeId: feature.id,
        version: after.version
      };
  }
  return null;
}
