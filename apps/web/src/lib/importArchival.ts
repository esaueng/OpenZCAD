import { listFeaturesInOrder } from '@openzcad/document-core';
import type { FeatureId, ProjectDocument } from '@openzcad/shared';

/**
 * Artifact ids minted when an import's cloud archival failed (or storage was
 * unavailable). The bytes exist only in this browser's blob store or embedded
 * in the document; nothing under this id was ever uploaded.
 */
export const LOCAL_ARTIFACT_ID_PREFIX = 'artifact_local_';

export interface LocalOnlyImportSource {
  featureId: FeatureId;
  sourceName: string;
  /** Content-addressed reference; the bytes it names live only on this device. */
  checksumSha256: string;
}

/**
 * STEP imports this device alone can rebuild: reference-form sources whose
 * bytes were never archived, so no other device can resolve the checksum.
 *
 * Two kinds of import are excluded, for the same reason — the document itself
 * carries what a rebuild needs, and it syncs:
 *
 * - Mesh imports embed their geometry.
 * - STEP imports in the legacy embedded form carry `stepText`, which
 *   `prepareProjectStorageSnapshot` externalises into a project asset and
 *   hydration restores, and which the kernel consumes directly without
 *   consulting the blob store or the artifact. Reporting one of these as
 *   local-only would warn about a project every device can already open.
 *
 * In both cases only the *original uploaded file* is unarchived, which costs
 * nobody a rebuild.
 */
export function listLocalOnlyImportSources(
  document: ProjectDocument
): LocalOnlyImportSource[] {
  const sources: LocalOnlyImportSource[] = [];
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.data.featureKind !== 'imported-step') {
      continue;
    }
    if (!feature.data.artifactId.startsWith(LOCAL_ARTIFACT_ID_PREFIX)) {
      continue;
    }
    const checksumSha256 = feature.data.stepSourceRef?.checksumSha256;
    if (checksumSha256 === undefined) {
      continue;
    }
    sources.push({
      featureId: feature.featureId,
      sourceName: feature.data.sourceName,
      checksumSha256
    });
  }
  return sources;
}

/** Every source checksum the document's imports need in order to rebuild. */
export function importSourceChecksums(document: ProjectDocument): Set<string> {
  const checksums = new Set<string>();
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.data.featureKind !== 'imported-step') {
      continue;
    }
    const checksum = feature.data.stepSourceRef?.checksumSha256;
    if (checksum !== undefined) {
      checksums.add(checksum);
    }
  }
  return checksums;
}

/** Answers whether any import is still working with a checksum's bytes. */
export interface ImportChecksumMarks {
  has(checksumSha256: string): boolean;
}

/**
 * Marks the checksums of imports that are between writing their source bytes
 * and learning the fate of the feature those bytes belong to.
 *
 * It counts rather than merely records, because content addressing puts every
 * import of one file on ONE key: with a set, two concurrent imports of the same
 * file produce a single mark, and whichever finishes first erases the
 * protection of the one still running — after which a refusal on either side
 * deletes bytes the survivor is about to commit against. The count is the
 * number of holders, so the mark outlives every release but the last.
 */
export interface InFlightImportChecksums extends ImportChecksumMarks {
  /** Marks the checksum for one holder. Pair with exactly one `release`. */
  acquire(checksumSha256: string): void;
  release(checksumSha256: string): void;
}

export function createInFlightImportChecksums(): InFlightImportChecksums {
  const holders = new Map<string, number>();
  return {
    has: (checksumSha256) => (holders.get(checksumSha256) ?? 0) > 0,
    acquire(checksumSha256) {
      holders.set(checksumSha256, (holders.get(checksumSha256) ?? 0) + 1);
    },
    release(checksumSha256) {
      const remaining = (holders.get(checksumSha256) ?? 0) - 1;
      if (remaining > 0) {
        holders.set(checksumSha256, remaining);
      } else {
        holders.delete(checksumSha256);
      }
    }
  };
}

