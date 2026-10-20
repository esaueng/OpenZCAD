/**
 * Builds an account project's duplicate or branch in the browser (ADR-024
 * Phase 1), so the Worker stores a copy it never had to construct. Loaded on
 * demand: only Duplicate and Branch reach it.
 */
import {
  duplicateProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { archiveAccountImportSources } from './accountImportSources';
import type { ArchiveArtifactInput } from './archiveArtifact';
import {
  listLocalOnlyImportSources,
  type ArchiveLocalSourcesResult
} from './importArchival';
import {
  importSourceCopyRefs,
  projectCopyDocumentDigest
} from '@openzcad/persistence';
import {
  duplicateProjectName,
  projectBranchPoint,
  toRevisionId,
  type DuplicateProjectRequest,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';

export interface CloudProjectCopySource {
  projectId: string;
  /** The source's shelf name: what the copy and a branch's lineage name. */
  projectName: string;
  /** Branch from this stored save state instead of the current document. */
  saveState?: { revisionId: string; reason: string };
}

export interface CloudProjectCopyStore {
  loadProject: (projectId: string) => Promise<ProjectDocument>;
  /** Null when the account no longer stores the save state. */
  loadRevision: (
    projectId: string,
    revisionId: string
  ) => Promise<ProjectDocument | null>;
}

/**
 * The request that stores a copy of `source`, or null when the account cannot
 * supply the save state to branch. The copy carries a fresh `proj_<uuid>` id,
 * its "Duplicated from" or "Branched from" save point, device-local import
 * references, the canonical digest copy rollback compares, and the list of
 * the source's archived imports the account copies byte for byte.
 */
export async function buildCloudProjectCopy(
  source: CloudProjectCopySource,
  ownerUserId: UserId,
  existingNames: Iterable<string>,
  store: CloudProjectCopyStore,
  /**
   * Brings the source's reference-image pictures onto this device: the copy
   * holds them under device-local ids and archives them into itself, since
   * the account copies import sources only.
   */
  cachePictures: (document: ProjectDocument) => Promise<void> = async () => {}
): Promise<Omit<DuplicateProjectRequest, 'projectId'> | null> {
  const { saveState } = source;
  const document = saveState
    ? await store.loadRevision(source.projectId, saveState.revisionId)
    : await store.loadProject(source.projectId);
  if (!document) return null;
  await cachePictures(document);
  // The copy is named after the project, not after the save state it starts
  // from: "Bracket (copy)" is what the user is looking for on the shelf.
  const copy = duplicateProjectDocument(
    document,
    duplicateProjectName(source.projectName, existingNames),
    ownerUserId,
    saveState
      ? projectBranchPoint(
          { projectId: document.projectId, name: source.projectName },
          {
            revisionId: toRevisionId(saveState.revisionId),
            reason: saveState.reason
          }
        )
      : undefined
  );
  return {
    document: copy,
    documentDigest: await projectCopyDocumentDigest(copy),
    importSources: importSourceCopyRefs(document, copy),
    ...(saveState ? { revisionId: toRevisionId(saveState.revisionId) } : {})
  };
}

export interface CopyPicturePublisher {
  /** Bytes from this device's source store (the copy cached them). */
  loadSourceBytes(checksumSha256: string): Promise<Uint8Array | null>;
  /** Uploads one picture as an artifact of the copy's own project. */
  archive(input: ArchiveArtifactInput): Promise<string>;
  /** Stores the rewritten copy over the version the account just created. */
  save(
    document: ProjectDocument,
    expectedVersion: number
  ): Promise<{ version: number; updatedAt: string }>;
}

/**
 * Finishes an account copy that holds reference images: the account carries
 * import sources across itself, but the pictures arrive under device-local
 * ids, so this uploads each one into the copy's own project, rewrites the ids
 * everywhere (undo history included) and stores the result before the copy is
 * reported made. Every other device can then draw them at once. A picture
 * that cannot be uploaded keeps its local id — the copy's next account save
 * retries it — and is reported in `result`.
 */
export async function publishCopyPictures(
  copy: ProjectDocument,
  expectedVersion: number,
  publisher: CopyPicturePublisher
): Promise<{ document: ProjectDocument; result: ArchiveLocalSourcesResult }> {
  const empty = { archived: [], missing: [], failed: [] };
  if (
    !listLocalOnlyImportSources(copy).some(
      (source) => source.kind === 'reference-image'
    )
  )
    return { document: copy, result: empty };
  const prepared = await archiveAccountImportSources(copy, {
    loadSourceBytes: publisher.loadSourceBytes,
    archive: (input) => publisher.archive(input)
  });
  if (prepared.document === copy) return prepared;
  const saved = await publisher.save(
    withoutDerivedProjection(prepared.document),
    expectedVersion
  );
  return {
    document: {
      ...prepared.document,
      version: saved.version,
      derived: { ...prepared.document.derived, updatedAt: saved.updatedAt }
    },
    result: prepared.result
  };
}
