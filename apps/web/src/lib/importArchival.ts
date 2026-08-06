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
