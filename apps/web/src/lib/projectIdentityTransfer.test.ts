import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  adoptProjectDocument,
  reidentifyProjectDocument
} from '@openzcad/document-core';
import { toProjectId, toUserId } from '@openzcad/shared';
import {
  ensureLocalProjectStorage,
  saveLocalProject,
  rekeyLocalProject,
  loadLocalProject,
  listLocalProjects,
  saveLocalProjectOrganization,
  listLocalProjectOrganizations,
  listPendingOrganizationMirrors,
  saveLastSyncedVersion,
  clearAllLastSyncedVersions,
  loadLastSyncedVersion,
  saveProjectThumbnail,
  loadProjectThumbnail,
  saveProjectMeasurements,
  loadProjectMeasurements,
  loadLocalSaveState,
  listLocalSaveStateIds,
  loadProjectBackupFiles,
  putSourceBlobIfAbsent,
  loadSourceBlob,
  deleteLocalProject,
  LocalProjectIdentityChangedError,
  LocalProjectIdentityConflictError
} from './localProjectStore';
import {
  latestTransferredProjectDocument,
  retainPreviousAccountProject
} from './projectIdentityTransfer';
import {
  LOCAL_PROJECT_DATABASE_NAME,
  LOCAL_PROJECT_DATABASE_VERSION
} from './localProjectSchema';

function renamed() {
  const manager = new CommandManager(
    createProjectDocument('Original', toUserId('device'))
  );
  manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name: 'First'
    })
  );
  manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name: 'Second'
    })
  );
  manager.undo();
  return manager;
}

