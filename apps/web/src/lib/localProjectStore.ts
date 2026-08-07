import {
  isPurgeDue,
  type ImportedSourceReference,
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
/**
 * Import source bytes (STEP text today), keyed by content checksum rather than
 * by project: the same uploaded file referenced from two projects is stored
 * once, and a reference in a document is satisfiable by any record whose bytes
 * hash to its checksum. Values are Blobs so the browser can keep hundreds of
 * megabytes on disk instead of in structured-clone memory.
 */
const BLOB_STORE_NAME = 'sourceBlobs';
/**
 * Card-sized preview images, one per project. Kept here rather than derived on
 * demand because the shelf must never load a ProjectDocument: a part whose
 * source runs to hundreds of megabytes would otherwise have to be read into
 * memory in full just to draw a 360×200 tile, which is enough to take the tab
 * (and the machine) down and leave the user unable to reach their own projects.
 * Written while the project is open, where the meshes are already in memory.
 */
const THUMBNAIL_STORE_NAME = 'projectThumbnails';
const DATABASE_VERSION = 5;

interface ProjectMetaRecord extends ProjectOrganization {
  projectId: string;
}

interface ProjectThumbnailRecord {
  projectId: string;
  /** `image/webp` data URL, or null for a project with no visible geometry. */
  source: string | null;
  /** Document version this was rendered from; only used to avoid re-renders. */
  version: number;
  updatedAt: string;
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
      if (!request.result.objectStoreNames.contains(BLOB_STORE_NAME)) {
        request.result.createObjectStore(BLOB_STORE_NAME, {
          keyPath: 'checksumSha256'
        });
      }
      // Absent for every project on an upgraded database, which reads as "no
      // preview yet" — the shelf draws its placeholder and fills the cache the
      // next time each project is opened.
      if (!request.result.objectStoreNames.contains(THUMBNAIL_STORE_NAME)) {
        request.result.createObjectStore(THUMBNAIL_STORE_NAME, {
          keyPath: 'projectId'
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB unavailable.'));
  });
}

/** Settles when one request inside an open transaction has its result. */
function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Local project storage failed.'));
  });
}

/**
 * Runs `action` inside ONE transaction and resolves with its value once that
 * transaction commits.
 *
 * `action` may await each request and issue the next from its result: a request
 * started while an earlier one's success handler is still on the microtask
 * queue joins the same transaction, so read-then-write stays a single atomic
 * unit. Splitting it across two transactions would not — every tab and the
 * geometry worker share these stores, and another writer can land in between.
 */
function transactionScope<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => Promise<T>,
  storeName: string = STORE_NAME
): Promise<T> {
  return openDatabase().then(async (database) => {
    const tx = database.transaction(storeName, mode);
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      const fail = () =>
        reject(tx.error ?? new Error('Local project storage failed.'));
      tx.onerror = fail;
      tx.onabort = fail;
    });
    // The rejection is reported through the throw below; this only keeps it
    // from also surfacing as an unhandled rejection when `action` fails first.
    committed.catch(() => undefined);
    try {
      const value = await action(tx.objectStore(storeName));
      await committed;
      return value;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already committed or aborted; the error below is the real report.
      }
      throw error;
    } finally {
      database.close();
    }
  });
}

function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE_NAME
): Promise<T> {
  return transactionScope(mode, (store) => settled(action(store)), storeName);
}

interface SourceBlobRecord {
  checksumSha256: string;
  body: Blob;
  logicalBytes: number;
  createdAt: string;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

export interface StoredSourceBlob {
  ref: ImportedSourceReference;
  /**
   * False when the store already held these exact bytes. The store is
   * device-global and content-addressed, so a key can be reached from several
   * projects: a caller that may have to undo its write — an import the kernel
   * might refuse — must not delete bytes that were already there.
   */
  created: boolean;
}

/**
 * Stores source bytes and reports whether this call is what created the
 * record. The checksum is computed here — callers cannot store bytes under a
 * wrong identity, so readers never need to re-verify local records.
 *
 * The "does it exist" question and the write are ONE readwrite transaction.
 * Asking in a separate transaction would let two importers of the same file
 * both be told they created the record — and `created` is exactly what
 * licenses an import to delete those bytes again, so both would then believe
 * the key was theirs to remove.
 *
 * A key that is already present is left untouched rather than rewritten: the
 * store is content-addressed, so the record there holds these very bytes, and
 * rewriting it would copy up to 250 MB to disk to change nothing but a
 * timestamp.
 */
export async function putSourceBlobIfAbsent(
  source: Blob | Uint8Array<ArrayBuffer>
): Promise<StoredSourceBlob> {
  const bytes =
    source instanceof Uint8Array
      ? source
      : new Uint8Array(await source.arrayBuffer());
  const checksumSha256 = await sha256Hex(bytes);
  const record: SourceBlobRecord = {
    checksumSha256,
    body: source instanceof Blob ? source : new Blob([bytes]),
    logicalBytes: bytes.byteLength,
    createdAt: new Date().toISOString()
  };
  const created = await transactionScope(
    'readwrite',
    async (store) => {
      if ((await settled(store.count(checksumSha256))) > 0) {
        return false;
      }
      await settled(store.put(record));
      return true;
    },
    BLOB_STORE_NAME
  );
  return {
    ref: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256,
      logicalBytes: bytes.byteLength
    },
    created
  };
}

