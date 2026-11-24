import {
  claimProjectOwnership,
  type ProjectOwnershipClaim,
  type ProjectStorageOwnership
} from '../lib/projectTabOwnership';

/**
 * The workspace's storage-claim record, as App builds it over a real claim
 * (`claimProjectOwnership`), resolved once the claim has been answered.
 */
export async function workspaceStorageClaim(projectId: string) {
  let given: ProjectOwnershipClaim | null = null;
  const ownership: ProjectStorageOwnership = {
    projectId,
    owned: false,
    settled: Promise.resolve(),
    retain: () => (ownership.owned && given ? given.retain() : null)
  };
  ownership.settled = claimProjectOwnership(projectId, () => {
    ownership.owned = true;
  }).then((result) => {
    given = result;
    ownership.owned = result.owned;
  });
  let current: ProjectStorageOwnership | null = ownership;
  await ownership.settled;
  return {
    ownership,
    read: () => current,
    /** What App's cleanup does when the tab leaves the project. */
    giveUp() {
      ownership.owned = false;
      current = null;
      given?.release();
    }
  };
}
