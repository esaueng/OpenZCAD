import { CommandManager } from '@openzcad/command-system';
import {
  documentNodesWithHistory,
  type ProjectDocument
} from '@openzcad/shared';
import {
  archiveLocalOnlyImportSources,
  listLocalOnlyImportSources,
  type ArchiveLocalSourcesResult
} from './importArchival';

/** Prepare a snapshot for account storage without changing a live editor. */
export async function archiveAccountImportSources(
  document: ProjectDocument,
  dependencies: Pick<
    Parameters<typeof archiveLocalOnlyImportSources>[0],
    'loadSourceBytes' | 'archive'
  >
): Promise<{ document: ProjectDocument; result: ArchiveLocalSourcesResult }> {
  const manager = new CommandManager(document);
  const result = await archiveLocalOnlyImportSources({
    document,
    ...dependencies,
    applyArtifactId(featureId, artifactId) {
      manager.archiveSource(featureId, artifactId);
      return true;
    }
  });
  return { document: manager.document, result };
}

export function sourceUploadMessage(
  result: ArchiveLocalSourcesResult
): string | null {
  const remaining = result.missing.length + result.failed.length;
  if (!remaining) return null;
  const details = [
    result.missing.length
      ? `Missing on this device: ${result.missing.join(', ')}.`
      : '',
    result.failed.length ? `Upload failed: ${result.failed.join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join(' ');
  return `Project saved, but ${remaining} source file(s) still need uploading. ${details} Use Save to retry.`;
}

/** Carry acknowledged source locations into edits made while an upload ran. */
export function applyAccountSourceArchives(
  current: ProjectDocument,
  acknowledged: ProjectDocument
): ProjectDocument {
  if (current.projectId !== acknowledged.projectId) return current;
  const archived = new Map<string, string>();
  for (const node of documentNodesWithHistory(acknowledged)) {
    if (
      node.kind === 'feature' &&
      node.data.featureKind === 'imported-step' &&
      node.data.stepSourceRef &&
      !node.data.artifactId.startsWith('artifact_local_')
    ) {
      archived.set(
        node.data.stepSourceRef.checksumSha256,
        node.data.artifactId
      );
    }
  }
  const manager = new CommandManager(current);
  for (const source of listLocalOnlyImportSources(current)) {
    const artifactId = archived.get(source.checksumSha256);
    if (!artifactId) continue;
    // A replaced import can retain its feature ID. Its new bytes must not be
    // relabelled as the old source that just finished uploading.
    const changedSource = [...documentNodesWithHistory(current)].some(
      (node) =>
        node.kind === 'feature' &&
        node.featureId === source.featureId &&
        node.data.featureKind === 'imported-step' &&
        node.data.stepSourceRef?.checksumSha256 !== source.checksumSha256
    );
    if (!changedSource) manager.archiveSource(source.featureId, artifactId);
  }
  return manager.document;
}
