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
 * account checks it as the plain duplicate it is.
 *
 * A head with no revision (a backup imported with empty history) has
 * nothing to name: `ProjectBranchPoint.revisionId` is required, and writing
 * a revision into the source would change the project the copy promises to
 * leave alone. The copy is returned unchanged; {@link copyLineageNote} says
 * so to the user.
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

/**
 * The sentence "Convert a copy" adds when `copy` records no `branchedFrom`
 * (its source had no save point to name), or "" when it does.
 */
export function copyLineageNote(
  copy: Pick<ProjectDocument, 'branchedFrom'>,
  sourceName: string
): string {
  return copy.branchedFrom
    ? ''
    : ` The copy does not record that it came from ${sourceName}: ${sourceName} has no save point yet to name.`;
}