/** {@link putSourceBlobIfAbsent} for callers that never delete what they wrote. */
export async function putSourceBlob(
  source: Blob | Uint8Array<ArrayBuffer>
): Promise<ImportedSourceReference> {
  return (await putSourceBlobIfAbsent(source)).ref;
}

export async function loadSourceBlob(
  checksumSha256: string
): Promise<Uint8Array | null> {
  const record = await transaction<SourceBlobRecord | undefined>(
    'readonly',
    (store) => store.get(checksumSha256) as IDBRequest<SourceBlobRecord | undefined>,
    BLOB_STORE_NAME
  );
  if (!record) {
    return null;
  }
  return new Uint8Array(await record.body.arrayBuffer());
}

export function hasSourceBlob(checksumSha256: string): Promise<boolean> {
  return transaction<number>(
    'readonly',
    (store) => store.count(checksumSha256),
    BLOB_STORE_NAME
  ).then((count) => count > 0);
}

/**
 * Removes exactly one blob. Content-addressed storage means the key can be
 * shared, so the caller owns the reference check — see
 * `discardUnreferencedImportSource`.
 */
export function deleteSourceBlob(checksumSha256: string): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.delete(checksumSha256),
    BLOB_STORE_NAME
  ).then(() => undefined);
}

/**
 * Removes every blob whose checksum is not in `referencedChecksums`. Callers
 * assemble the referenced set from every local document plus any in-flight
 * import, so a sweep during an import must be avoided by the caller, not here.
 */
export async function pruneUnreferencedSourceBlobs(
  referencedChecksums: ReadonlySet<string>
): Promise<string[]> {
  const keys = await transaction<IDBValidKey[]>(
    'readonly',
    (store) => store.getAllKeys(),
    BLOB_STORE_NAME
  );
  const removed: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') {
      continue;
    }
    const checksum = key;
    if (!referencedChecksums.has(checksum)) {
      await transaction(
        'readwrite',
        (store) => store.delete(checksum),
        BLOB_STORE_NAME
      );
      removed.push(checksum);
    }
  }
  return removed;
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

/**
 * Restores the cached geometry of a cloud-created duplicate from its source.
 *
 * Cloud documents intentionally omit derived meshes. A duplicate adds a
 * checkpoint without changing geometry or the latest revision, so the source
 * projection is reusable only when that revision still matches this device's
 * source. The guard prevents a stale local cache from being shown for a copy
 * the account made from newer canonical history.
 */
export function restoreDuplicateDerivedProjection(
  duplicate: ProjectDocument,
  localSource: ProjectDocument | null
): ProjectDocument {
  const copiedFromRevisionId = duplicate.revisions.at(-1)?.revisionId;
  const localRevisionId = localSource?.revisions.at(-1)?.revisionId;
  if (
    !localSource ||
    !copiedFromRevisionId ||
    localRevisionId !== copiedFromRevisionId
  ) {
    return duplicate;
  }
  return {
    ...duplicate,
    derived: {
      ...duplicate.derived,
      bodyRepresentations: localSource.derived.bodyRepresentations,
      exportableBodyIds: localSource.derived.exportableBodyIds
    }
  };
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
 * Stores a project's card preview. Called while the project is open, where the
 * meshes are already in memory — the shelf itself never renders one, because
 * doing so would mean loading the document.
 */
export function saveProjectThumbnail(
  projectId: string,
  thumbnail: { source: string | null; version: number; updatedAt: string }
): Promise<void> {
  const record: ProjectThumbnailRecord = { projectId, ...thumbnail };
  return transaction(
    'readwrite',
    (store) => store.put(record),
    THUMBNAIL_STORE_NAME
  ).then(() => undefined);
}

/**
 * The cached preview for one project, or null when this device has never
 * rendered it. A stale image is deliberately preferred over loading the
 * document to refresh it: the tile is a recognition aid, not a source of truth.
 */
export function loadProjectThumbnail(
  projectId: string
): Promise<ProjectThumbnailRecord | null> {
  return transaction<ProjectThumbnailRecord | undefined>(
    'readonly',
    (store) =>
      store.get(projectId) as IDBRequest<ProjectThumbnailRecord | undefined>,
    THUMBNAIL_STORE_NAME
  ).then((record) => record ?? null);
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
  ).then(() => undefined);
}