/**
 * Drops the bytes of an import that was refused before it reached history.
 *
 * Every guard below exists because the blob store is DEVICE-GLOBAL and
 * content-addressed: one key holds the bytes of one file, whoever imported it
 * and from whichever project. Counting references against the one open
 * document is therefore not enough on its own — deleting on behalf of project
 * Y can destroy what project X rebuilds from.
 *
 * `createdByThisImport` is what makes the deletion sound: this call only ever
 * removes a key it put there itself, so bytes that predate the import survive
 * whatever else is true. The alternative — counting across every locally
 * stored document — is both slower and incomplete, because it would still have
 * to enumerate undo/redo snapshots and imports mid-flight in other tabs to
 * reach the same guarantee.
 *
 * `pruneUnreferencedSourceBlobs` cannot serve here either: it sweeps every key
 * outside the set it is handed, which for one document is every other
 * project's sources.
 *
 * A cloud archive of the same bytes is deliberately NOT a reason to keep them.
 * The rationale it used to carry — that the local copy spares a future
 * re-upload — is not true of any code path: nothing reads an unreferenced blob,
 * `archiveLocalOnlyImportSources` only ever loads bytes a *feature* still
 * points at, and the artifact minted for a refused import is itself
 * unreferenced. Keeping them was a pure local leak of up to 250 MB that also
 * disarmed this cleanup for every later import of the same file, since those
 * bytes then pre-existed and `createdByThisImport` came back false.
 *
 * Returns whether the blob was deleted.
 */
export async function discardUnreferencedImportSource(deps: {
  checksumSha256: string;
  /** False when the blob store already held these bytes; see above. */
  createdByThisImport: boolean;
  document: ProjectDocument | null;
  /**
   * Checksums of imports still validating. Content addressing means a second
   * import of the same file lands on the same key, and the first import is
   * about to commit against it.
   */
  inFlightChecksums: ImportChecksumMarks;
  deleteSourceBlob(checksumSha256: string): Promise<void>;
}): Promise<boolean> {
  if (
    !deps.createdByThisImport ||
    deps.inFlightChecksums.has(deps.checksumSha256)
  ) {
    return false;
  }
  if (
    deps.document &&
    importSourceChecksums(deps.document).has(deps.checksumSha256)
  ) {
    return false;
  }
  await deps.deleteSourceBlob(deps.checksumSha256);
  return true;
}

/** What a finished import run means for the source bytes it wrote. */
export type ImportRunResult =
  /** A feature in document history points at the bytes. */
  | 'committed'
  /** The file was judged — by the kernel or by the commit — and refused. */
  | 'refused'
  /**
   * Nothing was decided about the file: the commit lock turned the run away,
   * or the document kept moving underneath its rebuild. The obvious next step
   * is the same import again, so the bytes are not garbage.
   */
  | 'no-verdict';

/**
 * Decides what becomes of the source bytes once an import run has ended, and
 * keeps `abandonedChecksums` — this tab's note of what it wrote and did not
 * land — in step with that decision.
 *
 * The note is what keeps a retry able to clean up after itself. Content
 * addressing means a retry of the same file writes nothing (the key is already
 * there), so on its own it would conclude the bytes were not its to delete and
 * a genuine kernel refusal would keep the full source forever.
 *
 * Returns whether the bytes were deleted.
 */
