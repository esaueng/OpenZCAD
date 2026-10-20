import {
  documentNodesWithHistory,
  documentAssetsWithHistory,
  type ProjectDocument
} from '@openzcad/shared';

/** Kinds whose cancelled upload can leave an unacknowledged mesh archive. */
export function isMeshImportArchiveKind(kind: string): boolean {
  return (
    kind === 'mesh-payload' || kind === 'stl-import' || kind === 'mesh-import'
  );
}

/** Source locations held by the model or by its durable undo/redo entries. */
export function importArtifactIds(document: ProjectDocument): string[] {
  const ids = new Set<string>();
  for (const asset of documentAssetsWithHistory(document)) {
    if (asset.artifactId && !asset.artifactId.startsWith('artifact_local_'))
      ids.add(asset.artifactId);
  }
  for (const node of documentNodesWithHistory(document)) {
    if (
      node.kind === 'feature' &&
      (node.data.featureKind === 'imported-mesh' ||
        node.data.featureKind === 'imported-step') &&
      !node.data.artifactId.startsWith('artifact_local_')
    ) {
      ids.add(node.data.artifactId);
    }
  }
  return [...ids];
}

/** One JSON binding keeps large histories below D1's parameter ceiling. */
export function meshDiscardCommitGuard(
  document: ProjectDocument,
  /** Ids the document no longer holds, such as an adoption's original ones. */
  extraIds: readonly string[] = []
): {
  sql: string;
  bindings: string[];
} {
  const ids = [...new Set([...importArtifactIds(document), ...extraIds])];
  return ids.length
    ? {
        sql: ` AND NOT EXISTS (
          SELECT 1 FROM artifact_mesh_discards
          WHERE artifact_id IN (SELECT value FROM json_each(?))
        )`,
        bindings: [JSON.stringify(ids)]
      }
    : { sql: '', bindings: [] };
}
