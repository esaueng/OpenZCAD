import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  addReferenceImage,
  createCheckpoint,
  createProjectDocument,
  importMeshBody,
  importStepBody
} from '@openzcad/document-core';
import {
  decodeImportedMeshPayload,
  encodeImportedMeshPayload,
  toUserId,
  toArtifactId,
  type ArtifactRecord,
  type ReferenceImageId
} from '@openzcad/shared';
import { api, rememberProjectFormats } from './api';
import {
  pageBlobReferences,
  setEncryptedBlobReader
} from './e2ee/blobReferences';
import {
  createProjectBackup,
  readBackupResponse
} from './projectBackupTransfer';
import {
  importProjectCopy,
  backupFileBytes,
  checksum,
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
import * as localProjectStore from './localProjectStore';

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

it('applies a smaller bulk-export budget before reading sources and preserves the normal individual-export limit', async () => {
  const bytes = new Uint8Array(4096);
  const ref = await putSourceBlob(bytes);
  const document = importStepBody(
    createProjectDocument('Budgeted source', toUserId('owner')),
    {
      name: 'STEP source',
      sourceName: 'part.step',
      artifactId: 'budget_source',
      stepSourceRef: ref
    }
  ).document;
  const source = vi.spyOn(localProjectStore, 'loadSourceBlob');
  await expect(
    createProjectBackup(document, false, undefined, {
      localOnly: true,
      maxBytes: 4096
    })
  ).rejects.toThrow('bulk-download memory budget');
  expect(source).not.toHaveBeenCalled();
  const backup = await parseProjectBackup(
    await createProjectBackup(document, false)
  );
  expect(backup.sources).toHaveLength(1);
  expect(source).toHaveBeenCalledOnce();
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

async function referencedMeshProject() {
  const triangles = {
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2]
  };
  const bytes = encodeImportedMeshPayload(triangles);
  const ref = await putSourceBlob(bytes);
  const initial = createProjectDocument('Mesh archive', toUserId('owner'));
  const document = importMeshBody(initial, {
    name: 'Mesh',
    sourceName: 'scan.stl',
    artifactId: 'artifact_payload',
    triangleCount: 1,
    meshPayloadRef: ref
  }).document;
  const payload: ArtifactRecord = {
    artifactId: toArtifactId('artifact_payload'),
    projectId: document.projectId,
    kind: 'mesh-payload',
    name: 'scan.stl.ozmesh',
    contentType: 'application/octet-stream',
    bytes: bytes.length,
    objectKey: 'payload',
    metadata: {},
    createdAt: new Date().toISOString()
  };
  return { document, initial, bytes, ref, payload, triangles };
}

it('backs up a cloud mesh payload once as a source while keeping its original file', async () => {
  const { document, initial, bytes, ref, payload, triangles } =
    await referencedMeshProject();
  const originalBytes = new TextEncoder().encode('solid scan\nendsolid scan');
  const original: ArtifactRecord = {
    ...payload,
    artifactId: toArtifactId('artifact_original'),
    kind: 'stl-import',
    name: 'scan.stl',
    contentType: 'model/stl',
    bytes: originalBytes.length,
    objectKey: 'original'
  };
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({
    artifacts: [payload, original]
  });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(initial);
  const fetch = vi.fn(async () => new Response(originalBytes));
  vi.stubGlobal('fetch', fetch);
  const text = await createProjectBackup(document, true);
  const backup = await parseProjectBackup(text);
  expect(backup.files.map((file) => file.artifact.artifactId)).toEqual([
    'artifact_original'
  ]);
  expect(backup.sources).toHaveLength(1);
  expect(backup.sources![0]!.sha256).toBe(ref.checksumSha256);
  expect(text.split(backup.sources![0]!.base64)).toHaveLength(2);
  const duplicated = JSON.stringify({
    ...backup,
    files: [...backup.files, await packBackupFile(payload, bytes.buffer)]
  });
  expect(
    new NodeBlob([duplicated]).size - new NodeBlob([text]).size
  ).toBeGreaterThan(backup.sources![0]!.base64.length);
  expect(fetch).toHaveBeenCalledOnce();
  const signal = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(fetch).toHaveBeenCalledWith(
    '/api/artifacts/artifact_original/download',
    { signal }
  );

  // A new device restores the payload even though it has no file entry, and
  // rebuilding still gets exactly the imported triangles.
  globalThis.indexedDB = new IDBFactory();
  const copy = importProjectCopy(backup, toUserId('new-owner'));
  await saveImportedProject(copy);
  const restored = await loadSourceBlob(ref.checksumSha256);
  expect(restored).toEqual(bytes);
  expect(Array.from(decodeImportedMeshPayload(restored!).vertices)).toEqual(
    triangles.vertices
  );
  const restoredFiles = await loadProjectBackupFiles(copy.document.projectId);
  expect(restoredFiles).toHaveLength(1);
  expect(restoredFiles[0]!.artifact.name).toBe('scan.stl');
  expect(backupFileBytes(restoredFiles[0]!)).toEqual(originalBytes);
});

it('downloads a missing cloud mesh payload once into sources instead of files too', async () => {
  const { document, initial, bytes, ref, payload } =
    await referencedMeshProject();
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [payload] });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(initial);
  const fetch = vi.fn(async () => new Response(bytes));
  vi.stubGlobal('fetch', fetch);
  const backup = await parseProjectBackup(
    await createProjectBackup(document, true)
  );
  expect(backup.files).toEqual([]);
  expect(backup.sources).toHaveLength(1);
  expect(backup.sources![0]!.sha256).toBe(await checksum(bytes));
  expect(backup.sources![0]!.logicalBytes).toBe(ref.logicalBytes);
  expect(fetch).toHaveBeenCalledOnce();
  const signal = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(fetch).toHaveBeenCalledWith(
    '/api/artifacts/artifact_payload/download',
    { signal }
  );
});

