import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  createCheckpoint,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { toUserId, toArtifactId } from '@openzcad/shared';
import { api } from './api';
import {
  createProjectBackup,
  readBackupResponse
} from './projectBackupTransfer';
import {
  importProjectCopy,
  packBackupFile,
  parseProjectBackup
} from './projectBackup';
import {
  deleteLocalProject,
  listLocalProjects,
  loadLocalProject,
  loadLocalSaveState,
  loadProjectBackupFiles,
  loadProjectMeasurements,
  loadSourceBlob,
  putSourceBlob,
  saveImportedProject,
  saveLocalProject,
  saveProjectMeasurements
} from './localProjectStore';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('moves source blobs, restorable save states, measurements and files to an independent offline project', async () => {
  const bytes = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;');
  const ref = await putSourceBlob(bytes);
  let document = createProjectDocument(
    'Reference import',
    toUserId('original')
  );
  document = importStepBody(document, {
    name: 'Imported STEP',
    sourceName: 'part.step',
    artifactId: 'artifact_local_source',
    stepSourceRef: ref
  }).document;
  document = createCheckpoint(document, 'Source save');
  await saveLocalProject(document);
  await saveProjectMeasurements({
    projectId: document.projectId,
    version: 1,
    updatedAt: new Date().toISOString(),
    measurements: [],
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' }
  });
  const backup = await parseProjectBackup(
    await createProjectBackup(document, false)
  );
  expect(backup.sources).toHaveLength(1);
  expect(backup.saveStates).toHaveLength(1);
  expect(backup.measurements?.display.precision).toBe(2);
  backup.files.push(
    await packBackupFile(
      {
        artifactId: toArtifactId('artifact_binary'),
        projectId: document.projectId,
        kind: 'stl-import',
        name: 'binary.stl',
        contentType: 'model/stl',
        bytes: 3,
        objectKey: 'archive',
        metadata: {},
        createdAt: new Date().toISOString()
      },
      new Uint8Array([0, 255, 128]).buffer
    )
  );
  const copy = importProjectCopy(backup, toUserId('new-owner'));
  // A new device has none of the source bytes or save states available elsewhere.
  globalThis.indexedDB = new IDBFactory();
  await saveImportedProject(copy);
  const reopened = await loadLocalProject(copy.document.projectId);
  expect(reopened?.ownerUserId).toBe('new-owner');
  expect(await loadSourceBlob(ref.checksumSha256)).toEqual(bytes);
  expect(
    (
      await loadLocalSaveState(
        copy.document.projectId,
        document.checkpoints.at(-1)!.checkpointId
      )
    )?.projectId
  ).toBe(copy.document.projectId);
  expect(
    (await loadProjectMeasurements(copy.document.projectId))?.display.precision
  ).toBe(2);
  const again = await parseProjectBackup(
    await createProjectBackup(reopened!, false)
  );
  expect(again.sources).toEqual(copy.sources);
  expect(again.files).toEqual(copy.files);
  expect(again.saveStates).toEqual(copy.saveStates);
  expect(await listLocalProjects()).toHaveLength(1);
  await deleteLocalProject(copy.document.projectId);
  expect(await loadProjectBackupFiles(copy.document.projectId)).toEqual([]);
});

it('refuses unavailable archived files instead of exporting a partial project', async () => {
  const document = createProjectDocument('Cloud', toUserId('owner'));
  vi.spyOn(api, 'listArtifacts').mockRejectedValue(new Error('Offline'));
  await expect(createProjectBackup(document, true)).rejects.toThrow('Offline');
});

it('refuses missing source blobs and corrupt source checksums', async () => {
  const document = importStepBody(
    createProjectDocument('Missing', toUserId('owner')),
    {
      name: 'Missing STEP',
      sourceName: 'part.step',
      artifactId: 'artifact_source',
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: 'a'.repeat(64),
        logicalBytes: 2
      }
    }
  ).document;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2])))
  );
  await expect(createProjectBackup(document, false)).rejects.toThrow(
    'damaged STEP source'
  );
});

it('enforces streamed download limits even without content-length', async () => {
  await expect(
    readBackupResponse(new Response(new Uint8Array(10)), 5)
  ).rejects.toThrow('limit');
});

it('rolls back all companion data when a project import transaction fails', async () => {
  const document = createProjectDocument('Atomic', toUserId('owner'));
  const backup = importProjectCopy(
    await parseProjectBackup(await createProjectBackup(document, false)),
    toUserId('owner')
  );
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    if (this.name === 'projectBackupFiles') throw new Error('Quota exhausted');
    return key === undefined
      ? original.call(this, value)
      : original.call(this, value, key);
  });
  await expect(saveImportedProject(backup)).rejects.toThrow('Quota exhausted');
  expect(await loadLocalProject(backup.document.projectId)).toBeNull();
  expect(await listLocalProjects()).toEqual([]);
});
