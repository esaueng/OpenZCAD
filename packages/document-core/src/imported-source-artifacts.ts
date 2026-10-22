import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  referenceImagesWithHistory,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Archived import artifacts belong to one project. A copy keeps the content
 * references but needs its own archive, including references in commands and
 * undo/redo. The source document and its derived buffers remain untouched.
 *
 * Reference-image pictures (I05) are localized the same way. Unlike imports,
 * the account copy does not carry them across: the copy re-archives them from
 * this device's blob store into its own project, so it never depends on the
 * source project's artifact.
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
  for (const image of referenceImagesWithHistory(document)) {
    const artifactId = image.artifactId;
    if (
      typeof artifactId === 'string' &&
      !artifactId.startsWith('artifact_local_') &&
      typeof image.source?.checksumSha256 === 'string'
    ) {
      replacements.set(
        artifactId,
        `artifact_local_${image.source.checksumSha256}`
      );
    }
  }
  if (!replacements.size) return document;
  const { derived, ...content } = document;
  const localized = structuredClone(content);
  const pending: unknown[] = [localized];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'artifactId' && typeof child === 'string') {
        (value as Record<string, unknown>)[key] =
          replacements.get(child) ?? child;
      } else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return { ...localized, derived };
}