/**
 * Forgets every sync baseline. Used when the account session ends, so the next
 * account on this device never reconciles against the previous one's history:
 * an unknown baseline is safe (reconciliation reports instead of assuming
 * agreement), a stale one can silently overwrite the newer side.
 *
 * Rejects rather than resolving quietly when the clear fails. A caller that
 * cannot tell a cleared baseline from a surviving one has no way to warn about
 * the reconciliation that surviving baseline will later distort.
 */
export function clearAllLastSyncedVersions(): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.clear(),
    SYNC_STORE_NAME
  ).then(() => undefined);
}

/**
 * Destroys a project's document, its shelf state, its cached preview, and its
 * sync baseline in a single transaction.
 *
 * Split across three, a crash between them can leave a baseline behind that
 * describes a document this device no longer holds. Should that project id
 * come back — re-adoption, or a fresh download of the account copy — the
 * surviving baseline is consumed as agreement about a lineage that ended, and
 * reconciliation picks a side instead of reporting the divergence.
 */
export function deleteLocalProject(projectId: string): Promise<void> {
  const storeNames = [
    STORE_NAME,
    META_STORE_NAME,
    SYNC_STORE_NAME,
    THUMBNAIL_STORE_NAME
  ];
  return openDatabase().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const tx = database.transaction(storeNames, 'readwrite');
        for (const storeName of storeNames) {
          tx.objectStore(storeName).delete(projectId);
        }
        tx.oncomplete = () => {
          database.close();
          resolve();
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

/**
 * The part of a document whose equality means that the two copies contain the
 * same user work. Account ownership and the monotonic version fence are sync
 * metadata, while `derived` is rebuilt from canonical history on load; none of
 * the three should turn an otherwise identical project into a conflict.
 */
function syncComparableDocument(document: ProjectDocument): unknown {
  const {
    ownerUserId: _ownerUserId,
    version: _version,
    derived: _derived,
    ...canonical
  } = document;
  return canonical;
}

/** JSON-equivalent structural equality without depending on object key order. */
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  // JSON drops undefined object properties. Treat an in-memory optional field
  // and its round-tripped absence as the same persisted document.
  const leftKeys = Object.keys(leftRecord).filter(
    (key) => leftRecord[key] !== undefined
  );
  const rightKeys = Object.keys(rightRecord).filter(
    (key) => rightRecord[key] !== undefined
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        rightRecord[key] !== undefined &&
        jsonValuesEqual(leftRecord[key], rightRecord[key])
    )
  );
}

export function projectsHaveSameCanonicalContent(
  local: ProjectDocument,
  remote: ProjectDocument
): boolean {
  return jsonValuesEqual(
    syncComparableDocument(local),
    syncComparableDocument(remote)
  );
}

/**
 * A retry can observe the server-side adoption checkpoint after the first
 * response was lost. That one known metadata-only addition is not a divergent
 * edit; accepting the account copy completes the interrupted adoption.
 */
export function projectMatchesInterruptedAdoption(
  local: ProjectDocument,
  remote: ProjectDocument
): boolean {
  if (projectsHaveSameCanonicalContent(local, remote)) {
    return true;
  }
  const adoptionCheckpoint = remote.checkpoints.at(-1);
  if (
    adoptionCheckpoint?.reason !== 'Saved to account' ||
    adoptionCheckpoint.documentVersion !== remote.version ||
    remote.checkpoints.length !== local.checkpoints.length + 1
  ) {
    return false;
  }
  return projectsHaveSameCanonicalContent(local, {
    ...remote,
    checkpoints: remote.checkpoints.slice(0, -1)
  });
}

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
  // Content equality (including the one known interrupted-adoption shape) is
  // stronger evidence than a version number. Prefer the account copy so its
  // ownership and version fence become this device's new baseline while the
  // caller can keep the local derived projection.
  if (projectMatchesInterruptedAdoption(local, remote)) {
    return { choice: 'remote', document: remote };
  }
  if (lastSyncedVersion !== null) {
    const localMoved = local.version !== lastSyncedVersion;
    const remoteMoved = remote.version !== lastSyncedVersion;
    if (localMoved && remoteMoved) {
      return { choice: 'diverged', local, remote };
    }
    if (localMoved) {
      return { choice: 'local', document: local };
    }
    if (remoteMoved) {
      return { choice: 'remote', document: remote };
    }
    // Both copies still claim the baseline version but their canonical content
    // differs. Version equality is not agreement; neither side may be dropped.
    return { choice: 'diverged', local, remote };
  }
  // Clearing browser storage loses the only proof of which copy moved. Treat
  // different canonical documents as divergent regardless of their version
  // numbers; guessing here is the silent-data-loss path ADR-016 forbids.
  return { choice: 'diverged', local, remote };
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
