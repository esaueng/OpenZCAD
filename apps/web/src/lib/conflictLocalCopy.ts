import {
  createSavedRevision,
  localizeImportedSourceArtifacts,
  normalizeDocumentHistory
} from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  duplicateProjectName,
  toProjectId,
  referenceImagesWithHistory,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';
import { cacheCopySources } from './sourceBlobClaims';
import { loadSourceBlob, sha256Hex } from './localProjectStore';

/** An ordinary local copy owned by its creator, including when the source is shared. */
export async function localConflictCopy(
  source: ProjectDocument,
  existingNames: Iterable<string>,
  ownerUserId: UserId
): Promise<ProjectDocument> {
  // Unlike a plain duplicate, Keep both retains undo/redo. Cache pictures in
  // that retained history as well as every STEP/mesh source before detaching
  // the original project's artifact identities. A failed fetch leaves both
  // sides of the conflict in place and never creates a partial copy.
  await cacheCopySources(
    {
      ...source,
      referenceImages: { images: [...referenceImagesWithHistory(source)] }
    },
    loadSourceBlob,
    sha256Hex
  );
  const copy = structuredClone(source);
  const projectId = toProjectId(`proj_local_${crypto.randomUUID()}`);
  const name = duplicateProjectName(source.name, existingNames);
  copy.projectId = projectId;
  copy.ownerUserId = ownerUserId;
  if (copy.editHistory) {
    copy.editHistory.projectId = projectId;
    copy.editHistory.actorUserId = ownerUserId;
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
  return localizeImportedSourceArtifacts(
    createSavedRevision(
      normalizeDocumentHistory(beforeRename, copy),
      `Copied from ${source.name}`
    )
  );
}
