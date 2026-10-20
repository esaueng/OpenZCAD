import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  referenceImagesWithHistory
} from '@openzcad/shared';
import type { ProjectDocument } from '@openzcad/shared';

/**
 * Every source checksum the document needs: STEP sources and mesh payloads
 * its imports rebuild from, and the pictures behind its reference images, in
 * the model and in undo/redo history. Cleanup keeps any blob listed here.
 */
export function importSourceChecksums(document: ProjectDocument): Set<string> {
  const checksums = new Set<string>();
  for (const image of referenceImagesWithHistory(document)) {
    const checksum = image.source?.checksumSha256;
    if (typeof checksum === 'string') checksums.add(checksum);
  }
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') {
      continue;
    }
    const checksum = importedSourceReferenceOf(node.data)?.checksumSha256;
    if (checksum !== undefined) {
      checksums.add(checksum);
    }
  }
  return checksums;
}

/**
 * Preserve rebuild bytes — and reference-image pictures — before a copy drops
 * cloud artifact identities.
 */
export async function cacheCopySources(
  document: ProjectDocument,
  load: (checksum: string) => Promise<Uint8Array | null>,
  hash: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>
): Promise<void> {
  const seen = new Set<string>();
  for (const node of documentNodesWithHistory(document)) {
    if (
      node.kind !== 'feature' ||
      (node.data.featureKind !== 'imported-mesh' &&
        node.data.featureKind !== 'imported-step')
    )
      continue;
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) continue;
    const key = `${node.data.featureKind}:${ref.checksumSha256}:${ref.logicalBytes}`;
    if (seen.has(key)) continue;
    let bytes = await load(ref.checksumSha256);
    if (!bytes) {
      const { resolveExactSourceBytes } = await import('./exactSourceResolver');
      bytes = await resolveExactSourceBytes(ref, node.data);
    }
    if (
      bytes.byteLength !== ref.logicalBytes ||
      (await hash(bytes as Uint8Array<ArrayBuffer>)) !== ref.checksumSha256
    )
      throw new Error(
        `The source file for "${node.data.sourceName}" failed its integrity check. The copy was not created.`
      );
    seen.add(key);
  }
  await cacheCopyPictures(document, load, hash);
}

/**
 * I05 pictures: a copy re-archives them from this device into its own
 * project, so their bytes must be here before the copy drops the source
 * project's artifact ids. The account copy carries imports across itself and
 * needs only this half.
 */
export async function cacheCopyPictures(
  document: ProjectDocument,
  load: (checksum: string) => Promise<Uint8Array | null>,
  hash: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>
): Promise<void> {
  const seen = new Set<string>();
  for (const image of referenceImagesWithHistory(document)) {
    const ref = image.source;
    const key = `reference-image:${ref.checksumSha256}:${ref.logicalBytes}`;
    if (seen.has(key)) continue;
    let bytes = await load(ref.checksumSha256);
    if (!bytes) {
      const { resolveExactSourceBytes } = await import('./exactSourceResolver');
      bytes = await resolveExactSourceBytes(ref, {
        artifactId: image.artifactId,
        sourceName: image.name
      });
    }
    if (
      bytes.byteLength !== ref.logicalBytes ||
      (await hash(bytes as Uint8Array<ArrayBuffer>)) !== ref.checksumSha256
    )
      throw new Error(
        `The picture for image "${image.name}" failed its integrity check. The copy was not created.`
      );
    seen.add(key);
  }
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
 * After expiry, persisted documents and their durable undo/redo references
 * protect source bytes. Cleanup still belongs to the tab that created or
 * remembered abandoning the key, avoiding cross-tab data loss.
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
