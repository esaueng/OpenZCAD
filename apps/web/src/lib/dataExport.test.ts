import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { unzipSync, strFromU8 } from 'fflate';
import type * as Fflate from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  appendRevision,
  createCheckpoint,
  createSavedRevision,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  DEFAULT_APP_SETTINGS,
  toArtifactId,
  toUserId,
  toRevisionId,
  type ArtifactRecord
} from '@openzcad/shared';
import type { SkippedDataProject } from './dataExportTypes';
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

const encoding = vi.hoisted(() => ({
  oversizedProjectId: '',
  stagedProjectId: ''
}));
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof Fflate>();
  return {
    ...actual,
    strToU8(text: string, latin?: boolean) {
      const bytes = actual.strToU8(text, latin);
      // Exercise real capacity accounting without allocating half a GiB.
      if (
        encoding.oversizedProjectId &&
        text.includes('"format":"openzcad-project"') &&
        text.includes(encoding.oversizedProjectId)
      )
        Object.defineProperty(bytes, 'byteLength', {
          value: 512 * 1024 * 1024
        });
      else if (
        encoding.stagedProjectId &&
        text.includes('"format":"openzcad-project"') &&
        text.includes(encoding.stagedProjectId)
      )
        Object.defineProperty(bytes, 'byteLength', { value: 64 * 1024 * 1024 });
      return bytes;
    }
  };
});

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
  encoding.oversizedProjectId = '';
  encoding.stagedProjectId = '';
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
  const artifacts = vi
    .spyOn(api, 'listArtifacts')
    .mockResolvedValue({ artifacts: [] });
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
  expect(artifacts).toHaveBeenCalledOnce();
  const account = JSON.parse(strFromU8(archive['cloud/account.json']!)) as {
    profile: { userId: string };
  };
  expect(account.profile.userId).toBe(session.userId);
  expect(await localStore.loadLocalProject(document.projectId)).toMatchObject({
    name: 'Unsynced edits'
  });
});

it('does not download when account discovery fails and permits retry', async () => {
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

it.each([MAX_DATA_EXPORT_BYTES + 1, MAX_DATA_EXPORT_BYTES / 2 + 1])(
  'omits a raw snapshot of %i bytes before reading when archive or staged-memory capacity is exceeded',
  async (size) => {
    const blob = new Blob(['tiny']);
    Object.defineProperty(blob, 'size', { value: size });
    const read = vi.spyOn(blob, 'arrayBuffer');
    vi.spyOn(localStore, 'visitLocalProjectData').mockImplementation(
      async (visit, selectedStores) => {
        if (!selectedStores) visit('sourceBlobs', 'large', { body: blob });
      }
    );
    const archive = await entries(await createDataExport(options()));
    const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
      omittedSections: { name: string; reason: string }[];
    };
    expect(manifest.omittedSections).toHaveLength(1);
    expect(manifest.omittedSections[0]?.name).toBe(
      'Raw device database snapshot'
    );
    expect(manifest.omittedSections[0]?.reason).toContain('512 MB');
    expect(archive['device/settings.json']).toBeDefined();
    expect(
      Object.keys(archive).some(
        (path) =>
          path.startsWith('device/binary/') ||
          path.startsWith('device/database/')
      )
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
  }
);

it('skips unreadable and incomplete cloud backups atomically, then includes later projects and reports every omission', async () => {
  const broken = createProjectDocument('Unavailable project', session.userId);
  const history = createProjectDocument('Incomplete history', session.userId);
  const good = createProjectDocument('Working project', session.userId);
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [broken, history, good].map((doc) => ({
      projectId: doc.projectId,
      name: doc.name,
      updatedAt: new Date().toISOString(),
      revisionCount: 0
    }))
  });
  vi.spyOn(api, 'loadProject').mockImplementation(async (id) => {
    if (id === broken.projectId) throw new Error('Unlock encryption first.');
    return id === history.projectId ? history : good;
  });
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [] });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(null);
  vi.spyOn(api, 'listRevisions').mockImplementation(async (id) => ({
    revisions:
      id === history.projectId
        ? [
            {
              revisionId: toRevisionId('missing_revision'),
              projectId: history.projectId,
              reason: 'Retained save',
              createdAt: new Date().toISOString(),
              documentBytes: 1
            }
          ]
        : [],
    maxRevisions: 50
  }));
  const download = vi
    .spyOn(transfers, 'downloadBackupFile')
    .mockImplementation(() => {});
  const summary = await downloadAllData(options(true));
  expect(summary.includedProjects).toBe(1);
  expect(summary.skippedProjects.map((project) => project.name)).toEqual([
    broken.name,
    history.name
  ]);
  const archive = await entries(download.mock.calls[0]![1]);
  expect(
    Object.keys(archive).some(
      (path) =>
        path.startsWith('projects/cloud/1/') ||
        path.startsWith('projects/cloud/2/')
    )
  ).toBe(false);
  expect(
    (
      await parseProjectBackup(
        strFromU8(archive['projects/cloud/3/project.openzcad']!)
      )
    ).document.projectId
  ).toBe(good.projectId);
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
    skippedProjects: SkippedDataProject[];
  };
  expect(manifest.skippedProjects).toEqual(summary.skippedProjects);
  const report = strFromU8(archive['NOT-INCLUDED.txt']!);
  for (const project of [broken, history]) {
    expect(report).toContain(project.name);
    expect(report).toContain(project.projectId);
  }
  expect(report).toContain('Unlock encryption first');
  expect(report).toContain('File → Export project');
});

