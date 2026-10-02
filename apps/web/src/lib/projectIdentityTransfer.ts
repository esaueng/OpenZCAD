/**
 * Saving a device project to an account, and moving it to the identity the
 * account assigned.
 *
 * This only runs when a project is saved to an account, so App loads it with
 * `import()` rather than carrying it in the entry chunk.
 */
import type { CommandManager } from '@openzcad/command-system';
import {
  reidentifyProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  toProjectId,
  type ArtifactRecord,
  type ProjectDocument,
  type ProjectId,
  type ProjectSummary,
  type UserId
} from '@openzcad/shared';
import {
  archiveAccountImportSources,
  sourceUploadMessage
} from './accountImportSources';
import { ApiError, api } from './api';
import { archiveArtifact as archiveArtifactBody } from './archiveArtifact';
import {
  conflictFromDocuments,
  type ProjectConflict
} from './conflictRecovery';
import type { BackupFile } from './projectBackup';
import type { StoredMeasurementRecord } from './measurementRecord';
import {
  LOCAL_PROJECT_CHECKPOINT_STORE as CHECKPOINT_STORE_NAME,
  LOCAL_PROJECT_DOCUMENT_STORE as STORE_NAME
} from './localProjectSchema';
import {
  ACCOUNT_IDENTITY_STORE_NAME,
  ALIAS_STORE_NAME,
  BACKUP_STORE_NAME,
  checkpointKeyRange,
  chooseProjectDocument,
  loadLastSyncedVersion,
  loadLocalProject,
  loadSourceBlob,
  LocalProjectIdentityChangedError,
  MEASUREMENT_STORE_NAME,
  META_STORE_NAME,
  projectMatchesInterruptedAdoption,
  projectPreservesLocalWork,
  resolvedProjectId,
  saveLocalProject,
  scopedTransaction,
  settled,
  summarizeProjectDocument,
  SUMMARY_STORE_NAME,
  SYNC_STORE_NAME,
  THUMBNAIL_STORE_NAME,
  withMatchingLocalDerived,
  type ProjectCheckpointDocumentRecord
} from './localProjectStore';
import { rekeyWorkspaceProject } from './workspaceSession';

/** Both local copies survive until the existing conflict flow chooses a side. */
export class LocalProjectIdentityConflictError extends Error {
  constructor(
    readonly local: ProjectDocument,
    readonly account: ProjectDocument
  ) {
    super('This device has different work under the account project identity.');
    this.name = 'LocalProjectIdentityConflictError';
  }
}

/** The document owned, and its edit history attributed, to `ownerUserId`. */
function withAccountOwner(
  document: ProjectDocument,
  ownerUserId: UserId
): ProjectDocument {
  return {
    ...document,
    ownerUserId,
    ...(document.editHistory
      ? {
          editHistory: {
            ...document.editHistory,
            actorUserId: ownerUserId
          }
        }
      : {})
  };
}

/** The document under the account's project ID and owner. */
function withAccountIdentity(
  document: ProjectDocument,
  projectId: ProjectId,
  ownerUserId: UserId
): ProjectDocument {
  return withAccountOwner(
    reidentifyProjectDocument(document, projectId),
    ownerUserId
  );
}

/** Keeps a newer durable transfer ahead of an older open manager snapshot. */
export function latestTransferredProjectDocument(
  transferred: ProjectDocument,
  live: ProjectDocument
): ProjectDocument {
  if (live.version <= transferred.version) return transferred;
  const moved = reidentifyProjectDocument(live, transferred.projectId);
  return {
    ...moved,
    ownerUserId: transferred.ownerUserId,
    ...(moved.editHistory
      ? {
          editHistory: {
            ...moved.editHistory,
            actorUserId: transferred.ownerUserId
          }
        }
      : {})
  };
}

/** Retains older account copies even if logout already removed their baseline. */
export function retainPreviousAccountProject(
  source: ProjectDocument,
  localUserId: UserId,
  accountUserId: UserId
): boolean {
  return (
    source.ownerUserId !== localUserId && source.ownerUserId !== accountUserId
  );
}

