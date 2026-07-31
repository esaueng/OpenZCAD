import {
  isPurgeDue,
  type ProjectDocument,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';

const DATABASE_NAME = 'openzcad-v2';
const STORE_NAME = 'projects';
/**
 * Shelf state (archive, bin, pin, manual order) lives beside the documents
 * rather than inside them: it describes the owner's desk, not the part, and a
 * document synced from another device must not drag this device's arrangement
 * along with it.
 */
const META_STORE_NAME = 'projectMeta';
const DATABASE_VERSION = 2;

interface ProjectMetaRecord extends ProjectOrganization {
  projectId: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
      }
      if (!request.result.objectStoreNames.contains(META_STORE_NAME)) {
        request.result.createObjectStore(META_STORE_NAME, {
          keyPath: 'projectId'
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB unavailable.'));
  });
}

function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE_NAME
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, mode);
        const request = action(tx.objectStore(storeName));
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

export function saveLocalProjectOrganization(
  projectId: string,
  organization: ProjectOrganization
): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.put({ ...organization, projectId }),
    META_STORE_NAME
  ).then(() => undefined);
}

export function listLocalProjectOrganizations(): Promise<
  Map<string, ProjectOrganization>
> {
  return transaction<ProjectMetaRecord[]>(
    'readonly',
    (store) => store.getAll() as IDBRequest<ProjectMetaRecord[]>,
    META_STORE_NAME
  ).then(
    (records) =>
      new Map(
        records.map(({ projectId, ...organization }) => [
          projectId,
          organization
        ])
      )
  );
}

/** Destroys a project's document and its shelf state. Irreversible. */
export function deleteLocalProject(projectId: string): Promise<void> {
  return transaction('readwrite', (store) => store.delete(projectId))
    .then(() =>
      transaction(
        'readwrite',
        (store) => store.delete(projectId),
        META_STORE_NAME
      )
    )
    .then(() => undefined);
}

export async function listLocalProjects(): Promise<ProjectSummary[]> {
  const [documents, organizations] = await Promise.all([
    transaction<ProjectDocument[]>(
      'readonly',
      (store) => store.getAll() as IDBRequest<ProjectDocument[]>
    ),
    listLocalProjectOrganizations().catch(
      () => new Map<string, ProjectOrganization>()
    )
  ]);
  return documents.map((document) => {
    const organization = organizations.get(document.projectId);
    return {
      projectId: document.projectId,
      name: document.name,
      lastRevisionId: document.revisions.at(-1)?.revisionId,
      updatedAt: document.derived.updatedAt,
      revisionCount: document.checkpoints.length,
      // Left undefined when this device has never organised the project, so a
      // merge can fall back to whatever the account knows instead of treating
      // "no record" as "active, unpinned, first".
      ...(organization ? { organization } : {})
    };
  });
}

/**
 * Destroys local projects whose retention window has run out, and returns the
 * ids that were purged. Called on every start-screen refresh — retention is
 * measured in days, so a check at arrival is timely enough and the browser has
 * nowhere to run a scheduled job anyway.
 */
export async function purgeExpiredLocalProjects(
  now = Date.now(),
  excludedProjectIds: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const organizations = await listLocalProjectOrganizations();
  const expired = [...organizations.entries()]
    .filter(
      ([projectId, organization]) =>
        !excludedProjectIds.has(projectId) &&
        organization.status === 'deleted' &&
        isPurgeDue(organization.deletedAt, now)
    )
    .map(([projectId]) => projectId);
  for (const projectId of expired) {
    await deleteLocalProject(projectId);
  }
  return expired;
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