it('does not spend the byte budget on an oversized project, so a later smaller one still fits', async () => {
  const large = createProjectDocument('Oversized project', session.userId);
  const small = createProjectDocument('Smaller project', session.userId);
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [large, small].map((doc) => ({
      projectId: doc.projectId,
      name: doc.name,
      updatedAt: new Date().toISOString(),
      revisionCount: 0
    }))
  });
  vi.spyOn(api, 'loadProject').mockImplementation(async (id) =>
    id === large.projectId ? large : small
  );
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [] });
  vi.spyOn(api, 'listRevisions').mockResolvedValue({
    revisions: [],
    maxRevisions: 50
  });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(null);
  encoding.oversizedProjectId = large.projectId;
  const archive = await entries(await createDataExport(options(true)));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
    skippedProjects: SkippedDataProject[];
  };
  expect(manifest.skippedProjects).toMatchObject([
    { projectId: large.projectId, name: large.name, scope: 'cloud' }
  ]);
  expect(manifest.skippedProjects[0]?.reason).toContain('512 MB');
  expect(archive['projects/cloud/1/project.openzcad']).toBeUndefined();
  expect(
    (
      await parseProjectBackup(
        strFromU8(archive['projects/cloud/2/project.openzcad']!)
      )
    ).document.projectId
  ).toBe(small.projectId);
  expect(archive['NOT-INCLUDED.txt']).toBeDefined();
});

it('reduces the builder budget before retained history and refuses large sources before reading them', async () => {
  const main = createProjectDocument('Large history', session.userId);
  const good = createProjectDocument(
    'Small project after history',
    session.userId
  );
  const retained = importStepBody(structuredClone(main), {
    name: 'Large retained source',
    sourceName: 'retained.step',
    artifactId: 'retained_source',
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: 'a'.repeat(64),
      logicalBytes: 64 * 1024 * 1024
    }
  }).document;
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [main, good].map((doc) => ({
      projectId: doc.projectId,
      name: doc.name,
      updatedAt: new Date().toISOString(),
      revisionCount: 0
    }))
  });
  vi.spyOn(api, 'loadProject').mockImplementation(async (id) =>
    id === main.projectId ? main : good
  );
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [] });
  vi.spyOn(api, 'listRevisions').mockImplementation(async (id) => ({
    revisions:
      id === main.projectId
        ? [
            {
              revisionId: toRevisionId('large_retained'),
              projectId: main.projectId,
              reason: 'Large history',
              createdAt: new Date().toISOString(),
              documentBytes: 1000
            }
          ]
        : [],
    maxRevisions: 50
  }));
  vi.spyOn(api, 'loadRevision').mockImplementation(
    async (_projectId, revisionId) =>
      revisionId === 'large_retained' ? retained : null
  );
  const source = vi.spyOn(localStore, 'loadSourceBlob');
  const build = transfers.createProjectBackup;
  const calls = vi
    .spyOn(transfers, 'createProjectBackup')
    .mockImplementation(build);
  encoding.stagedProjectId = main.projectId;
  const archive = await entries(await createDataExport(options(true)));
  const firstBudget = calls.mock.calls[0]![3]!.maxBytes!;
  const retainedBudget = calls.mock.calls[1]![3]!.maxBytes!;
  const laterBudget = calls.mock.calls[2]![3]!.maxBytes!;
  expect(retainedBudget).toBeLessThan(firstBudget);
  expect(laterBudget).toBe(firstBudget);
  expect(source).not.toHaveBeenCalled();
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
    skippedProjects: SkippedDataProject[];
  };
  expect(manifest.skippedProjects[0]?.reason).toContain(
    'bulk-download memory budget'
  );
  expect(archive['projects/cloud/1/project.openzcad']).toBeUndefined();
  expect(archive['projects/cloud/2/project.openzcad']).toBeDefined();
});

