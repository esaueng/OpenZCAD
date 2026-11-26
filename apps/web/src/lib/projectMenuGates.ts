/**
 * What the workspace offers for the open project, decided once for both of
 * its presentations: the regular top bar and File menu, and the compact
 * project sheet (U12 slice 10). The compact sheet is presentation only, so
 * each of its items takes the same predicate the regular control does and
 * can never offer what the top bar withholds.
 */

/** A share-link visit, as far as these gates need to know it. */
export interface ProjectMenuShareSession {
  /** The link lets its visitors read and add comments. */
  comments?: boolean;
}

/**
 * Project sharing (the top bar's sharing chip, the sheet's Share or Sign in
 * to share): only where cloud features and the sharing preference are on,
 * and never on a share link, which has nothing to share into (design
 * review I73).
 */
export function projectSharingOffered({
  sharingAvailable,
  shareSession
}: {
  sharingAvailable: boolean;
  shareSession: object | null | undefined;
}): boolean {
  return sharingAvailable && !shareSession;
}

/**
 * The sharing entry itself: Share signed in, Sign in to share signed out,
 * nothing where `projectSharingOffered` withholds it.
 */
export function projectSharingEntry({
  sharingAvailable,
  shareSession,
  signedIn,
  onOpenSharing,
  onSignIn
}: {
  sharingAvailable: boolean;
  shareSession: object | null | undefined;
  signedIn: boolean;
  onOpenSharing(): void;
  onSignIn(): void;
}): { label: string; run(): void } | null {
  if (!projectSharingOffered({ sharingAvailable, shareSession })) return null;
  return signedIn
    ? { label: 'Share', run: onOpenSharing }
    : { label: 'Sign in to share', run: onSignIn };
}

/** Comments: everywhere but a share link that does not open them. */
export function projectCommentsOffered(
  shareSession: ProjectMenuShareSession | null | undefined
): boolean {
  return !shareSession || Boolean(shareSession.comments);
}

/**
 * The stored files a person picked or exported. A mesh payload is an
 * import's internal triangles and a reference image's picture is internal
 * to its image; neither is a file anyone would download.
 */
export function listedStoredFiles<T extends { kind: string }>(
  artifacts: readonly T[]
): T[] {
  return artifacts.filter(
    (artifact) =>
      artifact.kind !== 'mesh-payload' && artifact.kind !== 'reference-image'
  );
}
