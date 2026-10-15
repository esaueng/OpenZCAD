import {
  documentNodesWithHistory,
  type ProjectDocument
} from '@openzcad/shared';

/** Source locations held by the model or by its durable undo/redo entries. */
export function importArtifactIds(document: ProjectDocument): string[] {
  const ids = new Set<string>();
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
export function meshDiscardCommitGuard(document: ProjectDocument): {
  sql: string;
  bindings: string[];
} {
  const ids = importArtifactIds(document);
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
