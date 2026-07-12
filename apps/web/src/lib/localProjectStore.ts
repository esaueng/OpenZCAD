import type { ProjectDocument, ProjectSummary } from '@openzcad/shared';

const DATABASE_NAME = 'openzcad-v2';
const STORE_NAME = 'projects';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
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