it('uses an older backup payload file when the local source cache misses', async () => {
  const { document, bytes, ref, payload } = await referencedMeshProject();
  const older = await parseProjectBackup(
    await createProjectBackup(document, false)
  );
  older.files.push(await packBackupFile(payload, bytes.buffer));
  globalThis.indexedDB = new IDBFactory();
  await saveImportedProject(older);
  vi.spyOn(localProjectStore, 'loadSourceBlob').mockResolvedValue(null);
  const fetch = vi.fn(() => {
    throw new Error('An offline backup must use its stored payload file.');
  });
  vi.stubGlobal('fetch', fetch);
  const backup = await parseProjectBackup(
    await createProjectBackup(document, false)
  );
  expect(backup.files).toEqual([]);
  expect(backup.sources).toHaveLength(1);
  expect(backup.sources![0]!.sha256).toBe(ref.checksumSha256);
  expect(fetch).not.toHaveBeenCalled();
});

it('carries reference-image pictures as sources and refuses a backup without them', async () => {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9
  ]);
  const ref = await putSourceBlob(bytes);
  const document = addReferenceImage(
    createProjectDocument('Traced', toUserId('owner')),
    {
      image: {
        imageId: 'rimg_backup' as ReferenceImageId,
        name: 'Plan',
        contentType: 'image/png',
        source: ref,
        artifactId: toArtifactId('artifact_local_plan'),
        pixelWidth: 4,
        pixelHeight: 2,
        plane: { type: 'canonical', plane: 'XY', offset: 0 },
        center: { u: 0, v: 0 },
        rotationDeg: 0,
        width: 40,
        opacity: 0.5
      }
    }
  );
  await saveLocalProject(document);
  const text = await createProjectBackup(document, false);
  const backup = await parseProjectBackup(text);
  expect(backup.sources?.map((source) => source.sha256)).toEqual([
    ref.checksumSha256
  ]);
  // Restored on a device that never saw the picture, the bytes come along.
  const copy = importProjectCopy(backup, toUserId('new-owner'));
  globalThis.indexedDB = new IDBFactory();
  await saveImportedProject(copy);
  expect(await loadSourceBlob(ref.checksumSha256)).toEqual(bytes);
  // A backup whose picture is missing would restore a blank image: refused.
  const stripped = JSON.parse(text) as { sources: unknown[] };
  stripped.sources = [];
  await expect(parseProjectBackup(JSON.stringify(stripped))).rejects.toThrow(
    'Missing image: Plan'
  );
});

/**
 * ADR-024 Phase 4, content blobs: an encrypted project lists no stored
 * files, and its sources are blobs this page decrypts with the keys from
 * the verified document, never plaintext downloads.
 */
it('backs up an encrypted project’s sources through its blob reader', async () => {
  const bytes = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;');
  const blobId = 'c'.repeat(32);
  let document = createProjectDocument('Encrypted', toUserId('owner'));
  document = importStepBody(document, {
    name: 'Imported STEP',
    sourceName: 'part.step',
    artifactId: blobId,
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: await checksum(bytes),
      logicalBytes: bytes.byteLength
    }
  }).document;
  rememberProjectFormats([{ projectId: document.projectId, storageFormat: 2 }]);
  pageBlobReferences.remember(document.projectId, {
    blobId,
    kind: 'import-source',
    key: new Uint8Array(32),
    ciphertextHash: new Uint8Array(32),
    plaintextLength: bytes.byteLength
  });
  const reader = vi.fn(async () => new Uint8Array(bytes));
  setEncryptedBlobReader(reader);
  const listArtifacts = vi.spyOn(api, 'listArtifacts');
  // Save states come through the encrypted store; none are kept here.
  vi.spyOn(api, 'loadRevision').mockResolvedValue(null);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    const backup = await parseProjectBackup(
      await createProjectBackup(document, true)
    );
    expect(backup.sources!.map((source) => source.sha256)).toEqual([
      await checksum(bytes)
    ]);
    expect(reader).toHaveBeenCalledOnce();
    expect(listArtifacts).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    setEncryptedBlobReader(null);
    pageBlobReferences.clear();
    rememberProjectFormats([{ projectId: document.projectId }]);
  }
});

it('includes encrypted archived exports in a bulk backup without plaintext requests', async () => {
  const document = createProjectDocument('Encrypted export', toUserId('owner'));
  const blobId = 'd'.repeat(32);
  const bytes = new TextEncoder().encode('exported STEP bytes');
  rememberProjectFormats([{ projectId: document.projectId, storageFormat: 2 }]);
  pageBlobReferences.remember(document.projectId, {
    blobId,
    kind: 'export',
    key: new Uint8Array(32),
    ciphertextHash: new Uint8Array(32),
    plaintextLength: bytes.length
  });
  const reader = vi.fn(async () => bytes);
  setEncryptedBlobReader(reader);
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({
    artifacts: [
      {
        artifactId: toArtifactId(blobId),
        projectId: document.projectId,
        kind: 'step-export',
        name: 'model.step',
        contentType: 'application/step',
        objectKey: '',
        bytes: bytes.length,
        createdAt: new Date().toISOString(),
        metadata: {}
      }
    ]
  });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(null);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    const backup = await parseProjectBackup(
      await createProjectBackup(document, true, null, {
        includeEncryptedFiles: true
      })
    );
    expect(backup.files).toHaveLength(1);
    expect(backupFileBytes(backup.files[0]!)).toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    setEncryptedBlobReader(null);
    pageBlobReferences.clear();
    rememberProjectFormats([{ projectId: document.projectId }]);
  }
});