/** Moves the same local model and companion records in one durable transaction. */
export function rekeyLocalProject(
  source: ProjectDocument,
  targetProjectId: string,
  options: { retainSource?: boolean } = {}
): Promise<ProjectDocument> {
  if (source.projectId === targetProjectId) return Promise.resolve(source);
  const singleStores = [
    META_STORE_NAME,
    SYNC_STORE_NAME,
    THUMBNAIL_STORE_NAME,
    MEASUREMENT_STORE_NAME,
    ACCOUNT_IDENTITY_STORE_NAME
  ];
  return scopedTransaction(
    'readwrite',
    [
      STORE_NAME,
      SUMMARY_STORE_NAME,
      BACKUP_STORE_NAME,
      CHECKPOINT_STORE_NAME,
      ALIAS_STORE_NAME,
      ACCOUNT_IDENTITY_STORE_NAME,
      ...singleStores
    ],
    async (store) => {
      const sourceId = source.projectId;
      const resolved = await resolvedProjectId(
        store(ALIAS_STORE_NAME),
        sourceId
      );
      if (resolved !== sourceId) {
        if (resolved !== targetProjectId)
          throw new LocalProjectIdentityChangedError(resolved);
        const existing = (await settled(
          store(STORE_NAME).get(targetProjectId)
        )) as ProjectDocument | undefined;
        if (!existing) throw new Error('Moved local project is unavailable.');
        return existing;
      }
      const target = (await settled(store(STORE_NAME).get(targetProjectId))) as
        ProjectDocument | undefined;
      const preserveSource =
        options.retainSource === true ||
        Boolean(
          await settled(store(ACCOUNT_IDENTITY_STORE_NAME).count(sourceId))
        );
      const stored = (await settled(store(STORE_NAME).get(sourceId))) as
        ProjectDocument | undefined;
      // The live manager may be ahead of its debounced autosave; an already
      // durable later edit must win over an older network snapshot as well.
      const latest =
        stored && stored.version > source.version ? stored : source;
      const reidentified = reidentifyProjectDocument(
        latest,
        toProjectId(targetProjectId)
      );
      const moved = {
        ...reidentified,
        ownerUserId: source.ownerUserId,
        ...(reidentified.editHistory && source.editHistory
          ? {
              editHistory: {
                ...reidentified.editHistory,
                actorUserId: source.editHistory.actorUserId
              }
            }
          : {})
      };
      if (
        target &&
        !projectMatchesInterruptedAdoption(moved, target) &&
        !projectPreservesLocalWork(moved, target)
      ) {
        throw new LocalProjectIdentityConflictError(moved, target);
      }
      const durable = target ? withMatchingLocalDerived(target, moved) : moved;
      store(STORE_NAME).put(durable);
      if (preserveSource) {
        const retained = {
          ...latest,
          ownerUserId: stored?.ownerUserId ?? latest.ownerUserId,
          ...(latest.editHistory
            ? {
                editHistory: {
                  ...latest.editHistory,
                  actorUserId:
                    stored?.editHistory?.actorUserId ??
                    latest.editHistory.actorUserId
                }
              }
            : {})
        };
        store(STORE_NAME).put(retained);
        store(SUMMARY_STORE_NAME).put(summarizeProjectDocument(retained));
      } else store(STORE_NAME).delete(sourceId);
      store(SUMMARY_STORE_NAME).put(summarizeProjectDocument(durable));
      if (!preserveSource) store(SUMMARY_STORE_NAME).delete(sourceId);
      for (const name of singleStores) {
        const record = (await settled(store(name).get(sourceId))) as
          { projectId: string } | undefined;
        const existing: unknown = target
          ? await settled(store(name).get(targetProjectId))
          : undefined;
        if (record && !(preserveSource && name === SYNC_STORE_NAME)) {
          let companion: unknown = { ...record, projectId: targetProjectId };
          if (existing && name === MEASUREMENT_STORE_NAME) {
            const sourceMeasurements = record as StoredMeasurementRecord;
            const targetMeasurements = existing as StoredMeasurementRecord;
            if (
              sourceMeasurements.version !== 1 ||
              targetMeasurements.version !== 1
            )
              throw new Error(
                'Reload to update before transferring stored measurements.'
              );
            const sourceIsNewer =
              sourceMeasurements.updatedAt > targetMeasurements.updatedAt;
            const measurements = new Map<
              string,
              StoredMeasurementRecord['measurements'][number]
            >();
            for (const entry of (sourceIsNewer
              ? targetMeasurements
              : sourceMeasurements
            ).measurements)
              measurements.set(entry.id, entry);
            for (const entry of (sourceIsNewer
              ? sourceMeasurements
              : targetMeasurements
            ).measurements)
              measurements.set(entry.id, entry);
            companion = {
              ...(sourceIsNewer ? sourceMeasurements : targetMeasurements),
              projectId: targetProjectId,
              measurements: [...measurements.values()]
            };
          } else if (existing && name !== META_STORE_NAME) companion = existing;
          store(name).put(companion);
        }
        if (!preserveSource) store(name).delete(sourceId);
      }
      const files = (await settled(store(BACKUP_STORE_NAME).get(sourceId))) as
        BackupFile[] | undefined;
      if (files) {
        const existing = (await settled(
          store(BACKUP_STORE_NAME).get(targetProjectId)
        )) as BackupFile[] | undefined;
        const combined = new Map<string, BackupFile>();
        for (const file of [...files, ...(existing ?? [])])
          combined.set(`${file.artifact.artifactId}:${file.sha256}`, {
            ...file,
            artifact: {
              ...file.artifact,
              projectId: toProjectId(targetProjectId)
            }
          });
        store(BACKUP_STORE_NAME).put([...combined.values()], targetProjectId);
      }
      if (!preserveSource) store(BACKUP_STORE_NAME).delete(sourceId);
      const checkpoints = (await settled(
        store(CHECKPOINT_STORE_NAME).getAll(checkpointKeyRange(sourceId))
      )) as ProjectCheckpointDocumentRecord[];
      for (const checkpoint of checkpoints) {
        if (
          await settled(
            store(CHECKPOINT_STORE_NAME).count([
              targetProjectId,
              checkpoint.checkpointId
            ])
          )
        )
          continue;
        store(CHECKPOINT_STORE_NAME).put({
          ...checkpoint,
          projectId: targetProjectId,
          document: reidentifyProjectDocument(
            checkpoint.document,
            toProjectId(targetProjectId)
          )
        });
      }
      if (!preserveSource) {
        store(CHECKPOINT_STORE_NAME).delete(checkpointKeyRange(sourceId));
        store(ALIAS_STORE_NAME).put({ projectId: sourceId, targetProjectId });
      }
      store(ACCOUNT_IDENTITY_STORE_NAME).put({ projectId: targetProjectId });
      return durable;
    }
  );
}

