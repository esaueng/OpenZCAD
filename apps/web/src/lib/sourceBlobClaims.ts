import type { ProjectDocument } from '@openzcad/shared';

/** Every source checksum the document's imports need in order to rebuild. */
export function importSourceChecksums(document: ProjectDocument): Set<string> {
  const checksums = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'feature' || node.data.featureKind !== 'imported-step') {
      continue;
    }
    const checksum = node.data.stepSourceRef?.checksumSha256;
    if (checksum !== undefined) {
      checksums.add(checksum);
    }
  }
  return checksums;
}

/** A device-wide note that one import run is working with source bytes. */
export interface SourceBlobClaim {
  checksumSha256: string;
  /** Unique per import run, so a run never blocks its own cleanup. */
  claimId: string;
  createdAt: string;
}

/**
 * How long a claim keeps bytes safe from another tab's cleanup.
 *
 * Imports release their claim when they finish, except for a successful commit:
 * that claim bridges the short interval before autosave persists the document
 * reference. A day comfortably outlasts a real 250 MB rebuild while ensuring a
 * tab closed mid-import cannot make the blob permanently unreclaimable.
 *
 * After expiry, persisted project documents become the durable protection. One
 * limit remains deliberate: undo/redo stacks live only in tab memory, so a STEP
 * import committed and then undone is not visible to the device-wide document
 * scan. The ownership rule in `settleImportSource` still permits cleanup only
 * from the tab that created or remembered abandoning the key; widening cleanup
 * beyond that would trade a bounded leak for cross-tab data loss.
 */
export const SOURCE_BLOB_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export function sourceBlobClaimExpired(
  claim: { createdAt: string },
  now: number
): boolean {
  // A malformed timestamp must not become an eternal lock. Such a value cannot
  // have been written by this code, so expiry is the conservative repair.
  return !(Date.parse(claim.createdAt) + SOURCE_BLOB_CLAIM_TTL_MS > now);
}

/** Whether `claim` is another import's live hold on this checksum. */
export function sourceBlobClaimHolds(
  claim: SourceBlobClaim,
  scope: {
    checksumSha256: string;
    ownClaimId: string | null;
    now: number;
  }
): boolean {
  return (
    claim.checksumSha256 === scope.checksumSha256 &&
    claim.claimId !== scope.ownClaimId &&
    !sourceBlobClaimExpired(claim, scope.now)
  );
}