export async function settleImportSource(deps: {
  checksumSha256: string;
  result: ImportRunResult;
  /** True when this import's own write is what put the bytes in the store. */
  createdByThisImport: boolean;
  /** Checksums this tab wrote for imports that never landed; updated in place. */
  abandonedChecksums: Set<string>;
  document: ProjectDocument | null;
  inFlightChecksums: ImportChecksumMarks;
  deleteSourceBlob(checksumSha256: string): Promise<void>;
}): Promise<boolean> {
  const checksum = deps.checksumSha256;
  const abandoned = deps.abandonedChecksums;
  if (
    deps.result === 'committed' ||
    (deps.document !== null &&
      importSourceChecksums(deps.document).has(checksum))
  ) {
    // A feature rebuilds from these bytes, so they are nobody's to discard —
    // including any later run of this tab's.
    abandoned.delete(checksum);
    return false;
  }
  if (!deps.createdByThisImport && !abandoned.has(checksum)) {
    // THE OWNERSHIP RULE, and the whole of this module's cross-tab safety.
    //
    // A run only ever deletes a key its OWN TAB put there, in an import that is
    // still running or that ended without a verdict. Note what that makes
    // unreachable: a tab that did not write these bytes never asks, and it can
    // never start asking later — `abandoned` is only ever added to BELOW this
    // guard, so a tab that has not created the key cannot acquire a licence for
    // it.
    //
    // What that does NOT establish, since two tabs on one device share this
    // store and see none of each other's marks, documents or undo stacks: the
    // CREATING tab can still delete bytes another tab has since committed a
    // feature against, when that feature lives in a project this tab does not
    // have open. The reference check above reads one document — this tab's —
    // so it cannot see that one. Narrow (it needs the same file imported in two
    // tabs, the first reaching no verdict and later refusing) but real, and the
    // deferred per-device claim record is what closes it. Do not read the
    // ownership rule as a cross-tab guarantee; it is a floor, not a proof.
    //
    // The cost, stated plainly because it is deliberate: cleanup belongs solely
    // to the creating tab, so bytes orphaned by a tab that was closed mid-import
    // are collected by nobody. That is a leak of up to 250 MB per orphaned
    // import, bounded by how often a window is closed mid-rebuild. It is the
    // right trade — a leaked blob costs disk, a wrongly deleted one costs
    // somebody's model — and it is the reason there is no device-wide deletion
    // walk here. Widening who may delete puts the decision on a scan that
    // cannot see the one thing that matters: an undone import's redo stack,
    // which lives only in the memory of the tab that made it.
    return false;
  }
  if (deps.result === 'no-verdict') {
    abandoned.add(checksum);
    return false;
  }
  const deleted = await discardUnreferencedImportSource({
    checksumSha256: checksum,
    createdByThisImport: true,
    document: deps.document,
    inFlightChecksums: deps.inFlightChecksums,
    deleteSourceBlob: deps.deleteSourceBlob
  });
  if (deleted) {
    abandoned.delete(checksum);
  } else {
    // Another import of the same file is still holding these bytes. The note
    // stays, so whoever is last out can still clean up after all of them.
    abandoned.add(checksum);
  }
  return deleted;
}

export interface ArchiveLocalSourcesResult {
  /** Sources uploaded and rewired to their new cloud artifact id. */
  archived: string[];
  /** Sources whose bytes could not be found on this device. */
  missing: string[];
  /** Sources whose upload or document update failed; retry later. */
  failed: string[];
}

/**
 * Uploads every local-only STEP source it can find bytes for, then rewires
 * the owning feature to the finalized artifact id via the injected document
 * edit. The document keeps its content-addressed reference, so a partial
 * failure loses nothing — the untouched features simply stay local-only and
 * the action can run again.
 */
export async function archiveLocalOnlyImportSources(deps: {
  document: ProjectDocument;
  loadSourceBytes(checksumSha256: string): Promise<Uint8Array | null>;
  archive(input: {
    fileName: string;
    contentType: string;
    kind: 'step-import';
    body: Blob;
    metadata: Record<string, string>;
  }): Promise<string>;
  /** Applies the artifact id to the feature; false when the edit refused. */
  applyArtifactId(featureId: FeatureId, artifactId: string): boolean;
}): Promise<ArchiveLocalSourcesResult> {
  const result: ArchiveLocalSourcesResult = {
    archived: [],
    missing: [],
    failed: []
  };
  for (const source of listLocalOnlyImportSources(deps.document)) {
    // A store that throws reads the same as a store that has nothing: this
    // device cannot produce the bytes, so the source stays local-only.
    const bytes = await deps
      .loadSourceBytes(source.checksumSha256)
      .catch(() => null);
    if (!bytes) {
      result.missing.push(source.sourceName);
      continue;
    }
    try {
      const artifactId = await deps.archive({
        fileName: source.sourceName,
        contentType: 'model/step',
        kind: 'step-import',
        body: new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: 'model/step'
        }),
        metadata: { source: 'retry-archive' }
      });
      if (deps.applyArtifactId(source.featureId, artifactId)) {
        result.archived.push(source.sourceName);
      } else {
        result.failed.push(source.sourceName);
      }
    } catch {
      result.failed.push(source.sourceName);
    }
  }
  return result;
}