type ProjectListUpdate<T extends { projectId: string }> = (
  update: (current: T[]) => T[]
) => void;

/** The App state a transfer re-points from the device ID to the account ID. */
export interface AdoptedProjectIdentityState {
  localUserId: UserId;
  /** Read after every await: the open project can change while this runs. */
  manager: () => CommandManager | null;
  setDoc: (document: ProjectDocument) => void;
  remoteVersions: Map<string, number>;
  setProjects: ProjectListUpdate<ProjectSummary>;
  setArtifacts: ProjectListUpdate<ArtifactRecord>;
}

/** Moves this device's existing work to the account's acknowledged identity. */
async function transferAdoptedProjectIdentity(
  local: ProjectDocument,
  remote: ProjectDocument,
  app: AdoptedProjectIdentityState
): Promise<ProjectDocument> {
  if (local.projectId === remote.projectId) return local;
  const sourceId = local.projectId;
  const current = app.manager()?.document;
  const transferred = await rekeyLocalProject(
    withAccountOwner(
      current?.projectId === sourceId ? current : local,
      remote.ownerUserId
    ),
    remote.projectId,
    {
      retainSource: retainPreviousAccountProject(
        local,
        app.localUserId,
        remote.ownerUserId
      )
    }
  );
  // The transaction's awaits may overlap another edit in this tab. Transfer
  // the live manager after commit so those edits retain their exact history.
  const latestManager = app.manager();
  if (latestManager?.document.projectId === sourceId) {
    const moved = latestTransferredProjectDocument(
      transferred,
      latestManager.document
    );
    latestManager.document = moved;
    app.setDoc(moved);
    await saveLocalProject(moved);
  }
  const retainedSource =
    (await loadLocalProject(sourceId))?.projectId === sourceId;
  rekeyWorkspaceProject(sourceId, remote.projectId, undefined, retainedSource);
  app.remoteVersions.delete(sourceId);
  app.setProjects((projects) =>
    projects.map((project) =>
      project.projectId === sourceId
        ? { ...project, projectId: remote.projectId }
        : project
    )
  );
  app.setArtifacts((artifacts) =>
    artifacts.map((artifact) =>
      artifact.projectId === sourceId
        ? { ...artifact, projectId: remote.projectId }
        : artifact
    )
  );
  return withAccountIdentity(local, remote.projectId, remote.ownerUserId);
}

export type AdoptLocalProjectResult =
  | { state: 'adopted' | 'already-adopted' | 'missing'; sourceWarning?: string }
  | { state: 'conflict'; conflict: ProjectConflict };

/** The App state and account-save step an adoption needs beyond the transfer. */
export interface LocalProjectAdoptionState extends AdoptedProjectIdentityState {
  setCloudProjectIds: (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>
  ) => void;
  cloudProjectIds: ReadonlySet<string>;
  setStatus: (text: string) => void;
  summarize: (document: ProjectDocument) => ProjectSummary;
  acceptAccountDocument: (
    remote: ProjectDocument,
    local: ProjectDocument,
    summary?: ProjectSummary
  ) => Promise<ProjectDocument>;
}

