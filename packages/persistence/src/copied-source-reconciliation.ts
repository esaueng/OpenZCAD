import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  type ArtifactId,
  type ProjectDocument,
  type ProjectId
} from '@openzcad/shared';
import { ArtifactStorageError, type PersistenceService } from './index';
import { isUnreadableStoredDocument } from './stored-document';

export interface CopiedImportArchive {
  projectId: ProjectId;
  checksumSha256: string;
  logicalBytes: number;
  kind: 'mesh-payload' | 'step-import';
  artifactId: ArtifactId;
}

const sourceKey = (
  source: Pick<CopiedImportArchive, 'kind' | 'checksumSha256' | 'logicalBytes'>
) => `${source.kind}:${source.checksumSha256}:${source.logicalBytes}`;

export function copiedImportArchives(
  document: ProjectDocument
): CopiedImportArchive[] {
  const archives = new Map<string, CopiedImportArchive>();
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) continue;
    const artifactId = (node.data as { artifactId: ArtifactId }).artifactId;
    if (artifactId.startsWith('artifact_local_')) continue;
    const archive: CopiedImportArchive = {
      projectId: document.projectId,
      checksumSha256: ref.checksumSha256,
      logicalBytes: ref.logicalBytes,
      kind:
        node.data.featureKind === 'imported-mesh'
          ? 'mesh-payload'
          : 'step-import',
      artifactId
    };
    archives.set(sourceKey(archive), archive);
  }
  return [...archives.values()];
}

export async function verifyCopiedImportArchives(
  persistence: PersistenceService & {
    loadCopiedImportArchives(
      userId: Parameters<PersistenceService['listArtifacts']>[0],
      projectId: ProjectId
    ): Promise<CopiedImportArchive[]>;
  },
  userId: Parameters<PersistenceService['listArtifacts']>[0],
  projectId: ProjectId,
  archives: readonly CopiedImportArchive[],
  documents: readonly ProjectDocument[] = []
): Promise<CopiedImportArchive[]> {
  const { artifacts } = await persistence.listArtifacts(userId, projectId);
  const trusted = new Map(
    (await persistence.loadCopiedImportArchives(userId, projectId)).map(
      (archive) => [sourceKey(archive), archive]
    )
  );
  const owned = new Map(
    artifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  const verified: CopiedImportArchive[] = [];
  for (const requested of archives) {
    const archive = trusted.get(sourceKey(requested));
    if (!archive || requested.projectId !== projectId)
      throw new ArtifactStorageError(
        'The copied import archive is not verified.'
      );
    const artifact = owned.get(archive.artifactId);
    if (
      !artifact ||
      archive.projectId !== projectId ||
      artifact.projectId !== projectId ||
      artifact.kind !== archive.kind ||
      artifact.bytes !== archive.logicalBytes
    )
      throw new ArtifactStorageError(
        'The copied import archive is unavailable.'
      );
    verified.push(archive);
  }
  for (const document of documents) {
    if (document.projectId !== projectId)
      throw new ArtifactStorageError('The copied project identity changed.');
    for (const node of documentNodesWithHistory(document)) {
      if (node.kind !== 'feature') continue;
      const ref = importedSourceReferenceOf(node.data);
      if (!ref) continue;
      const id = (node.data as { artifactId: ArtifactId }).artifactId;
      if (id.startsWith('artifact_local_')) continue;
      const artifact = owned.get(id);
      const kind =
        node.data.featureKind === 'imported-mesh'
          ? 'mesh-payload'
          : 'step-import';
      if (
        !artifact ||
        artifact.projectId !== projectId ||
        artifact.kind !== kind ||
        (artifact.bytes !== undefined && artifact.bytes !== ref.logicalBytes)
      )
        throw new ArtifactStorageError(
          'The copied project has an unavailable import source.'
        );
    }
  }
  return verified;
}

/** Rehome exact local source ids without replacing geometry, history or derived buffers. */
export function reconcileCopiedImportSources(
  document: ProjectDocument,
  archives: readonly CopiedImportArchive[]
): ProjectDocument {
  // A stored document this build could not read is served as stored.
  if (isUnreadableStoredDocument(document)) return document;
  const mapped = new Map(
    archives
      .filter((archive) => archive.projectId === document.projectId)
      .map((archive) => [sourceKey(archive), archive.artifactId])
  );
  const local = new Map<string, string>();
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    if (!ref) continue;
    const artifactId = (node.data as { artifactId: ArtifactId }).artifactId;
    const key = sourceKey({
      ...ref,
      kind:
        node.data.featureKind === 'imported-mesh'
          ? 'mesh-payload'
          : 'step-import'
    });
    if (artifactId.startsWith('artifact_local_')) {
      if (local.has(artifactId) && local.get(artifactId) !== key)
        throw new ArtifactStorageError(
          'A local source id names different imported content.'
        );
      local.set(artifactId, key);
    } else mapped.set(key, artifactId); // Existing owned sources win; callers validate ownership.
  }
  const replacements = new Map(
    [...local].flatMap(([id, key]) => {
      const replacement = mapped.get(key);
      return replacement ? [[id, replacement] as const] : [];
    })
  );
  if (!replacements.size) return document;
  const { derived, ...content } = document;
  const rewritten = structuredClone(content);
  const pending: unknown[] = [rewritten];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'artifactId' && typeof child === 'string')
        (value as Record<string, unknown>)[key] =
          replacements.get(child) ?? child;
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return { ...rewritten, derived };
}

export function assertCopiedSourcesArchived(document: ProjectDocument): void {
  for (const node of documentNodesWithHistory(document)) {
    if (
      node.kind === 'feature' &&
      importedSourceReferenceOf(node.data) &&
      (node.data as { artifactId: string }).artifactId.startsWith(
        'artifact_local_'
      )
    )
      throw new ArtifactStorageError(
        'The copied project has import sources that still need archiving.'
      );
  }
}
