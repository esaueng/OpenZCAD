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

export { localizeImportedSourceArtifacts } from '@openzcad/document-core';

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
    applyArtifactId(featureId, artifactId, source) {
      manager.archiveSource(featureId, artifactId, source);
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
      archived.set(
        `${node.data.featureKind === 'imported-mesh' ? 'mesh-payload' : 'step-source'}:${sourceRef.checksumSha256}:${sourceRef.logicalBytes}`,
        artifactId
      );
    }
  }
  const manager = new CommandManager(current);
  for (const source of listLocalOnlyImportSources(current)) {
    const artifactId = archived.get(
      `${source.kind}:${source.checksumSha256}:${source.logicalBytes}`
    );
    if (artifactId) manager.archiveSource(source.featureId, artifactId, source);
  }
  return manager.document;
}