async function request<T>(
  name: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
) {
  await ensureLocalProjectStorage();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(
      LOCAL_PROJECT_DATABASE_NAME,
      LOCAL_PROJECT_DATABASE_VERSION
    );
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(new Error('Local storage open failed', { cause: open.error }));
  });
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    const result = operation(transaction.objectStore(name));
    transaction.oncomplete = () => {
      database.close();
      resolve(result.result);
    };
    transaction.onabort = () => {
      database.close();
      reject(
        new Error('Local transaction failed', { cause: transaction.error })
      );
    };
  });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('account identity transfer', () => {
  it('preserves undo/redo endpoints, model IDs, history clocks and source references', () => {
    const original = renamed().document;
    const moved = reidentifyProjectDocument(
      original,
      toProjectId('account-id')
    );
    expect(reidentifyProjectDocument(moved, original.projectId)).toEqual(
      original
    );
    expect(Object.keys(moved.nodes)).toEqual(Object.keys(original.nodes));
    expect(moved.version).toBe(original.version);
    expect(moved.revisions).toEqual(original.revisions);
    expect(moved.checkpoints).toEqual(original.checkpoints);
    expect(moved.derived).toEqual(original.derived);
    const manager = new CommandManager(moved);
    manager.redo();
    expect(manager.document.name).toBe('Second');
    manager.undo();
    manager.undo();
    expect(manager.document.name).toBe('Original');
    expect(manager.document.projectId).toBe('account-id');
    expect(manager.document.nodes[manager.document.rootNodeId]).toMatchObject({
      projectId: 'account-id'
    });
  });

  it('moves every project record together while leaving checksum bytes in place', async () => {
    const document = renamed().document;
    const sourceId = document.projectId;
    const targetId = 'account-id';
    await saveLocalProject(document);
    const initial = createProjectDocument('Checkpoint', toUserId('device'));
    const checkpoint = reidentifyProjectDocument(initial, sourceId);
    await saveLocalProject(checkpoint);
    await saveLocalProject(document);
    const organization = {
      status: 'archived' as const,
      pinned: true,
      sortOrder: 7,
      archivedAt: '2026-01-02T00:00:00Z'
    };
    await saveLocalProjectOrganization(sourceId, organization, {
      mirrorPending: true
    });

    await saveProjectThumbnail(sourceId, {
      source: null,
      version: document.version,
      updatedAt: '2026-01-01T00:00:00Z'
    });
    await saveProjectMeasurements({
      version: 1,
      projectId: sourceId,
      updatedAt: '2026-01-03T00:00:00Z',
      display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
      measurements: []
    });
    await request('projectBackupFiles', 'readwrite', (store) =>
      store.put(
        [
          {
            artifact: { projectId: sourceId, artifactId: 'unchanged-artifact' },
            base64: 'AQID',
            sha256: 'checksum'
          }
        ],
        sourceId
      )
    );
    const blob = await putSourceBlobIfAbsent(new Uint8Array([1, 2, 3]));
    const moved = await rekeyLocalProject(document, targetId);
    expect(moved).toEqual(
      reidentifyProjectDocument(document, toProjectId(targetId))
    );
    expect((await listLocalProjects()).map((entry) => entry.projectId)).toEqual(
      [targetId]
    );
    expect(await loadLocalProject(sourceId)).toEqual(moved);
    expect((await listLocalProjectOrganizations()).get(targetId)).toEqual(
      organization
    );
    expect(await listPendingOrganizationMirrors()).toEqual(new Set([targetId]));
    expect(await loadLastSyncedVersion(targetId)).toBeNull();
    await saveLastSyncedVersion(targetId, 9);
    expect(await loadLastSyncedVersion(targetId)).toBe(9);
    expect(await loadProjectThumbnail(targetId)).toMatchObject({
      projectId: targetId,
      version: document.version
    });
    expect(await loadProjectMeasurements(targetId)).toMatchObject({
      projectId: targetId,
      updatedAt: '2026-01-03T00:00:00Z'
    });
    expect(await loadProjectBackupFiles(targetId)).toMatchObject([
      { artifact: { projectId: targetId, artifactId: 'unchanged-artifact' } }
    ]);
    expect(await listLocalSaveStateIds(targetId)).toContain(
      checkpoint.checkpoints[0]!.checkpointId
    );
    const snapshot = await loadLocalSaveState(
      targetId,
      checkpoint.checkpoints[0]!.checkpointId
    );
    expect(snapshot?.projectId).toBe(targetId);
    expect(snapshot?.version).toBe(checkpoint.version);
    expect(snapshot?.revisions).toEqual(checkpoint.revisions);
    expect(await loadSourceBlob(blob.ref.checksumSha256)).toEqual(
      new Uint8Array([1, 2, 3])
    );
    for (const storeName of [
      'projects',
      'projectMeta',
      'projectSync',
      'projectThumbnails',
      'projectMeasurements',
      'projectBackupFiles'
    ])
      expect(
        await request(storeName, 'readonly', (store) => store.get(sourceId))
      ).toBeUndefined();
    await expect(saveLocalProject(document)).rejects.toBeInstanceOf(
      LocalProjectIdentityChangedError
    );
    await expect(
      saveProjectMeasurements({
        version: 1,
        projectId: sourceId,
        updatedAt: '',
        display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
        measurements: []
      })
    ).rejects.toBeInstanceOf(LocalProjectIdentityChangedError);
    await expect(deleteLocalProject(sourceId)).rejects.toBeInstanceOf(
      LocalProjectIdentityChangedError
    );
    expect(await loadLocalProject(targetId)).toEqual(moved);
  });

  it('keeps later durable edits and retains independent account identities', async () => {
    const manager = renamed();
    const snapshot = structuredClone(manager.document);
    manager.execute(
      commandFactories.renameNode({
        nodeId: manager.document.rootNodeId,
        name: 'Later edit'
      })
    );
    await saveLocalProject(manager.document);
    const moved = await rekeyLocalProject(snapshot, 'first-account-id');
    expect(moved.name).toBe('Later edit');
    expect(moved.version).toBe(manager.document.version);
    await saveLastSyncedVersion(moved.projectId, moved.version);
    await clearAllLastSyncedVersions();
    expect(await loadLastSyncedVersion(moved.projectId)).toBeNull();
    const next = await rekeyLocalProject(moved, 'second-account-id');
    expect(await loadLocalProject(snapshot.projectId)).toEqual(moved);
    expect(await loadLocalProject('first-account-id')).toEqual(moved);
    expect(await loadLocalProject('second-account-id')).toEqual(next);
    expect(
      new Set((await listLocalProjects()).map((project) => project.projectId))
    ).toEqual(new Set(['first-account-id', 'second-account-id']));
  });

  it('recovers when an interrupted adoption already has a matching local account cache', async () => {
    const source = renamed().document;
    const account = adoptProjectDocument(
      reidentifyProjectDocument(source, toProjectId('cached-account')),
      toUserId('account')
    );
    const prepared = {
      ...source,
      ownerUserId: account.ownerUserId,
      editHistory: { ...source.editHistory!, actorUserId: account.ownerUserId }
    };
    await saveLocalProject(source);
    await saveLocalProject(account);
    await saveLastSyncedVersion(account.projectId, account.version);
    await saveProjectMeasurements({
      version: 1,
      projectId: source.projectId,
      updatedAt: '2026-01-03T00:00:00Z',
      display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
      measurements: []
    });
    const transferred = await rekeyLocalProject(prepared, account.projectId);
    expect(transferred.checkpoints).toEqual(account.checkpoints);
    expect(transferred.editHistory).toEqual(account.editHistory);
    expect(await loadLocalProject(source.projectId)).toEqual(transferred);
    expect(await loadLastSyncedVersion(account.projectId)).toBe(
      account.version
    );
    expect(await loadProjectMeasurements(account.projectId)).toMatchObject({
      projectId: account.projectId
    });
    expect(
      (await listLocalProjects()).map((project) => project.projectId)
    ).toEqual([account.projectId]);
  });

  it('preserves both histories when the local account cache contains different work', async () => {
    const source = renamed().document;
    const manager = new CommandManager(
      reidentifyProjectDocument(source, toProjectId('cached-account'))
    );
    manager.execute(
      commandFactories.renameNode({
        nodeId: manager.document.rootNodeId,
        name: 'Different account work'
      })
    );
    await saveLocalProject(source);
    await saveLocalProject(manager.document);
    await expect(
      rekeyLocalProject(source, manager.document.projectId)
    ).rejects.toBeInstanceOf(LocalProjectIdentityConflictError);
    expect(await loadLocalProject(source.projectId)).toEqual(source);
    expect(await loadLocalProject(manager.document.projectId)).toEqual(
      manager.document
    );
  });

  it('uses the returned newer durable version when the live manager is older', async () => {
    const manager = renamed();
    const live = structuredClone(manager.document);
    manager.execute(
      commandFactories.renameNode({
        nodeId: manager.document.rootNodeId,
        name: 'Newer durable work'
      })
    );
    await saveLocalProject(manager.document);
    const transferred = await rekeyLocalProject(live, 'account-id');
    const accepted = latestTransferredProjectDocument(transferred, live);
    expect(accepted).toBe(transferred);
    expect(accepted.name).toBe('Newer durable work');
    expect(accepted.version).toBe(manager.document.version);
    const reopened = new CommandManager(accepted);
    reopened.undo();
    expect(reopened.document.name).toBe('First');
  });

  it('recognizes legacy account IDs on schema upgrade and keeps their baselines independent', async () => {
    const source = renamed().document;
    const accountA = { ...source, ownerUserId: toUserId('account-a') };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(LOCAL_PROJECT_DATABASE_NAME, 10);
      open.onupgradeneeded = () => {
        open.result
          .createObjectStore('projects', { keyPath: 'projectId' })
          .put(accountA);
        open.result
          .createObjectStore('projectSync', { keyPath: 'projectId' })
          .put({
            projectId: source.projectId,
            lastSyncedVersion: source.version
          });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(new Error('Legacy fixture open failed'));
    });
    const accountBInput = { ...accountA, ownerUserId: toUserId('account-b') };
    const accountB = await rekeyLocalProject(accountBInput, 'account-b-id');
    expect(await loadLocalProject(accountA.projectId)).toEqual(accountA);
    expect(await loadLocalProject(accountB.projectId)).toEqual(accountB);
    expect(await loadLastSyncedVersion(accountA.projectId)).toBe(
      accountA.version
    );
    expect(await loadLastSyncedVersion(accountB.projectId)).toBeNull();
  });

  it('retains a pre-upgrade account copy after logout already cleared its baseline', async () => {
    const accountA = adoptProjectDocument(
      renamed().document,
      toUserId('account-a')
    );
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(LOCAL_PROJECT_DATABASE_NAME, 10);
      open.onupgradeneeded = () => {
        open.result
          .createObjectStore('projects', { keyPath: 'projectId' })
          .put(accountA);
        const sync = open.result.createObjectStore('projectSync', {
          keyPath: 'projectId'
        });
        sync.put({
          projectId: accountA.projectId,
          lastSyncedVersion: accountA.version
        });
        sync.clear();
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(new Error('Legacy fixture open failed'));
    });
    const localUserId = toUserId('user_local_browser');
    const accountBUserId = toUserId('account-b');
    expect(
      retainPreviousAccountProject(accountA, localUserId, accountBUserId)
    ).toBe(true);
    expect(
      retainPreviousAccountProject(
        { ...accountA, ownerUserId: localUserId },
        localUserId,
        accountBUserId
      )
    ).toBe(false);
    expect(
      retainPreviousAccountProject(accountA, localUserId, accountA.ownerUserId)
    ).toBe(false);
    const accountB = await rekeyLocalProject(
      {
        ...accountA,
        ownerUserId: accountBUserId,
        editHistory: { ...accountA.editHistory!, actorUserId: accountBUserId }
      },
      'account-b-id',
      {
        retainSource: retainPreviousAccountProject(
          accountA,
          localUserId,
          accountBUserId
        )
      }
    );
    await saveLastSyncedVersion(accountB.projectId, accountB.version);
    const reopenedA = await loadLocalProject(accountA.projectId);
    const reopenedB = await loadLocalProject(accountB.projectId);
    expect(reopenedA).toEqual(accountA);
    expect(reopenedB).toEqual(accountB);
    expect(accountB.projectId).not.toBe(accountA.projectId);
    expect(accountB.editHistory).toEqual({
      ...reidentifyProjectDocument(accountA, accountB.projectId).editHistory!,
      actorUserId: accountBUserId
    });
    expect(await loadLastSyncedVersion(accountA.projectId)).toBeNull();
    expect(await loadLastSyncedVersion(accountB.projectId)).toBe(
      accountB.version
    );
    expect(
      new Set((await listLocalProjects()).map((project) => project.projectId))
    ).toEqual(new Set([accountA.projectId, accountB.projectId]));
    const reopened = new CommandManager(reopenedA!);
    reopened.redo();
    expect(reopened.document.name).toBe('Second');
    expect(reopened.document.projectId).toBe(accountA.projectId);
  });

  it('rolls back the document, companion records and alias when a write fails', async () => {
    const document = renamed().document;
    await saveLocalProject(document);
    await saveProjectThumbnail(document.projectId, {
      source: null,
      version: 1,
      updatedAt: 'original-time'
    });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key
    ) {
      if (
        this.name === 'projectThumbnails' &&
        (value as { projectId: string }).projectId === 'account-id'
      )
        throw new DOMException(
          'Synthetic local write failure',
          'DataCloneError'
        );
      return put.call(this, value, key);
    });
    await expect(rekeyLocalProject(document, 'account-id')).rejects.toThrow(
      'Synthetic local write failure'
    );
    expect(await loadLocalProject(document.projectId)).toEqual(document);
    expect(await loadLocalProject('account-id')).toBeNull();
    expect(
      await request('projectIdentityAliases', 'readonly', (store) =>
        store.get(document.projectId)
      )
    ).toBeUndefined();
    expect(await loadProjectThumbnail(document.projectId)).toMatchObject({
      updatedAt: 'original-time'
    });
  });
});
