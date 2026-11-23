import {
  projectBranchPoint,
  type ProjectDocument,
  type ProjectId
} from '@openzcad/shared';

/**
 * `copy` with `branchedFrom` naming `source` at `head`'s newest revision:
 * the shape a save-state branch records (`projectBranchPoint`), for a copy
 * made of the current document for a stated purpose (I03 "Convert a copy",
 * plan §5.3). The copy keeps its "Duplicated from" save point, so the
 * account checks it as the plain duplicate it is. A head with no revision
 * has nothing to name and is returned unchanged.
 */
export function withCopyBranchPoint(
  copy: ProjectDocument,
  source: { projectId: ProjectId; name: string },
  head: ProjectDocument,
  reason: string
): ProjectDocument {
  const revision = head.revisions.at(-1);
  if (!revision) return copy;
  return {
    ...copy,
    branchedFrom: projectBranchPoint(source, {
      revisionId: revision.revisionId,
      reason
    })
  };
}
