import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import type { AppSettings, AuthSession } from '@openzcad/shared';
import { api, isEncryptedProject } from './api';
import { parseStoredMeasurements } from './measurementStore';
import type { StoredMeasurementRecord } from './measurementRecord';
import { loadLocalProject, visitLocalProjectData } from './localProjectStore';
import {
  createProjectBackup,
  downloadBackupFile
} from './projectBackupTransfer';
import { diagnosticReport } from './analytics';

// Bound the browser's archive buffer; the existing per-project backup bound
// remains 256 MiB. Never present a truncated archive as a successful export.
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
  onProgress(message: string): void;
  /** Prevent a late result from downloading into a different account session. */
  isCurrent(): boolean;
}

export async function createDataExport(
  options: DataExportOptions
): Promise<Blob> {
  const parts: BlobPart[] = [];
  let bytes = 0;
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
  const add = (path: string, data: Uint8Array) => {
    check();
    bytes += data.byteLength;
    if (bytes > MAX_DATA_EXPORT_BYTES) {
      throw new Error(
        'This download exceeds the 512 MB archive limit. Download large projects individually from the project menu.'
      );
    }
    const file = new ZipPassThrough(path);
    zip.add(file);
    file.push(data, true);
  };
  const json = (path: string, value: unknown) =>
    add(path, strToU8(JSON.stringify(value)));
  const cloud = options.cloudFunctionsEnabled && options.session !== null;
  const manifest: {
    format: string;
    version: number;
    exportedAt: string;
    cloudIncluded: boolean;
    localProjects: { projectId: string; path: string }[];
    cloudProjects: { projectId: string; path: string }[];
  } = {
    format: 'openzcad-data',
    version: 1,
    exportedAt: new Date().toISOString(),
    cloudIncluded: cloud,
    localProjects: [],
    cloudProjects: []
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
    json('device/settings.json', { settings: options.settings, preferences });
    json('device/diagnostics.json', diagnosticReport());
    const blobs: { path: string; blob: Blob }[] = [];
    const projectIds: string[] = [];
    let recordNumber = 0;
    let binaryNumber = 0;
    // Preserve every record, even orphaned sources, recovery copies and old
    // records the current project reader cannot interpret. Blob bytes travel
    // as files, with explicit references in the JSON, never as empty objects.
    await visitLocalProjectData((store, key, value) => {
      check();
      if (store === 'projects') {
        if (typeof key !== 'string')
          throw new Error('A local project has an invalid ID.');
        projectIds.push(key);
      }
      const text = JSON.stringify({ key, value }, (_key, child: unknown) => {
        if (child instanceof Blob) {
          const path = `device/binary/${++binaryNumber}`;
          blobs.push({ path, blob: child });
          bytes += child.size;
          if (bytes > MAX_DATA_EXPORT_BYTES)
            throw new Error(
              'This download exceeds the 512 MB archive limit. Download large projects individually from the project menu.'
            );
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
          add(path, data);
          return { format: 'openzcad-bytes', path };
        }
        return child;
      });
      add(`device/database/${store}/${++recordNumber}.json`, strToU8(text));
    });
    for (const entry of blobs) {
      // Size was reserved during the snapshot, before reading any blob bytes.
      bytes -= entry.blob.size;
      add(entry.path, new Uint8Array(await entry.blob.arrayBuffer()));
    }
    for (const [index, projectId] of projectIds.entries()) {
      options.onProgress(
        `Preparing local project ${index + 1} of ${projectIds.length}…`
      );
      const document = await loadLocalProject(projectId);
      if (!document)
        throw new Error(
          'A local project changed during the download. Try again.'
        );
      const path = `projects/local/${index + 1}.openzcad`;
      try {
        add(
          path,
          strToU8(
            await createProjectBackup(document, false, undefined, {
              localOnly: true
            })
          )
        );
      } catch (error) {
        throw new Error(
          `Could not back up local project “${document.name}”: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      manifest.localProjects.push({ projectId, path });
    }
    if (cloud) {
      options.onProgress('Reading cloud account data…');
      const account = await api.exportAccountData();
      check();
      const profile = account.profile as { userId?: string } | undefined;
      if (profile?.userId !== options.session?.userId)
        throw new Error('Your account changed. Start the download again.');
      json('cloud/account.json', account);
      const { projects } = await api.listProjects();
      json('cloud/projects.json', projects);
      for (const [index, project] of projects.entries()) {
        check();
        options.onProgress(
          `Preparing cloud project ${index + 1} of ${projects.length}…`
        );
        const folder = `projects/cloud/${index + 1}`;
        try {
          const document = await api.loadProject(project.projectId);
          if (!document)
            throw new Error('Project is no longer available. Try again.');
          let measurements: StoredMeasurementRecord | null = null;
          if (isEncryptedProject(project.projectId)) {
            const encrypted = await import('./e2ee/encryptedProjects');
            measurements = (
              await (
                await encrypted.encryptedMeasurements()
              ).loadProjectMeasurements(project.projectId)
            ).record;
            json(
              `${folder}/workspace-sessions.json`,
              await (
                await encrypted.encryptedViewStates()
              ).load(project.projectId)
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
          const backupText = await createProjectBackup(
            document,
            true,
            measurements,
            { includeEncryptedFiles: true }
          );
          add(`${folder}/project.openzcad`, strToU8(backupText));
          // A retained revision need not still have a checkpoint in today's
          // document. Export those snapshots too, with their own source bytes.
          const backup = JSON.parse(backupText) as {
            saveStates?: {
              document: { revisions: { revisionId: string }[] };
            }[];
          };
          const covered = new Set(
            backup.saveStates?.map(
              (state) => state.document.revisions.at(-1)?.revisionId
            )
          );
          const revisions = await api.listRevisions(project.projectId);
          json(`${folder}/revisions.json`, revisions);
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
            add(
              `${folder}/revisions/${revisionIndex + 1}.openzcad`,
              strToU8(
                await createProjectBackup(saved, true, measurements, {
                  includeEncryptedFiles: true
                })
              )
            );
          }
          manifest.cloudProjects.push({
            projectId: project.projectId,
            path: `${folder}/project.openzcad`
          });
        } catch (error) {
          throw new Error(
            `Could not back up cloud project “${project.name}”. Unlock encrypted projects in Settings → Encryption if needed, then retry. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
    }
    json('manifest.json', manifest);
    add(
      'README.txt',
      strToU8(
        [
          'OpenZCAD data download',
          'Extract this ZIP. Import any .openzcad file from the projects screen to open an independent project copy.',
          'manifest.json maps project IDs to backups. Local and cloud copies are separate; archived and Trash projects are included while still retained.',
          'device/database preserves all project database records. Binary values refer to files under device/binary. This raw snapshot is for data access; automatic whole-account restore is not supported.',
          'cloud/account.json contains profile, stored settings, collaboration, session metadata, consent and saved workspace/measurement records. projects/cloud contains readable backups and retained history available to this account, including shared projects.',
          'Only data available on this device and in the signed-in account at download time can be included. Other devices’ unsynced data and permanently deleted/expired history are unavailable. Changes made during export may require another download.',
          'Encrypted project backups are decrypted on this device. Protect this unencrypted archive.',
          'Passwords, API credentials, session tokens, invitation/share secrets and encryption private/recovery keys are excluded. Encryption key stores, transient collaboration transport and server operational/security logs are not account backups.',
          cloud
            ? 'Cloud account data is included.'
            : 'Device data only. Sign in and enable cloud features to include account data.',
          'Limits: 512 MB per archive and the existing 256 MB per project backup. A failed export does not download a partial archive.'
        ].join('\n\n')
      )
    );
    check();
    zip.end();
    check();
    return new Blob(parts, { type: 'application/zip' });
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

export async function downloadAllData(
  options: DataExportOptions
): Promise<void> {
  const archive = await createDataExport(options);
  if (!options.isCurrent())
    throw new Error('Your account changed. Start the download again.');
  downloadBackupFile(
    `openzcad-data-${new Date().toISOString().slice(0, 10)}.zip`,
    archive
  );
}
