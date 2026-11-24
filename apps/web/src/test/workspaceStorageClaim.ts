import {
  trackProjectStorage,
  type ProjectStorageOwnership
} from '../lib/projectTabOwnership';

/**
 * The workspace's storage claim on `projectId`, tracked as App tracks it
 * (`trackProjectStorage`) and resolved once the claim has been answered.
 * `read` is what a device write reads: a claim held for autosave's drain,
 * else the open project's.
 */
export async function workspaceStorageClaim(projectId: string) {
  const tracker = trackProjectStorage(projectId, {
    onAnswered: () => undefined,
    onPromoted: () => undefined
  });
  let current: ProjectStorageOwnership | null = tracker.ownership;
  let departing: ProjectStorageOwnership | null = null;
  await tracker.ownership.settled;
  return {
    ownership: tracker.ownership,
    read: (): ProjectStorageOwnership | null =>
      departing?.owned ? departing : current,
    /**
     * What App's cleanup does when the tab leaves the project; with
     * `drain`, as it does while autosave still has edits for it.
     */
    giveUp(drain?: () => Promise<unknown>) {
      current = null;
      if (!drain) {
        tracker.giveUp();
        return;
      }
      departing = tracker.ownership;
      tracker.giveUp(() =>
        drain().finally(() => {
          departing = null;
        })
      );
    }
  };
}
