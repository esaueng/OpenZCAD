import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import type {
  AppSettings,
  AuthSession,
  ProjectDocument
} from '@openzcad/shared';
import { api, isEncryptedProject } from './api';
import { parseStoredMeasurements } from './measurementStore';
import type { StoredMeasurementRecord } from './measurementRecord';
import { loadLocalProject, visitLocalProjectData } from './localProjectStore';
import {
  createProjectBackup,
  downloadBackupFile
} from './projectBackupTransfer';
import { diagnosticReport } from './analytics';
import type { DataExportSummary, SkippedDataProject } from './dataExportTypes';
export type { DataExportSummary } from './dataExportTypes';

// Bound the browser's archive buffer; the existing per-project backup bound
// remains 256 MiB. Every omitted project is reported in the UI and ZIP.
export const MAX_DATA_EXPORT_BYTES = 512 * 1024 * 1024;

const PREFERENCE_KEYS = new Set([
  'openzcad-app-settings:v1',
  'openzcad-cloud-functions-enabled:v1',
  'openzcad-settings-view:v1',
  'openzcad-panel-state:v1',
  'openzcad-panel-layout:v1',
  'openzcad-saved-views:v1',
  'openzcad-objects-collapsed:v1',
  'openzcad-mass-density:v1',
  'openzcad-wheel-device:v1',
  'openzcad-recent-commands:v1',
  'openzcad-workspace-session:v1',
  'openzcad-workspace-device:v1',
  'openzcad-assistant-history:v1',
  'openzcad.library.layout.v1',
  'openzcad.glimpse.consent.v1'
]);

export interface DataExportOptions {
  settings: AppSettings;
  session: AuthSession | null;
  cloudFunctionsEnabled: boolean;
  /** Rebuild sources always travel; redundant original imports are opt-in. */
  includeOriginalImports?: boolean;
  /** Keep the full device snapshot by default; users may choose a smaller ZIP. */
  includeDeviceSnapshot?: boolean;
  onProgress(message: string): void;
  /** Prevent a late result from downloading into a different account session. */
  isCurrent(): boolean;
}

class ExportCapacityError extends Error {
  constructor() {
    super(
      'Would exceed the space or browser-memory budget for the 512 MB download. Download this project separately.'
    );
  }
}

function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    Array.from(text.slice(0, 500), (character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    }).join('') || 'Could not read this data.'
  );
}

type PendingEntry = { path: string; data: Uint8Array | Blob };

