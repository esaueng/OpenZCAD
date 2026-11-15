/**
 * Whether a cloud archive upload for the open project can start: there is a
 * session and the project has an account copy. `archiveArtifact` refuses
 * otherwise, so the import card offers Archive now only when this holds; a
 * button that can only fail would dismiss the card and report a failure
 * (design review I8; signed in but device-only, e.g. a project created
 * offline, is the case a session check alone misses).
 *
 * Kept out of `archiveArtifact.ts`, which is loaded lazily.
 */
export function cloudArchivable(
  signedIn: boolean,
  projectId: string | null | undefined,
  accountProjects: { has(projectId: string): boolean }
): boolean {
  return Boolean(signedIn && projectId && accountProjects.has(projectId));
}
