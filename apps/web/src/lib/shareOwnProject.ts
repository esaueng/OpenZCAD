import type { ProjectSummary } from '@openzcad/shared';

/**
 * The signed-in viewer's own project behind the share link they opened, or
 * null when the link is someone else's.
 *
 * A share link serves its project under the project's own id, with the
 * owner's account id taken out (`sharedProjectSnapshotDocument`), so the
 * viewer's account listing is what tells: the project is in it, and the
 * listing does not mark it as shared with them by someone else. An owner
 * opening their own link was offered Make a copy, a second project of their
 * own model; they are offered the project itself instead.
 */
export function ownProjectBehindShare(options: {
  signedIn: boolean;
  /** The shared document's project id. */
  projectId: string | null | undefined;
  projects: readonly ProjectSummary[];
  /** The projects the account listing holds. */
  accountProjectIds: ReadonlySet<string>;
}): ProjectSummary | null {
  const { signedIn, projectId, projects, accountProjectIds } = options;
  if (!signedIn || !projectId || !accountProjectIds.has(projectId)) return null;
  const listed = projects.find((project) => project.projectId === projectId);
  if (!listed) return null;
  // Unmarked reads as the caller's own, as the shelf reads it: the listing
  // marks a project shared with the caller with the caller's role.
  return (listed.sharing?.role ?? 'owner') === 'owner' ? listed : null;
}