/** Uploads the adopted project's source files, then stores the account copy. */
async function finishAccountSourceSave(
  app: LocalProjectAdoptionState,
  document: ProjectDocument,
  local: ProjectDocument,
  summary: ProjectSummary = app.summarize(document)
): Promise<string | undefined> {
  const projectId = document.projectId;
  // Account creation establishes the upload destination. Source bytes must
  // follow before the new account copy can be rebuilt on another device.
  app.setStatus('Saving project source files to your account…');
  const prepared = await archiveAccountImportSources(document, {
    loadSourceBytes: loadSourceBlob,
    archive: (input) =>
      archiveArtifactBody(api, document.projectId, input, (artifact) => {
        if (app.manager()?.document.projectId === projectId)
          app.setArtifacts((current) => [
            artifact,
            ...current.filter((item) => item.artifactId !== artifact.artifactId)
          ]);
      })
  });
  let saved = document;
  let localForAcceptance = local;
  if (prepared.document !== document) {
    // Keep completed upload metadata if the account write fails. Never
    // replace edits made while the source transfers were in flight.
    const current = app.manager();
    const live = current?.document;
    const durable =
      live?.projectId === projectId ? live : await loadLocalProject(projectId);
    if (!durable || durable.version === local.version) {
      await saveLocalProject(prepared.document);
      if (
        app.manager() === current &&
        !app.cloudProjectIds.has(projectId) &&
        current?.document.projectId === projectId &&
        current.document.version === local.version
      ) {
        current.document = prepared.document;
        localForAcceptance = prepared.document;
        app.setDoc(prepared.document);
      }
    }
    const stored = await api.saveProjectDocument({
      projectId: prepared.document.projectId,
      expectedVersion: document.version,
      document: withoutDerivedProjection(prepared.document)
    });
    saved = { ...prepared.document, version: stored.version };
  }
  await app.acceptAccountDocument(saved, localForAcceptance, {
    ...summary,
    documentVersion: saved.version
  });
  return sourceUploadMessage(prepared.result) ?? undefined;
}

/** Saves one device project and reconciles retry responses against its account ID. */
export async function adoptLocalProject(
  projectId: string,
  app: LocalProjectAdoptionState
): Promise<AdoptLocalProjectResult> {
  const local = await loadLocalProject(projectId);
  if (!local) {
    return { state: 'missing' };
  }
  try {
    const response = await api.adoptProject(local);
    const accountLocal = await transferAdoptedProjectIdentity(
      local,
      response.document,
      app
    );
    return {
      state: 'adopted',
      sourceWarning: await finishAccountSourceSave(
        app,
        response.document,
        accountLocal,
        response.project
      )
    };
  } catch (error) {
    if (error instanceof LocalProjectIdentityConflictError) {
      return {
        state: 'conflict',
        conflict: conflictFromDocuments(error.local, error.account, 'account')
      };
    }
    if (error instanceof ApiError && error.code === 'ALREADY_ADOPTED') {
      const accountProjectId =
        typeof error.details?.projectId === 'string'
          ? error.details.projectId
          : projectId;
      const remote = await api.loadProject(accountProjectId);
      let accountLocal: ProjectDocument;
      try {
        accountLocal = await transferAdoptedProjectIdentity(local, remote, app);
      } catch (transferError) {
        if (transferError instanceof LocalProjectIdentityConflictError)
          return {
            state: 'conflict',
            conflict: conflictFromDocuments(
              transferError.local,
              transferError.account,
              'account'
            )
          };
        throw transferError;
      }
      const lastSyncedVersion = await loadLastSyncedVersion(accountProjectId);
      app.remoteVersions.set(accountProjectId, remote.version);
      app.setCloudProjectIds((current) =>
        new Set(current).add(accountProjectId)
      );
      const outcome = chooseProjectDocument(
        accountLocal,
        remote,
        lastSyncedVersion
      );
      if (outcome.choice === 'diverged') {
        return {
          state: 'conflict',
          conflict: conflictFromDocuments(
            outcome.local,
            outcome.remote,
            'account'
          )
        };
      }
      if (outcome.choice === 'remote') {
        return {
          state: 'already-adopted',
          sourceWarning: await finishAccountSourceSave(
            app,
            outcome.document,
            accountLocal
          )
        };
      }
      if (outcome.choice === 'local') {
        // The baseline proves only this device moved. Complete the interrupted
        // sync with a fenced document write rather than asking the user to
        // resolve a conflict that does not exist.
        const candidate = {
          ...outcome.document,
          ownerUserId: remote.ownerUserId
        };
        const saved = await api.saveProjectDocument({
          projectId: candidate.projectId,
          expectedVersion: remote.version,
          document: withoutDerivedProjection(candidate)
        });
        const sourceWarning = await finishAccountSourceSave(
          app,
          {
            ...candidate,
            version: saved.version,
            derived: {
              ...candidate.derived,
              updatedAt: saved.updatedAt
            }
          },
          accountLocal
        );
        return { state: 'already-adopted', sourceWarning };
      }
      return { state: 'missing' };
    }
    throw error;
  }
}
