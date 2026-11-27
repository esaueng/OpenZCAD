import type { ProjectSummary } from '@openzcad/shared';

/**
 * The signed-in viewer's own project behind the share link they opened, or
 * null when the link is someone else's, or when the listing does not say.
 *
 * A share link serves its project under the project's own id, with the
 * owner's account id taken out (`sharedProjectSnapshotDocument`), so the
 * viewer's account listing is what tells. Only its explicit `owner` role
 * counts: the Worker marks the caller's own project `owner` while one of
 * its share links is live (`withProjectSharing`), and a link that opens is
 * live. An unmarked project is not evidence — the Worker leaves the whole
 * listing unmarked when its sharing lookup fails, collaborators' projects
 * included — so it falls back to Make a copy, which is safe for anyone.
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
  return listed?.sharing?.role === 'owner' ? listed : null;
}

/**
 * Why Build is locked in a share session: a visitor makes a copy to build;
 * the owner opens the project the link shows.
 */
export function shareBuildModeLockReason(ownProject: boolean): string {
  return ownProject
    ? 'This is your project’s share link — Open your project to open Build mode'
    : 'This is a shared link — Make a copy to open Build mode';
}

/**
 * Whether a share session may remember its view (camera, display settings,
 * hidden objects) on this device. The snapshot keeps the project's own id,
 * so a remembered view would land on that project: a project this device
 * or account knows (the owner's, a collaborator's) would reopen in the
 * public session's view. A visitor who knows no such project keeps it, as
 * before, for their next visit to the link.
 */
export function shareSessionKeepsView(
  projectId: string | null | undefined,
  projects: readonly ProjectSummary[]
): boolean {
  return !projectId || !projects.some((p) => p.projectId === projectId);
}
