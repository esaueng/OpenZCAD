import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
import { api } from './api';
import * as localStore from './localProjectStore';
import * as transfers from './projectBackupTransfer';
import { parseProjectBackup } from './projectBackup';
import {
  createDataExport,
  downloadAllData,
  MAX_DATA_EXPORT_BYTES,
  type DataExportOptions
} from './dataExport';

const session = {
  userId: toUserId('export_owner'),
  displayName: 'Export owner',
  mode: 'development' as const
};
const options = (cloud = false): DataExportOptions => ({
  settings: structuredClone(DEFAULT_APP_SETTINGS),
  session: cloud ? session : null,
  cloudFunctionsEnabled: cloud,
  onProgress: vi.fn(),
  isCurrent: () => true
});
const entries = async (blob: Blob) =>
  unzipSync(new Uint8Array(await blob.arrayBuffer()));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('exports local Trash projects, save states, source bytes and settings without contacting the cloud', async () => {
  const source = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;');
  const ref = await localStore.putSourceBlob(source);
  let document = createProjectDocument('Local import', session.userId);
  document = importStepBody(document, {
    name: 'Source',
    sourceName: 'source.step',
    artifactId: 'artifact_local_source',
    stepSourceRef: ref
  }).document;
  document = createCheckpoint(document, 'Saved source');
  await localStore.saveLocalProject(document);
  await localStore.saveLocalProjectOrganization(document.projectId, {
    status: 'deleted',
    pinned: true,
    sortOrder: 4,
    deletedAt: new Date().toISOString()
  });
  await localStore.saveLastSyncedVersion(document.projectId, document.version);
  localStorage.setItem('openzcad-saved-views:v1', '{"myView":"front"}');
  localStorage.setItem('private-session-token', 'never-export-this');
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected network'));
  const archive = await entries(await createDataExport(options()));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
    cloudIncluded: boolean;
    localProjects: unknown[];
  };
  expect(manifest.cloudIncluded).toBe(false);
  expect(manifest.localProjects).toHaveLength(1);
  const backup = await parseProjectBackup(
    strFromU8(archive['projects/local/1.openzcad']!)
  );
  expect(backup.document.projectId).toBe(document.projectId);
  expect(backup.sources?.[0]?.sha256).toBe(ref.checksumSha256);
  expect(backup.saveStates).toHaveLength(1);
  const raw = Object.entries(archive).filter(([path]) =>
    path.startsWith('device/database/')
  );
  expect(
    raw.some(
      ([path, value]) =>
        path.includes('/projectMeta/') && strFromU8(value).includes('deleted')
    )
  ).toBe(true);
  expect(
    Object.entries(archive).some(
      ([path, value]) =>
        path.startsWith('device/binary/') &&
        strFromU8(value) === strFromU8(source)
    )
  ).toBe(true);
  expect(strFromU8(archive['device/settings.json']!)).toContain('myView');
  expect(
    Object.values(archive).some((data) =>
      strFromU8(data).includes('never-export-this')
    )
  ).toBe(false);
  expect(network).not.toHaveBeenCalled();
});

it('keeps local and cloud copies and every retained cloud revision separate', async () => {
  const document = createProjectDocument('Original', session.userId);
  await localStore.saveLocalProject({ ...document, name: 'Unsynced edits' });
  const saved = createCheckpoint(
    appendRevision(document, 'Unlinked revision'),
    'Older revision'
  );
  const revisionId = saved.revisions.at(-1)!.revisionId;
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({
    profile: session,
    records: { user_settings: [{ settings_json: '{}' }] }
  });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [
      {
        projectId: document.projectId,
        name: 'Cloud original',
        updatedAt: new Date().toISOString(),
        revisionCount: 1,
        organization: { status: 'archived', pinned: false, sortOrder: 0 }
      }
    ]
  });
  vi.spyOn(api, 'loadProject').mockResolvedValue(document);
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [] });
  vi.spyOn(api, 'listRevisions').mockResolvedValue({
    revisions: [
      {
        revisionId,
        projectId: document.projectId,
        reason: 'Older revision',
        createdAt: new Date().toISOString(),
        documentBytes: 100
      }
    ],
    maxRevisions: 50
  });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(saved);
  const archive = await entries(await createDataExport(options(true)));
  expect(
    (await parseProjectBackup(strFromU8(archive['projects/local/1.openzcad']!)))
      .document.name
  ).toBe('Unsynced edits');
  expect(
    (
      await parseProjectBackup(
        strFromU8(archive['projects/cloud/1/project.openzcad']!)
      )
    ).document.name
  ).toBe('Original');
  expect(archive['projects/cloud/1/revisions/1.openzcad']).toBeDefined();
  const account = JSON.parse(strFromU8(archive['cloud/account.json']!)) as {
    profile: { userId: string };
  };
  expect(account.profile.userId).toBe(session.userId);
  expect(await localStore.loadLocalProject(document.projectId)).toMatchObject({
    name: 'Unsynced edits'
  });
});

it('never downloads a partial archive and lets an API failure be retried', async () => {
  vi.spyOn(api, 'exportAccountData').mockRejectedValue(
    new Error('Account offline')
  );
  const download = vi
    .spyOn(transfers, 'downloadBackupFile')
    .mockImplementation(() => {});
  await expect(downloadAllData(options(true))).rejects.toThrow(
    'Account offline'
  );
  expect(download).not.toHaveBeenCalled();
  vi.mocked(api.exportAccountData).mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] });
  await downloadAllData(options(true));
  expect(download).toHaveBeenCalledWith(
    expect.stringMatching(/^openzcad-data-.*\.zip$/),
    expect.any(NodeBlob)
  );
});

it('refuses an account switch or a response from another account', async () => {
  await expect(
    createDataExport({ ...options(), isCurrent: () => false })
  ).rejects.toThrow('account changed');
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({
    profile: { userId: 'other' }
  });
  await expect(createDataExport(options(true))).rejects.toThrow(
    'account changed'
  );
});

it('reserves binary sizes before reading them and rejects an oversized archive', async () => {
  const blob = new Blob(['tiny']);
  Object.defineProperty(blob, 'size', { value: MAX_DATA_EXPORT_BYTES + 1 });
  const read = vi.spyOn(blob, 'arrayBuffer');
  vi.spyOn(localStore, 'visitLocalProjectData').mockImplementation(
    async (visit) => visit('sourceBlobs', 'large', { body: blob })
  );
  await expect(createDataExport(options())).rejects.toThrow('512 MB');
  expect(read).not.toHaveBeenCalled();
});