it('lists a failed local copy by name and continues with other local backups', async () => {
  const broken = createProjectDocument('Broken local project', session.userId);
  const good = createProjectDocument('Healthy local project', session.userId);
  await localStore.saveLocalProject(broken);
  await localStore.saveLocalProject(good);
  const load = localStore.loadLocalProject;
  vi.spyOn(localStore, 'loadLocalProject').mockImplementation(async (id) => {
    if (id === broken.projectId) throw new Error('Missing STEP source.');
    return load(id);
  });
  const archive = await entries(await createDataExport(options()));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
    skippedProjects: SkippedDataProject[];
    localProjects: { projectId: string; path: string }[];
  };
  expect(manifest.skippedProjects).toMatchObject([
    {
      projectId: broken.projectId,
      name: broken.name,
      scope: 'local',
      reason: 'Missing STEP source.'
    }
  ]);
  expect(manifest.localProjects.map((project) => project.projectId)).toEqual([
    good.projectId
  ]);
  expect(archive[manifest.localProjects[0]!.path]).toBeDefined();
});

it('cancels rather than treating an account change during a project read as a skipped project', async () => {
  let current = true;
  const project = createProjectDocument('Private project', session.userId);
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [
      {
        projectId: project.projectId,
        name: project.name,
        updatedAt: new Date().toISOString(),
        revisionCount: 0
      }
    ]
  });
  vi.spyOn(api, 'loadProject').mockImplementation(async () => {
    current = false;
    throw new Error('Old account error');
  });
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [] });
  vi.spyOn(api, 'listRevisions').mockResolvedValue({
    revisions: [],
    maxRevisions: 50
  });
  const download = vi
    .spyOn(transfers, 'downloadBackupFile')
    .mockImplementation(() => {});
  await expect(
    downloadAllData({ ...options(true), isCurrent: () => current })
  ).rejects.toThrow('account changed');
  expect(download).not.toHaveBeenCalled();
});

