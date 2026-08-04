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
/**
 * The version this device and the account last agreed on, per project. Kept in
 * its own store rather than beside the shelf state: the two answer different
 * questions, and folding a sync baseline into a record that gets merged with
 * the account's copy of the shelf would let one device's baseline travel to
 * another, where it would be a lie.
 */
const SYNC_STORE_NAME = 'projectSync';
const DATABASE_VERSION = 3;

interface ProjectMetaRecord extends ProjectOrganization {
  projectId: string;
}

interface ProjectSyncRecord {
  projectId: string;
  lastSyncedVersion: number;
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
      // Absent for every project on an upgraded database, which reads as "no
      // baseline" — the conservative answer, and the correct one: this device
      // has genuinely never recorded what it agreed with.
      if (!request.result.objectStoreNames.contains(SYNC_STORE_NAME)) {
        request.result.createObjectStore(SYNC_STORE_NAME, {
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

/**
 * Records that this device and the account now hold the same version of
 * `projectId`. Everything the conflict machinery decides is measured from here.
 */
export function saveLastSyncedVersion(
  projectId: string,
  lastSyncedVersion: number
): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.put({ projectId, lastSyncedVersion }),
    SYNC_STORE_NAME
  ).then(() => undefined);
}

/** Null when this device has no record — which is not the same as zero. */
export function loadLastSyncedVersion(
  projectId: string
): Promise<number | null> {
  return transaction<ProjectSyncRecord | undefined>(
    'readonly',
    (store) =>
      store.get(projectId) as IDBRequest<ProjectSyncRecord | undefined>,
    SYNC_STORE_NAME
  )
    .then((record) => record?.lastSyncedVersion ?? null)
    .catch(() => null);
}

/**
 * Forgets the baseline for `projectId`, so the next reconciliation treats it as
 * unknown rather than as agreement. Used when the account copy goes away under
 * this device — signing out of an account that held it, say.
 */
export function clearLastSyncedVersion(projectId: string): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.delete(projectId),
    SYNC_STORE_NAME
  )
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Forgets every sync baseline. Used when the account session ends, so the next
 * account on this device never reconciles against the previous one's history:
 * an unknown baseline is safe (reconciliation reports instead of assuming
 * agreement), a stale one can silently overwrite the newer side.
 */
export function clearAllLastSyncedVersions(): Promise<void> {
  return transaction('readwrite', (store) => store.clear(), SYNC_STORE_NAME)
    .then(() => undefined)
    .catch(() => undefined);
}

/** Destroys a project's document, its shelf state, and its sync baseline. */
export function deleteLocalProject(projectId: string): Promise<void> {
  return transaction('readwrite', (store) => store.delete(projectId))
    .then(() =>
      transaction(
        'readwrite',
        (store) => store.delete(projectId),
        META_STORE_NAME
      )
    )
    .then(() => clearLastSyncedVersion(projectId))
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
      documentVersion: document.version,
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

/**
 * What opening a project should do about its two copies.
 *
 * `diverged` exists because picking a winner is not always honest. Comparing
 * versions and then timestamps cannot tell a device that is behind from two
 * devices that both moved, and it settles the second case by discarding one
 * side on the authority of a device clock. Reporting the ambiguity instead lets
 * the caller write a recovery copy and ask.
 */
export type ProjectOpenChoice =
  | { choice: 'none' }
  | { choice: 'local'; document: ProjectDocument }
  | { choice: 'remote'; document: ProjectDocument }
  | {
      choice: 'diverged';
      local: ProjectDocument;
      remote: ProjectDocument;
    };

export function chooseProjectDocument(
  local: ProjectDocument | null,
  remote: ProjectDocument | null,
  lastSyncedVersion: number | null = null
): ProjectOpenChoice {
  if (!local) {
    return remote ? { choice: 'remote', document: remote } : { choice: 'none' };
  }
  if (!remote) {
    return { choice: 'local', document: local };
  }
  if (local.version === remote.version) {
    return { choice: 'local', document: local };
  }
  if (lastSyncedVersion !== null) {
    const localMoved = local.version !== lastSyncedVersion;
    const remoteMoved = remote.version !== lastSyncedVersion;
    if (localMoved && remoteMoved) {
      return { choice: 'diverged', local, remote };
    }
    return localMoved
      ? { choice: 'local', document: local }
      : { choice: 'remote', document: remote };
  }
  // No baseline: fall back to the newer version, as before. It is a guess, but
  // it is the guess that keeps the most work, and the caller still writes a
  // recovery copy of the side it does not take.
  return local.version > remote.version
    ? { choice: 'local', document: local }
    : { choice: 'remote', document: remote };
}

/**
 * The winning document only. Callers that can act on divergence should use
 * {@link chooseProjectDocument} instead — this collapses that case to "keep the
 * local copy", which is safe but silently drops the account's.
 */
export function selectProjectDocument(
  local: ProjectDocument | null,
  remote: ProjectDocument | null,
  lastSyncedVersion: number | null = null
): ProjectDocument | null {
  const outcome = chooseProjectDocument(local, remote, lastSyncedVersion);
  switch (outcome.choice) {
    case 'none':
      return null;
    case 'diverged':
      return outcome.local;
    default:
      return outcome.document;
  }
}
