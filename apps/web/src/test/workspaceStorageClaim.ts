import {
  trackProjectStorage,
  type ProjectStorageOwnership
} from '../lib/projectTabOwnership';

/**
 * The workspace's storage claim on `projectId`, tracked as App tracks it
 * (`trackProjectStorage`) and resolved once the claim has been answered.
 */
export async function workspaceStorageClaim(projectId: string) {
  const tracker = trackProjectStorage(projectId, {
    onAnswered: () => undefined,
    onPromoted: () => undefined
  });
  let current: ProjectStorageOwnership | null = tracker.ownership;
  await tracker.ownership.settled;
  return {
    ownership: tracker.ownership,
    read: (): ProjectStorageOwnership | null => current,
    /** What App's cleanup does when the tab leaves the project. */
    giveUp() {
      current = null;
      tracker.giveUp();
    }
  };
}