it('retains a checkpoint and file added while its document read is pending', async () => {
  const saved = createSavedRevision(
    createProjectDocument('Concurrent save', session.userId),
    'Saved during download'
  );
  const document = appendRevision(saved, 'Following edit');
  const revisionId = saved.revisions.at(-1)!.revisionId;
  const fileBytes = new TextEncoder().encode('concurrent STEP export');
  const artifact: ArtifactRecord = {
    artifactId: toArtifactId('artifact_concurrent_export'),
    projectId: document.projectId,
    kind: 'step-export',
    name: 'concurrent.step',
    contentType: 'application/step',
    objectKey: 'fixture',
    bytes: fileBytes.length,
    metadata: {},
    createdAt: '2026-10-28T00:00:00.000Z'
  };
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [
      {
        projectId: document.projectId,
        name: document.name,
        updatedAt: '2026-10-28T00:00:00.000Z',
        revisionCount: 0
      }
    ]
  });
  let finish!: () => void;
  let documentRead = false;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const reading = vi.spyOn(api, 'loadProject').mockImplementation(async () => {
    await gate;
    documentRead = true;
    return document;
  });
  vi.spyOn(api, 'listRevisions').mockImplementation(async () => ({
    revisions: documentRead
      ? [
          {
            revisionId,
            projectId: document.projectId,
            reason: 'Saved during download',
            createdAt: '2026-10-28T00:00:00.000Z',
            documentBytes: 100
          }
        ]
      : [],
    maxRevisions: 50
  }));
  vi.spyOn(api, 'listArtifacts').mockImplementation(async () => ({
    artifacts: documentRead ? [artifact] : []
  }));
  const revision = vi
    .spyOn(api, 'loadRevision')
    .mockImplementation(async (_id, id) => (id === revisionId ? saved : null));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fileBytes));
  const exporting = createDataExport(options(true));
  await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
  finish();
  const archive = await entries(await exporting);
  const backup = await parseProjectBackup(
    strFromU8(archive['projects/cloud/1/project.openzcad']!)
  );
  expect(
    backup.saveStates!.some(
      (state) => state.document.revisions.at(-1)?.revisionId === revisionId
    )
  ).toBe(true);
  expect(revision).toHaveBeenCalledWith(document.projectId, revisionId);
  expect(backup.files.map((file) => file.artifact.name)).toEqual([
    'concurrent.step'
  ]);
  expect(atob(backup.files[0]!.base64)).toBe('concurrent STEP export');
});

it('reads catalogs together after the document and avoids requests for history absent from the complete catalog', async () => {
  const document = appendRevision(
    createCheckpoint(
      createProjectDocument('Catalog control', session.userId),
      'Unretained checkpoint'
    ),
    'Later edit'
  );
  vi.spyOn(api, 'exportAccountData').mockResolvedValue({ profile: session });
  vi.spyOn(api, 'listProjects').mockResolvedValue({
    projects: [
      {
        projectId: document.projectId,
        name: document.name,
        updatedAt: new Date().toISOString(),
        revisionCount: 0
      }
    ]
  });
  let finish!: (value: typeof document) => void;
  const reading = vi.spyOn(api, 'loadProject').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  let finishRevisions!: (
    value: Awaited<ReturnType<typeof api.listRevisions>>
  ) => void;
  let finishArtifacts!: (
    value: Awaited<ReturnType<typeof api.listArtifacts>>
  ) => void;
  const revisions = vi.spyOn(api, 'listRevisions').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRevisions = resolve;
      })
  );
  const artifacts = vi.spyOn(api, 'listArtifacts').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishArtifacts = resolve;
      })
  );
  const missing = vi.spyOn(api, 'loadRevision').mockResolvedValue(null);
  const pending = createDataExport(options(true));
  await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
  expect(revisions).not.toHaveBeenCalled();
  expect(artifacts).not.toHaveBeenCalled();
  finish(document);
  await vi.waitFor(() => {
    expect(revisions).toHaveBeenCalledOnce();
    expect(artifacts).toHaveBeenCalledOnce();
  });
  finishRevisions({ revisions: [], maxRevisions: 50 });
  finishArtifacts({ artifacts: [] });
  const archive = await entries(await pending);
  const backup = await parseProjectBackup(
    strFromU8(archive['projects/cloud/1/project.openzcad']!)
  );
  expect(backup.document.projectId).toBe(document.projectId);
  expect(missing).not.toHaveBeenCalled();
});

it('can skip the extra device snapshot without reading its stores, while keeping portable project backups', async () => {
  const document = createProjectDocument('Portable project', session.userId);
  await localStore.saveLocalProject(document);
  const visit = vi.spyOn(localStore, 'visitLocalProjectData');
  const archive = await entries(
    await createDataExport({ ...options(), includeDeviceSnapshot: false })
  );
  expect(visit).toHaveBeenCalledOnce();
  expect(visit.mock.calls[0]![1]).toEqual(['projects']);
  expect(archive['projects/local/1.openzcad']).toBeDefined();
  expect(
    Object.keys(archive).some((path) => path.startsWith('device/database/'))
  ).toBe(false);
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
    deviceSnapshotRequested: boolean;
  };
  expect(manifest.deviceSnapshotRequested).toBe(false);
  expect(strFromU8(archive['README.txt']!)).toContain('was not requested');
});
