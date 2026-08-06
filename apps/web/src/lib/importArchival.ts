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
  /** Content-addressed reference into the local blob store, when present. */
  checksumSha256: string | null;
  /** Legacy embedded STEP text, when the import predates references. */
  stepText: string | null;
}

/**
 * STEP imports whose source was never archived to the account. Mesh imports
 * are excluded deliberately: their geometry is embedded in the document, so
 * every device can rebuild them — only the original file is unarchived, and
 * those bytes are no longer held anywhere the app can reach.
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
    sources.push({
      featureId: feature.featureId,
      sourceName: feature.data.sourceName,
      checksumSha256: feature.data.stepSourceRef?.checksumSha256 ?? null,
      stepText: feature.data.stepText ?? null
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
 * edit. The document keeps its content-addressed reference (or embedded
 * text), so a partial failure loses nothing — the untouched features simply
 * stay local-only and the action can run again.
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
    let bytes: Uint8Array | null = null;
    try {
      if (source.checksumSha256) {
        bytes = await deps.loadSourceBytes(source.checksumSha256);
      }
      if (!bytes && source.stepText !== null) {
        bytes = new TextEncoder().encode(source.stepText);
      }
    } catch {
      bytes = null;
    }
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