async function buildDataExport(options: DataExportOptions): Promise<{
  archive: Blob;
  summary: DataExportSummary;
}> {
  const parts: BlobPart[] = [];
  // ZIP end record; each stored entry also needs local/central headers and
  // a data descriptor (30 + 46 + 16 bytes, plus its name twice).
  let bytes = 22;
  let archiveError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) archiveError = error;
    else parts.push(new Uint8Array(chunk));
  });
  const check = () => {
    if (!options.isCurrent())
      throw new Error('Your account changed. Start the download again.');
    if (archiveError) throw archiveError;
  };
  let reportReserve = 0;
  const checkSize = (length: number) => {
    if (bytes + length > MAX_DATA_EXPORT_BYTES - reportReserve)
      throw new ExportCapacityError();
  };
  // Stage a complete project before touching the ZIP or its byte budget.
  // Blob sizes are checked before any of their bytes are read.
  const batch = (budgetStaging = true) => {
    const pending: PendingEntry[] = [];
    let length = 0;
    const add = (path: string, data: Uint8Array | Blob) => {
      check();
      const size =
        (data instanceof Blob ? data.size : data.byteLength) +
        92 +
        strToU8(path).byteLength * 2;
      // Budget staged inputs and ZIP output beside the existing archive.
      checkSize((length + size) * (budgetStaging ? 2 : 1));
      length += size;
      pending.push({ path, data });
    };
    return {
      add,
      json: (path: string, value: unknown) =>
        add(path, strToU8(JSON.stringify(value))),
      backupBudget() {
        check();
        // Leave conservative headroom for the next backup's source/base64,
        // JSON serialization/validation, UTF-8 encoding and ZIP output. The
        // builder enforces this budget before reading its bulk source bytes.
        return Math.max(
          0,
          Math.floor(
            (MAX_DATA_EXPORT_BYTES - reportReserve - bytes - length * 2) / 6
          )
        );
      },
      async commit() {
        checkSize(length * (budgetStaging ? 2 : 1));
        const ready: ({ path: string; data: Uint8Array } | undefined)[] = [];
        for (const entry of pending) {
          check();
          ready.push({
            path: entry.path,
            data:
              entry.data instanceof Blob
                ? new Uint8Array(await entry.data.arrayBuffer())
                : entry.data
          });
        }
        check();
        pending.length = 0;
        for (let index = 0; index < ready.length; index++) {
          const entry = ready[index]!;
          ready[index] = undefined;
          const file = new ZipPassThrough(entry.path);
          zip.add(file);
          file.push(entry.data, true);
          check();
        }
        bytes += length;
      }
    };
  };
  const cloud = options.cloudFunctionsEnabled && options.session !== null;
  const manifest: {
    format: string;
    version: number;
    exportedAt: string;
    cloudIncluded: boolean;
    originalImportFilesInBackups: boolean;
    deviceSnapshotRequested: boolean;
    localProjects: { projectId: string; name: string; path: string }[];
    cloudProjects: { projectId: string; name: string; path: string }[];
    skippedProjects: SkippedDataProject[];
    omittedSections: DataExportSummary['omittedSections'];
  } = {
    format: 'openzcad-data',
    version: 1,
    exportedAt: new Date().toISOString(),
    cloudIncluded: cloud,
    originalImportFilesInBackups: options.includeOriginalImports === true,
    deviceSnapshotRequested: options.includeDeviceSnapshot !== false,
    localProjects: [],
    cloudProjects: [],
    skippedProjects: [],
    omittedSections: []
  };
  try {
    options.onProgress('Reading data on this device…');
    const preferences: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (PREFERENCE_KEYS.has(key) ||
          key.startsWith('openzcad-unresolved-project-conflict:') ||
          key.startsWith('openzcad-recovery-copies:'))
      ) {
        preferences[key] = localStorage.getItem(key);
      }
    }
    const localProjects: { projectId: string; name: string }[] = [];
    try {
      await visitLocalProjectData(
        (_store, key, value) => {
          check();
          if (typeof key !== 'string')
            throw new Error('A local project has an invalid ID.');
          const record = value as { name?: unknown } | null;
          localProjects.push({
            projectId: key,
            name: typeof record?.name === 'string' ? record.name : key
          });
        },
        ['projects']
      );
    } catch (error) {
      check();
      manifest.omittedSections.push({
        name: 'Local project discovery',
        reason: failureReason(error)
      });
    }
    let account: Record<string, unknown> = {};
    let projects: Awaited<ReturnType<typeof api.listProjects>>['projects'] = [];
    if (cloud) {
      options.onProgress('Reading cloud account data…');
      account = await api.exportAccountData();
      check();
      const profile = account.profile as { userId?: string } | undefined;
      if (profile?.userId !== options.session?.userId)
        throw new Error('Your account changed. Start the download again.');
      ({ projects } = await api.listProjects());
      check();
    }
    // Reserve enough space to name EVERY missing copy, even after the payload
    // fills up. Reasons are bounded/plain text; catalog sizing covers names/IDs.
    const catalog = [
      ...localProjects,
      ...projects.map((project) => ({
        projectId: project.projectId,
        name: project.name
      }))
    ];
    reportReserve =
      64 * 1024 +
      strToU8(JSON.stringify(catalog)).byteLength * 4 +
      catalog.length * 4096;
    const metadata = batch();
    metadata.json('device/settings.json', {
      settings: options.settings,
      preferences
    });
    metadata.json('device/diagnostics.json', diagnosticReport());
    if (cloud) {
      metadata.json('cloud/account.json', account);
      metadata.json('cloud/projects.json', projects);
    }
    await metadata.commit();
    for (const [index, project] of localProjects.entries()) {
      const { projectId } = project;
      options.onProgress(
        `Preparing local project ${index + 1} of ${localProjects.length}…`
      );
      try {
        const document = await loadLocalProject(projectId);
        if (!document) throw new Error('Project is no longer available.');
        const path = `projects/local/${index + 1}.openzcad`;
        const pending = batch();
        pending.add(
          path,
          strToU8(
            await createProjectBackup(document, false, undefined, {
              localOnly: true,
              includeOriginalImports: options.includeOriginalImports,
              maxBytes: pending.backupBudget()
            })
          )
        );
        await pending.commit();
        manifest.localProjects.push({ projectId, name: project.name, path });
      } catch (error) {
        check();
        manifest.skippedProjects.push({
          ...project,
          scope: 'local',
          reason: failureReason(error)
        });
      }
    }
    if (cloud) {
      for (const [index, project] of projects.entries()) {
        check();
        options.onProgress(
          `Preparing cloud project ${index + 1} of ${projects.length}…`
        );
        const folder = `projects/cloud/${index + 1}`;
        try {
          const pending = batch();
          const document = await api.loadProject(project.projectId);
          if (!document)
            throw new Error('Project is no longer available. Try again.');
          check();
          // Catalogs must not predate this document: a concurrent save can
          // add a retained checkpoint or file that the backup must include.
          // Independent catalogs and encrypted sidecars can share this wait.
          // Keep complete project staging sequential so its memory budget and
          // all-or-nothing ZIP commit retain the same bounds.
          const [revisions, catalog, sidecars] = await Promise.all([
            api.listRevisions(project.projectId),
            api.listArtifacts(project.projectId),
            isEncryptedProject(project.projectId)
              ? import('./e2ee/encryptedProjects').then(async (encrypted) => {
                  const [measurement, sessions] = await Promise.all([
                    encrypted.encryptedMeasurements().then((client) =>
                      client.loadProjectMeasurements(project.projectId)
                    ),
                    encrypted.encryptedViewStates().then((client) =>
                      client.load(project.projectId)
                    )
                  ]);
                  return { measurements: measurement.record, sessions };
                })
              : null
          ]);
          const retainedRevisionIds = new Set(
            revisions.revisions.map((revision) => revision.revisionId as string)
          );
          check();
          let measurements: StoredMeasurementRecord | null = null;
          if (sidecars) {
            measurements = sidecars.measurements;
            pending.json(
              `${folder}/workspace-sessions.json`,
              sidecars.sessions
            );
          } else {
            const records = account.records as
              Record<string, unknown[]> | undefined;
            const row = records?.project_measurements?.find(
              (entry) =>
                (entry as { project_id?: string }).project_id ===
                project.projectId
            ) as { payload_json?: string } | undefined;
            if (row?.payload_json)
              measurements = parseStoredMeasurements(
                JSON.parse(row.payload_json)
              );
          }
          const stageBackup = async (
            saved: ProjectDocument,
            path: string,
            coverHistory = false
          ) => {
            const covered = new Set<string>();
            const backupText = await createProjectBackup(
              saved,
              true,
              measurements,
              {
                includeEncryptedFiles: true,
                includeOriginalImports: options.includeOriginalImports,
                artifacts: catalog.artifacts,
                retainedRevisionIds,
                onSaveState: coverHistory
                  ? (revisionId) => covered.add(revisionId)
                  : undefined,
                maxBytes: pending.backupBudget()
              }
            );
            pending.add(path, strToU8(backupText));
            return covered;
          };
          // A retained revision need not still have a checkpoint in today's
          // document. Export those snapshots too, with their own source bytes.
          const covered = await stageBackup(
            document,
            `${folder}/project.openzcad`,
            true
          );
          pending.json(`${folder}/revisions.json`, revisions);
          for (const [
            revisionIndex,
            revision
          ] of revisions.revisions.entries()) {
            if (covered.has(revision.revisionId)) continue;
            const saved = await api.loadRevision(
              project.projectId,
              revision.revisionId
            );
            if (!saved)
              throw new Error(
                'Saved history changed during the download. Try again.'
              );
            await stageBackup(
              saved,
              `${folder}/revisions/${revisionIndex + 1}.openzcad`
            );
          }
          await pending.commit();
          manifest.cloudProjects.push({
            name: project.name,
            projectId: project.projectId,
            path: `${folder}/project.openzcad`
          });
        } catch (error) {
          check();
          manifest.skippedProjects.push({
            projectId: project.projectId,
            name: project.name,
            scope: 'cloud',
            reason: failureReason(error)
          });
        }
      }
    }
    // Prefer complete portable project backups over this redundant raw snapshot.
    // If the snapshot cannot fit/read, discard the entire section and report it.
    if (options.includeDeviceSnapshot !== false) {
      options.onProgress('Preparing extra device recovery data…');
      try {
        const snapshot = batch();
        let recordNumber = 0;
        let binaryNumber = 0;
        await visitLocalProjectData((store, key, value) => {
          check();
          const text = JSON.stringify(
            { key, value },
            (_key, child: unknown) => {
              if (child instanceof Blob) {
                const path = `device/binary/${++binaryNumber}`;
                snapshot.add(path, child);
                return {
                  format: 'openzcad-blob',
                  path,
                  type: child.type,
                  size: child.size
                };
              }
              if (child instanceof ArrayBuffer || ArrayBuffer.isView(child)) {
                const data =
                  child instanceof ArrayBuffer
                    ? new Uint8Array(child)
                    : new Uint8Array(
                        child.buffer,
                        child.byteOffset,
                        child.byteLength
                      );
                const path = `device/binary/${++binaryNumber}`;
                snapshot.add(path, data);
                return { format: 'openzcad-bytes', path };
              }
              return child;
            }
          );
          snapshot.add(
            `device/database/${store}/${++recordNumber}.json`,
            strToU8(text)
          );
        });
        await snapshot.commit();
      } catch (error) {
        check();
        manifest.omittedSections.push({
          name: 'Raw device database snapshot',
          reason:
            error instanceof ExportCapacityError
              ? 'The raw snapshot would exceed the space or browser-memory budget for the 512 MB download. Complete project backups take priority.'
              : failureReason(error)
        });
      }
    }
    const summary: DataExportSummary = {
      includedProjects:
        manifest.localProjects.length + manifest.cloudProjects.length,
      skippedProjects: manifest.skippedProjects,
      omittedSections: manifest.omittedSections
    };
    reportReserve = 0;
    const reports = batch(false);
    reports.json('manifest.json', manifest);
    reports.add(
      'NOT-INCLUDED.txt',
      strToU8(
        [
          'OpenZCAD — backups not included',
          manifest.skippedProjects.length
            ? 'Open these projects from Projects, then choose File → Export project to download them manually. A complete portable backup was not included for each copy below.'
            : 'All discovered project backups were included.',
          ...manifest.skippedProjects.map(
            (project) =>
              `${project.name}\n${project.scope === 'local' ? 'Local device copy' : 'Cloud copy'} · ${project.projectId}\nReason: ${project.reason}`
          ),
          ...manifest.omittedSections.map(
            (section) => `${section.name}\nReason: ${section.reason}`
          ),
          'The raw device snapshot or account metadata may still contain some records for a skipped project; check manifest.json for complete backup paths.'
        ].join('\n\n')
      )
    );
    reports.add(
      'README.txt',
      strToU8(
        [
          'OpenZCAD data download',
          'Extract this ZIP. Import any .openzcad file from the projects screen to open an independent project copy.',
          'manifest.json maps project IDs to backups. Local and cloud copies are separate; archived and Trash projects are included while still retained.',
          'When included, device/database preserves project database records. Binary values refer to files under device/binary. This optional raw snapshot is for data access; automatic whole-account restore is not supported. Check NOT-INCLUDED.txt for any omissions.',
          'cloud/account.json contains profile, stored settings, collaboration, session metadata, consent and saved workspace/measurement records. projects/cloud contains readable backups and retained history available to this account, including shared projects.',
          'Only data available on this device and in the signed-in account at download time can be included. Other devices’ unsynced data and permanently deleted/expired history are unavailable. Changes made during export may require another download.',
          options.includeOriginalImports
            ? 'Project backups include requested original interchange files when available, except STEP bytes already retained as canonical rebuild sources.'
            : 'Project backups omit redundant original interchange files. Every included project retains the source data required to reopen and rebuild it.',
          options.includeDeviceSnapshot === false
            ? 'Extra device recovery data was not requested; the raw device snapshot is absent.'
            : 'Extra device recovery data was requested; check NOT-INCLUDED.txt for any unavailable section.',
          'Encrypted project backups are decrypted on this device. Protect this unencrypted archive.',
          'Passwords, API credentials, session tokens, invitation/share secrets and encryption private/recovery keys are excluded. Encryption key stores, transient collaboration transport and server operational/security logs are not account backups.',
          cloud
            ? 'Cloud account data is included.'
            : 'Device data only. Sign in and enable cloud features to include account data.',
          'Limits: 512 MB per archive and the existing 256 MB per individual project backup. Bulk downloads also reserve memory for staged history and backup preparation, so a project may need an individual export even if its files would fit the archive. Unavailable or oversized projects are skipped; NOT-INCLUDED.txt and manifest.json list every skipped copy and its reason. Each included project backup is complete. The optional raw device snapshot is included only if it fits. Account changes and ZIP failures still cancel the download.'
        ].join('\n\n')
      )
    );
    await reports.commit();
    check();
    zip.end();
    check();
    return { archive: new Blob(parts, { type: 'application/zip' }), summary };
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

export async function createDataExport(
  options: DataExportOptions
): Promise<Blob> {
  return (await buildDataExport(options)).archive;
}

export async function downloadAllData(
  options: DataExportOptions
): Promise<DataExportSummary> {
  const { archive, summary } = await buildDataExport(options);
  if (!options.isCurrent())
    throw new Error('Your account changed. Start the download again.');
  downloadBackupFile(
    `openzcad-data-${new Date().toISOString().slice(0, 10)}.zip`,
    archive
  );
  return summary;
}
