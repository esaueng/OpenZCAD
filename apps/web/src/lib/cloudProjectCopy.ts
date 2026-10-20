/**
 * Builds an account project's duplicate or branch in the browser (ADR-024
 * Phase 1), so the Worker stores a copy it never had to construct. Loaded on
 * demand: only Duplicate and Branch reach it.
 */
import { duplicateProjectDocument } from '@openzcad/document-core';
import {
  importSourceCopyRefs,
  projectCopyDocumentDigest
} from '@openzcad/persistence';
import {
  duplicateProjectName,
  projectBranchPoint,
  toRevisionId,
  type DuplicateProjectRequest,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';

export interface CloudProjectCopySource {
  projectId: string;
  /** The source's shelf name: what the copy and a branch's lineage name. */
  projectName: string;
  /** Branch from this stored save state instead of the current document. */
  saveState?: { revisionId: string; reason: string };
}

export interface CloudProjectCopyStore {
  loadProject: (projectId: string) => Promise<ProjectDocument>;
  /** Null when the account no longer stores the save state. */
  loadRevision: (
    projectId: string,
    revisionId: string
  ) => Promise<ProjectDocument | null>;
}

/**
 * The request that stores a copy of `source`, or null when the account cannot
 * supply the save state to branch. The copy carries a fresh `proj_<uuid>` id,
 * its "Duplicated from" or "Branched from" save point, device-local import
 * references, the canonical digest copy rollback compares, and the list of
 * the source's archived imports the account copies byte for byte.
 */
export async function buildCloudProjectCopy(
  source: CloudProjectCopySource,
  ownerUserId: UserId,
  existingNames: Iterable<string>,
  store: CloudProjectCopyStore
): Promise<Omit<DuplicateProjectRequest, 'projectId'> | null> {
  const { saveState } = source;
  const document = saveState
    ? await store.loadRevision(source.projectId, saveState.revisionId)
    : await store.loadProject(source.projectId);
  if (!document) return null;
  // The copy is named after the project, not after the save state it starts
  // from: "Bracket (copy)" is what the user is looking for on the shelf.
  const copy = duplicateProjectDocument(
    document,
    duplicateProjectName(source.projectName, existingNames),
    ownerUserId,
    saveState
      ? projectBranchPoint(
          { projectId: document.projectId, name: source.projectName },
          {
            revisionId: toRevisionId(saveState.revisionId),
            reason: saveState.reason
          }
        )
      : undefined
  );
  return {
    document: copy,
    documentDigest: await projectCopyDocumentDigest(copy),
    importSources: importSourceCopyRefs(document, copy),
    ...(saveState ? { revisionId: toRevisionId(saveState.revisionId) } : {})
  };
}
