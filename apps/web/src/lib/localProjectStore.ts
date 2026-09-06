import type { ProjectDocument, ProjectSummary } from '@openzcad/shared';

import type { BackupFile, ProjectBackup } from './projectBackup';

const DATABASE_NAME = 'openzcad-v2';
const STORE_NAME = 'projects';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('backupFiles')) {
        request.result.createObjectStore('backupFiles');
      }
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () =>
      reject(
        new Error('Close other OpenZCAD tabs and retry the project transfer.')
      );
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB unavailable.'));
  });
}

function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, mode);
        const request = action(tx.objectStore(STORE_NAME));
        let result: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () =>
          reject(request.error ?? new Error('Local project storage failed.'));
        tx.oncomplete = () => {
          database.close();
          resolve(result);
        };
        const fail = () => {
          database.close();
          reject(tx.error ?? new Error('Local project storage failed.'));
        };
        tx.onerror = fail;
        tx.onabort = fail;
      })
  );
}

export function saveLocalProject(document: ProjectDocument): Promise<void> {
  return transaction('readwrite', (store) => store.put(document)).then(
    () => undefined
  );
}

export function loadLocalProject(
  projectId: string
): Promise<ProjectDocument | null> {
  return transaction<ProjectDocument | undefined>(
    'readonly',
    (store) => store.get(projectId) as IDBRequest<ProjectDocument | undefined>
  ).then((document) => document ?? null);
}

export function listLocalProjects(): Promise<ProjectSummary[]> {
  return transaction<ProjectDocument[]>(
    'readonly',
    (store) => store.getAll() as IDBRequest<ProjectDocument[]>
  ).then((documents) =>
    documents
      .map((document) => ({
        projectId: document.projectId,
        name: document.name,
        updatedAt: document.derived.updatedAt,
        revisionCount: document.checkpoints.length
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  );
}

/** Picks the canonical reopen candidate without allowing stale cloud data to hide local edits. */
export function selectProjectDocument(
  local: ProjectDocument | null,
  remote: ProjectDocument | null
): ProjectDocument | null {
  if (!local) {
    return remote;
  }
  if (!remote) {
    return local;
  }
  if (local.version !== remote.version) {
    return local.version > remote.version ? local : remote;
  }
  return local.derived.updatedAt > remote.derived.updatedAt ? local : remote;
}

export async function saveImportedProject(
  backup: ProjectBackup
): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME, 'backupFiles'], 'readwrite');
    tx.objectStore(STORE_NAME).put(backup.document);
    tx.objectStore('backupFiles').put(backup.files, backup.document.projectId);
    tx.oncomplete = () => {
      database.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      database.close();
      reject(tx.error ?? new Error('Project import storage failed.'));
    };
  });
}

export async function loadProjectBackupFiles(
  projectId: string
): Promise<BackupFile[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('backupFiles', 'readonly');
    const request = tx.objectStore('backupFiles').get(projectId);
    tx.oncomplete = () => {
      database.close();
      resolve((request.result as BackupFile[] | undefined) ?? []);
    };
    tx.onabort = tx.onerror = () => {
      database.close();
      reject(tx.error ?? new Error('Project files could not be read.'));
    };
  });
}

export async function rememberRemoteProject(projectId: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('backupFiles', 'readwrite');
    tx.objectStore('backupFiles').put(true, `remote:${projectId}`);
    tx.oncomplete = () => {
      database.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      database.close();
      reject(tx.error ?? new Error('Could not remember cloud project.'));
    };
  });
}

export async function isRemoteProject(projectId: string): Promise<boolean> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('backupFiles', 'readonly');
    const request = tx.objectStore('backupFiles').get(`remote:${projectId}`);
    tx.oncomplete = () => {
      database.close();
      resolve(request.result === true);
    };
    tx.onabort = tx.onerror = () => {
      database.close();
      reject(tx.error ?? new Error('Could not read project origin.'));
    };
  });
}
