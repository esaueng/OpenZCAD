import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  createSavedRevision,
  restoreFromSaveState
} from '@openzcad/document-core';
import { encodeImportedMeshPayload, toUserId } from '@openzcad/shared';
import { api } from './api';
import { preserveFailedCheckpoint } from './collaborationCheckpointFallback';
import {
  listLocalSaveStateCheckpoints,
  loadLocalProject,
  loadLocalSaveState,
  loadSourceBlob,
  putSourceBlob,
  saveImportedProject,
  saveLocalProject
} from './localProjectStore';
import { importProjectCopy, parseProjectBackup } from './projectBackup';
import { createProjectBackup } from './projectBackupTransfer';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(api, 'listArtifacts').mockResolvedValue({ artifacts: [] });
  vi.spyOn(api, 'loadRevision').mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps canonical checkpoint backups compatible without a device-only marker', async () => {
  const saved = createSavedRevision(
    createProjectDocument('Control', toUserId('owner')),
    'Canonical point'
  );
  await saveLocalProject(saved);
  const backup = await parseProjectBackup(
    await createProjectBackup(saved, true)
  );
  const state = backup.saveStates!.find(
    (entry) => entry.checkpointId === saved.checkpoints.at(-1)!.checkpointId
  )!;
  expect(state.document.nodes).toEqual(saved.nodes);
  expect(state.deviceOnly).toBeUndefined();
});

it('moves a failed member save and its exclusive mesh source to a fresh device without publishing its checkpoint', async () => {
  const initial = createProjectDocument('Member project', toUserId('owner'));
  const bytes = encodeImportedMeshPayload({
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2]
  });
  const ref = await putSourceBlob(bytes);
  const manager = new CommandManager(initial);
  manager.execute(
    commandFactories.importMesh({
      name: 'Saved mesh',
      sourceName: 'saved.stl',
      artifactId: 'artifact_local_private_mesh',
      triangleCount: 1,
      meshPayloadRef: ref
    })
  );
  const clicked = manager.document;
  await saveLocalProject(clicked);
  await expect(
    preserveFailedCheckpoint(
      new Error('Room offline'),
      clicked,
      'Offline milestone',
      {
        isCurrent: () => true,
        readDocument: () => manager.document,
        applyDocument: (next) => {
          manager.document = next;
        }
      },
      () => true
    )
  ).rejects.toThrow('The named save is stored on this device.');
  expect(manager.document).toBe(clicked);
  const point = (await listLocalSaveStateCheckpoints(clicked.projectId)).find(
    (checkpoint) => checkpoint.reason === 'Offline milestone'
  )!;
  expect(point).toBeDefined();
  // The current graph no longer needs the source; only the retained point does.
  const live = restoreFromSaveState(clicked, initial, 'Empty model');
  await saveLocalProject(live);
  const canonical = structuredClone(live);
  const backup = await parseProjectBackup(
    await createProjectBackup(live, true)
  );
  const saved = backup.saveStates!.find(
    (state) => state.checkpointId === point.checkpointId
  )!;
  expect(saved).toMatchObject({
    deviceOnly: true,
    document: { nodes: clicked.nodes, editHistory: clicked.editHistory }
  });
  expect(backup.sources).toHaveLength(1);
  expect(backup.document).toEqual(canonical);
  expect(live).toEqual(canonical);

  const copy = importProjectCopy(backup, toUserId('new-owner'));
  globalThis.indexedDB = new IDBFactory();
  await saveImportedProject(copy);
  const reopened = (await loadLocalProject(copy.document.projectId))!;
  const restored = (await loadLocalSaveState(
    reopened.projectId,
    point.checkpointId
  ))!;
  expect(restored.bodyOrder).toEqual(clicked.bodyOrder);
  expect(restored.editHistory).toEqual(
    copy.saveStates!.find((state) => state.deviceOnly)!.document.editHistory
  );
  expect(await loadSourceBlob(ref.checksumSha256)).toEqual(bytes);
  expect(
    (await listLocalSaveStateCheckpoints(reopened.projectId)).find(
      (checkpoint) => checkpoint.checkpointId === point.checkpointId
    )
  ).toEqual(point);
  expect(
    reopened.checkpoints.map((checkpoint) => checkpoint.checkpointId)
  ).not.toContain(point.checkpointId);
  const again = await parseProjectBackup(
    await createProjectBackup(reopened, false)
  );
  expect(again.saveStates).toEqual(copy.saveStates);
  expect(again.sources).toEqual(copy.sources);
});

it.each([
  'missing marker',
  'invalid marker',
  'foreign project',
  'foreign owner',
  'wrong checkpoint',
  'wrong version',
  'wrong revision',
  'duplicate'
] as const)('refuses a device-only backup point with %s', async (fault) => {
  const document = createProjectDocument('Guarded backup', toUserId('owner'));
  const saved = createSavedRevision(document, 'Private point');
  const point = saved.checkpoints.at(-1)!;
  const state: Record<string, unknown> = {
    checkpointId: point.checkpointId,
    document: saved,
    deviceOnly: true
  };
  if (fault === 'missing marker') delete state.deviceOnly;
  if (fault === 'invalid marker') state.deviceOnly = 'true';
  if (fault === 'foreign project')
    saved.projectId = 'proj_foreign' as typeof saved.projectId;
  if (fault === 'foreign owner') saved.ownerUserId = toUserId('other-owner');
  if (fault === 'wrong checkpoint') state.checkpointId = 'checkpoint_other';
  if (fault === 'wrong version') saved.version += 1;
  if (fault === 'wrong revision')
    saved.revisions.at(-1)!.revisionId = 'rev_other' as typeof point.revisionId;
  const backup = {
    format: 'openzcad-project',
    version: 1,
    document,
    files: [],
    saveStates: fault === 'duplicate' ? [state, state] : [state]
  };
  await expect(parseProjectBackup(JSON.stringify(backup))).rejects.toThrow(
    'Invalid save state identity.'
  );
});
