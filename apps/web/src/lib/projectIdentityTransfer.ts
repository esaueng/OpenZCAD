import { reidentifyProjectDocument } from '@openzcad/document-core';
import type { ProjectDocument, UserId } from '@openzcad/shared';

/** Keeps a newer durable transfer ahead of an older open manager snapshot. */
export function latestTransferredProjectDocument(
  transferred: ProjectDocument,
  live: ProjectDocument
): ProjectDocument {
  if (live.version <= transferred.version) return transferred;
  const moved = reidentifyProjectDocument(live, transferred.projectId);
  return {
    ...moved,
    ownerUserId: transferred.ownerUserId,
    ...(moved.editHistory
      ? {
          editHistory: {
            ...moved.editHistory,
            actorUserId: transferred.ownerUserId
          }
        }
      : {})
  };
}

/** Retains older account copies even if logout already removed their baseline. */
export function retainPreviousAccountProject(
  source: ProjectDocument,
  localUserId: UserId,
  accountUserId: UserId
): boolean {
  return (
    source.ownerUserId !== localUserId && source.ownerUserId !== accountUserId
  );
}
