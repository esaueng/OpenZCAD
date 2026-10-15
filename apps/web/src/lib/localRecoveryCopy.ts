import {
  createSavedRevision,
  normalizeDocumentHistory
} from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  toProjectId,
  type ProjectDocument
} from '@openzcad/shared';
import { recoveryCopyName } from './conflictRecovery';

export function localRecoveryCopy(
  source: ProjectDocument,
  label: 'Recovery' | 'Local copy'
): ProjectDocument {
  const copy = structuredClone(source);
  const projectId = toProjectId(`proj_recovery_${crypto.randomUUID()}`);
  const name = recoveryCopyName(source.name, label);
  copy.projectId = projectId;
  if (copy.editHistory) {
    copy.editHistory.projectId = projectId;
    for (const historical of documentNodesWithHistory(copy)) {
      if (historical.kind === 'project') historical.projectId = projectId;
    }
  }
  const beforeRename = structuredClone(copy);
  copy.name = name;
  copy.revisions = [];
  copy.checkpoints = [];
  copy.derived.updatedAt = new Date().toISOString();
  const root = copy.nodes[copy.rootNodeId];
  if (root?.kind === 'project') {
    root.projectId = projectId;
    root.name = name;
    root.revisionId = null;
  }
  // The source's save points stay with the source; the copy starts its own
  // record. Born with none at all, it could not be saved: every Save,
  // including Save to my account, refused for want of a revision to name.
  return createSavedRevision(
    normalizeDocumentHistory(beforeRename, copy),
    `Recovered from ${source.name}`
  );
}
