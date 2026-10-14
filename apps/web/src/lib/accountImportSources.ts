import { countLabel } from './toasts';
import { CommandManager } from '@openzcad/command-system';
import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  type ProjectDocument
} from '@openzcad/shared';
import {
  archiveLocalOnlyImportSources,
  listLocalOnlyImportSources,
  type ArchiveLocalSourcesResult
} from './importArchival';

/**
 * A share copy owns its document, but the archived source artifacts still
 * belong to the original project. The share preload has cached their bytes;
 * mark those references local so Save uploads them under the copy's account
 * project instead of depending on the owner's access or share token forever.
 * Command payloads and undo/redo snapshots must name the same new locations.
 */
export function localizeImportedSourceArtifacts(
  document: ProjectDocument
): ProjectDocument {
  const replacements = new Map<string, string>();
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    const artifactId = (node.data as { artifactId?: string }).artifactId;
    if (ref && artifactId && !artifactId.startsWith('artifact_local_')) {
      replacements.set(artifactId, `artifact_local_${ref.checksumSha256}`);
    }
  }
  if (!replacements.size) return document;
  const { derived, ...content } = document;
  const localized = JSON.parse(
    JSON.stringify(content, (key, value: unknown) =>
      key === 'artifactId' && typeof value === 'string'
        ? (replacements.get(value) ?? value)
        : value
    )
  ) as Omit<ProjectDocument, 'derived'>;
  return { ...localized, derived };
}

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
  return `Project saved, but ${countLabel(remaining, 'source file', 'source files')} still need uploading. ${details} Use Save to retry.`;
}

/** Carry acknowledged source locations into edits made while an upload ran. */
export function applyAccountSourceArchives(
  current: ProjectDocument,
  acknowledged: ProjectDocument
): ProjectDocument {
  if (current.projectId !== acknowledged.projectId) return current;
  const archived = new Map<string, string>();
  for (const node of documentNodesWithHistory(acknowledged)) {
    if (node.kind !== 'feature') continue;
    const sourceRef = importedSourceReferenceOf(node.data);
    const { artifactId } = node.data as { artifactId: string };
    if (sourceRef && !artifactId.startsWith('artifact_local_')) {
      archived.set(sourceRef.checksumSha256, artifactId);
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
        importedSourceReferenceOf(node.data) !== undefined &&
        importedSourceReferenceOf(node.data)?.checksumSha256 !==
          source.checksumSha256
    );
    if (!changedSource) manager.archiveSource(source.featureId, artifactId);
  }
  return manager.document;
}
