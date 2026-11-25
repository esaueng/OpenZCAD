/**
 * L11 (plan §4, slice 7): share-link upkeep the app can run in the
 * background, not only while the sharing dialog's Links tab is open. For
 * each encrypted project it renews statements that are due, republishes
 * snapshots a statement left behind, asks the server again to forget
 * revoked links and finishes pending share work (`maintainShareLinks`).
 * Owner only: another member's project, or one without links, costs one
 * head read and changes nothing.
 *
 * The app-level background runner (invitations, plan §3.3) calls this; it
 * passes the encrypted projects it knows of. Projects run one at a time, and
 * one that fails does not stop the others.
 */
import type { ShareLinkUpkeep } from './shareLinks';

export interface BackgroundShareLinkUpkeep {
  readonly projectId: string;
  /** What the pass did; absent when it failed. */
  readonly upkeep?: ShareLinkUpkeep;
  /** Why the pass failed; absent when it ran. */
  readonly error?: string;
}

export async function maintainEncryptedShareLinks(
  projectIds: readonly string[],
  options: {
    /** Stops before the next project once false (the session ended). */
    readonly isCurrent?: () => boolean;
  } = {}
): Promise<readonly BackgroundShareLinkUpkeep[]> {
  if (projectIds.length === 0) return [];
  const [{ encryptedShareLinks }, { maintainShareLinks }] = await Promise.all([
    import('./encryptedProjects'),
    import('./shareLinks')
  ]);
  const { ctx } = await encryptedShareLinks();
  const results: BackgroundShareLinkUpkeep[] = [];
  for (const projectId of new Set(projectIds)) {
    if (options.isCurrent && !options.isCurrent()) break;
    try {
      results.push({
        projectId,
        upkeep: await maintainShareLinks(ctx, projectId)
      });
    } catch (error) {
      results.push({
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
