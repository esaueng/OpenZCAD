import {
  isPurgeDue,
  MAX_LOCAL_CHECKPOINT_DOCUMENTS,
  type ArtifactId,
  type ImportedSourceReference,
  type ProjectCheckpoint,
  type ProjectDocument,
  type ProjectOrganization,
  type ProjectSummary,
  type RevisionId
} from '@openzcad/shared';
import { withoutDerivedProjection } from '@openzcad/document-core';
import type { StoredMeasurementRecord } from './measurementRecord';
import type { SourceBlobClaim } from './sourceBlobClaims';
import {
  LOCAL_PROJECT_BLOB_STORE,
  LOCAL_PROJECT_CHECKPOINT_STORE,
  LOCAL_PROJECT_CLAIM_STORE,
  LOCAL_PROJECT_DATABASE_NAME,
  LOCAL_PROJECT_DATABASE_VERSION,
  LOCAL_PROJECT_DOCUMENT_STORE
} from './localProjectSchema';

const DATABASE_NAME = LOCAL_PROJECT_DATABASE_NAME;
const STORE_NAME = LOCAL_PROJECT_DOCUMENT_STORE;
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
const BLOB_STORE_NAME = LOCAL_PROJECT_BLOB_STORE;
/**
 * Device-wide holds on source blobs, one per import run.
 *
 * The blob store is shared across tabs while each tab's in-flight state and
 * open document are private. A persisted claim closes that visibility gap: a
 * refusing import can prove a blob is abandoned instead of inferring it from
 * only the state in front of that tab.
 */
const CLAIM_STORE_NAME = LOCAL_PROJECT_CLAIM_STORE;
/**
 * Card-sized preview images, one per project. Kept here rather than derived on
 * demand because the shelf must never load a ProjectDocument: a part whose
 * source runs to hundreds of megabytes would otherwise have to be read into
 * memory in full just to draw a 360×200 tile, which is enough to take the tab
 * (and the machine) down and leave the user unable to reach their own projects.
 * Written while the project is open, where the meshes are already in memory.
 */
const THUMBNAIL_STORE_NAME = 'projectThumbnails';
/**
 * The handful of document fields the shelf actually draws, projected out of
 * each document when it is saved.
 *
 * Same reason the thumbnails store exists: the shelf must never load a
 * ProjectDocument. Reading the documents store to build these rows means
 * deserializing every mesh, every command-log entry, and any legacy inline
 * STEP text on the device at once — a spike that scales with everything the
 * user has ever imported and can take the tab down before the start screen
 * paints. A projection is a few hundred bytes and scales with nothing.
 *
 * Kept out of {@link META_STORE_NAME} because the two answer different
 * questions: this is derived from the document, while the shelf record is this
 * device's own arrangement and gets merged with the account's copy. Folding a
 * document projection into a record that travels would make it a lie on the
 * other side, exactly as it would for the sync baseline.
 */
const SUMMARY_STORE_NAME = 'projectSummaries';
/**
 * Measurements taken in View mode, per project.
 *
 * Kept out of the document for the reason `stepText` documents in
 * `packages/shared`: `syncComparableDocument` exempts only ownership, the
 * version fence and `derived`, so anything else written into a
 * `ProjectDocument` that no user typed makes an untouched project read
 * `diverged`. Measurements are also hashed into `canonicalProjectContentKey`
 * if they live there, which would invalidate the exact rebuild cache — a full
 * replay of the model's history — every time somebody measured an edge.
 *
 * Separate from the shelf record for the same reason the sync baseline is:
 * shelf state is this device's arrangement and gets merged with the account's
 * copy, while this is work the user did to the part.
 */
const MEASUREMENT_STORE_NAME = 'projectMeasurements';
/**
 * Save-state documents, so restoring one does not require the account.
 *
 * The cloud has kept a full document per explicit save since the first
 * migration, but nothing on the device did, which would have made "revert to
 * an earlier save" the one core modelling operation that stops working
 * offline — in an app whose whole premise is that the document is canonical in
 * the browser. Keyed by project and checkpoint together: one project holds
 * many, and each is written once and never updated.
 *
 * Bounded by {@link MAX_LOCAL_CHECKPOINT_DOCUMENTS} per project, and
 * deliberately far below the account's retention. The checkpoint list itself
 * lives in the document and stays complete either way; a row whose body has
 * been pruned here is still restorable from the account.
 */
const CHECKPOINT_STORE_NAME = LOCAL_PROJECT_CHECKPOINT_STORE;
const CHECKPOINT_AGE_INDEX = 'byProjectDocumentVersion';
/**
 * Version 7 shipped the measurement store and, crucially, taught every opened
 * connection to close on `versionchange`. Every version after it — 8's claims,
 * 9's save-state documents — can therefore add stores without an older tab
 * parking the upgrade: IndexedDB notifies that tab, its connection closes
 * after any in-flight transaction, and this gate proceeds.
 *
 * The shared gate and blocked timeout remain for genuinely older builds that
 * predate that handler. They turn an otherwise permanent startup hang into one
 * actionable rejection shared by every queued caller.
 */
const DATABASE_VERSION = LOCAL_PROJECT_DATABASE_VERSION;

interface ProjectMetaRecord extends ProjectOrganization {
  projectId: string;
}

/**
 * A stored summary holds only what the document says. Shelf state is merged in
 * at read time from {@link META_STORE_NAME}, so a device that has never
 * organised a project still reports "no record" rather than defaults.
 */
type ProjectSummaryRecord = Omit<ProjectSummary, 'organization'>;

export interface ProjectThumbnailRecord {
  projectId: string;
  /** `image/webp` data URL, or null for a project with no visible geometry. */
  source: string | null;
  /** Cloud artifact backing this preview, absent for a device-only render. */
  artifactId?: ArtifactId;
  /** Document version this was rendered from; only used to avoid re-renders. */
  version: number;
  updatedAt: string;
}

interface ProjectSyncRecord {
  projectId: string;
  lastSyncedVersion: number;
}

/**
 * One save state's document, filed under the checkpoint that named it. The
 * metadata is copied from that checkpoint so the row can describe itself
 * without opening the document it holds.
 */
interface ProjectCheckpointDocumentRecord {
  projectId: string;
  checkpointId: string;
  revisionId: RevisionId;
  documentVersion: number;
  createdAt: string;
  reason: string;
  document: ProjectDocument;
}

export const LOCAL_STORAGE_BLOCKED_MESSAGE =
  'Another tab has this app open on an older version of its local storage. Close the other tabs of this app, then try again.';

const DATABASE_BLOCKED_TIMEOUT_MS = 3_000;

class LocalStorageBlockedError extends Error {
  constructor() {
    super(LOCAL_STORAGE_BLOCKED_MESSAGE);
    this.name = 'LocalStorageBlockedError';
  }
}

export function isLocalStorageBlockedError(
  error: unknown
): error is LocalStorageBlockedError {
  return error instanceof LocalStorageBlockedError;
}

function createExpectedStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(STORE_NAME)) {
    database.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
  }
  if (!database.objectStoreNames.contains(META_STORE_NAME)) {
    database.createObjectStore(META_STORE_NAME, {
      keyPath: 'projectId'
    });
  }
  // Absent for every project on an upgraded database, which reads as "no
  // baseline" — the conservative answer, and the correct one: this device
  // has genuinely never recorded what it agreed with.
  if (!database.objectStoreNames.contains(SYNC_STORE_NAME)) {
    database.createObjectStore(SYNC_STORE_NAME, {
      keyPath: 'projectId'
    });
  }
  if (!database.objectStoreNames.contains(BLOB_STORE_NAME)) {
    database.createObjectStore(BLOB_STORE_NAME, {
      keyPath: 'checksumSha256'
    });
  }
  // Empty on upgrade: version-7 tabs close before this transaction begins, so
  // no import from the old schema can still be running without its tab being
  // reloaded. New imports create their claim atomically with the blob write.
  if (!database.objectStoreNames.contains(CLAIM_STORE_NAME)) {
    database.createObjectStore(CLAIM_STORE_NAME, {
      keyPath: 'claimKey'
    });
  }
  // Absent for every project on an upgraded database, which reads as "no
  // preview yet" — the shelf draws its placeholder and fills the cache the
  // next time each project is opened.
  if (!database.objectStoreNames.contains(THUMBNAIL_STORE_NAME)) {
    database.createObjectStore(THUMBNAIL_STORE_NAME, {
      keyPath: 'projectId'
    });
  }
  // Empty for every project on an upgraded database. Backfilled by
  // `listLocalProjects` one document at a time rather than here: the upgrade
  // transaction would have to read every document to fill it, which is the
  // memory spike this store exists to remove, and it would block the app from
  // opening until it finished.
  if (!database.objectStoreNames.contains(SUMMARY_STORE_NAME)) {
    database.createObjectStore(SUMMARY_STORE_NAME, {
      keyPath: 'projectId'
    });
  }
  // Absent for every project on an upgraded database, which reads as "no
  // measurements yet" — the correct answer, since nothing was recorded before
  // there was anywhere to record it.
  if (!database.objectStoreNames.contains(MEASUREMENT_STORE_NAME)) {
    database.createObjectStore(MEASUREMENT_STORE_NAME, {
      keyPath: 'projectId'
    });
  }
  // Empty on an upgraded database: the save states a project made before this
  // store existed were never kept on the device, and inventing rows for them
  // from the current document would be a lie about what they contained. The
  // history panel offers those older rows from the account, and fills in here
  // from the next explicit save onwards.
  if (!database.objectStoreNames.contains(CHECKPOINT_STORE_NAME)) {
    const checkpoints = database.createObjectStore(CHECKPOINT_STORE_NAME, {
      keyPath: ['projectId', 'checkpointId']
    });
    // Checkpoint ids are random, so the primary key says nothing about age.
    // Retention needs the oldest first, and listing what a project has stored
    // must not deserialize documents to find out — both are key-only reads
    // over this index.
    //
    // Ordered by document version rather than by timestamp: the version is the
    // project's own clock and strictly increases, while `createdAt` has
    // millisecond resolution and several saves can land inside one. Ties there
    // are broken by the random primary key, which would let retention drop a
    // newer save and keep an older one.
    checkpoints.createIndex(CHECKPOINT_AGE_INDEX, [
      'projectId',
      'documentVersion'
    ]);
  }
}

let schemaFactory: IDBFactory | null = null;
let schemaReady: Promise<void> | null = null;

/**
 * Makes the versioned open one shared gate, so a blocked upgrade settles every
 * caller rather than leaving later opens queued behind the only `blocked`
 * event the browser emits.
 */
function ensureDatabaseSchema(): Promise<void> {
  if (schemaFactory !== indexedDB) {
    // Test environments replace the factory between cases; browsers do not.
    schemaFactory = indexedDB;
    schemaReady = null;
  }
  if (schemaReady) {
    return schemaReady;
  }

  const gate = new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      if (blockedTimer !== undefined) {
        clearTimeout(blockedTimer);
      }
      return true;
    };

    request.onblocked = () => {
      if (settled || blockedTimer !== undefined) {
        return;
      }
      blockedTimer = setTimeout(() => {
        if (finish()) {
          reject(new LocalStorageBlockedError());
        }
      }, DATABASE_BLOCKED_TIMEOUT_MS);
    };
    request.onupgradeneeded = () => createExpectedStores(request.result);
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      database.close();
      if (finish()) {
        resolve();
        return;
      }
      // The caller already received the blocked rejection. The old tab has now
      // let go and this parked request completed, so the next call may retry.
      if (schemaReady === gate) {
        schemaReady = null;
      }
    };
    request.onerror = () => {
      if (finish()) {
        reject(request.error ?? new Error('IndexedDB unavailable.'));
      }
      if (schemaReady === gate) {
        schemaReady = null;
      }
    };
  });
  schemaReady = gate;
  return gate;
}

function openDatabase(): Promise<IDBDatabase> {
  return ensureDatabaseSchema().then(
    () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => createExpectedStores(request.result);
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB unavailable.'));
      })
  );
}

/** Whether this device's local project storage can be used right now. */
export type LocalStorageReadiness =
  /** Open, with every store this build expects. */
  | 'ready'
  /** Another tab still holds the previous schema open. */
  | 'blocked'
  /** No IndexedDB at all — private browsing, or storage denied. */
  | 'unavailable';

/**
 * Opens the database once, running any pending schema creation, and lets go.
 *
 * For a caller that is about to take a lock it must not still be holding if the
 * store cannot be opened at all. An import writes up to 250 MB under the commit
 * lock, so it asks this BEFORE the lock exists: a device that has no storage is
 * then turned away without the lock ever being taken, and the first-run creation
 * of the object stores happens off the lock rather than under it.
 *
 * The third answer matters during this version bump. It tells the import path
 * to stop before taking the validated-feature lock, while ordinary store
 * callers receive the same distinguishable rejection from the shared gate.
 */
export function ensureLocalProjectStorage(): Promise<LocalStorageReadiness> {
  return openDatabase().then(
    (database) => {
      database.close();
      return 'ready' as const;
    },
    (error: unknown) =>
      isLocalStorageBlockedError(error) ? 'blocked' : 'unavailable'
  );
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
 * Runs `action` inside ONE transaction over `storeNames` and resolves with its
 * value once that transaction commits.
 *
 * `action` may await each request and issue the next from its result: a request
 * started while an earlier one's success handler is still on the microtask
 * queue joins the same transaction, so read-then-write stays a single atomic
 * unit. Splitting it across two transactions would not — every tab and the
 * geometry worker share these stores, and another writer can land in between.
 *
 * Several stores in one transaction is the same guarantee widened: a document
 * and the shelf projection derived from it have to move together, or the start
 * screen describes a version of the project that is not on disk.
 *
 * The two lines at the bottom are the whole of the failure contract, and
 * neither is visible in the records a successful run leaves behind:
 *
 * - `tx.abort()` rolls back what `action` already wrote before it threw. A
 *   request that errors aborts the transaction by itself; a THROW from
 *   `action`'s own code does not, and without this the writes that preceded it
 *   commit on behalf of a decision that was never reached.
 * - `database.close()` gives the connection back on every path. One connection
 *   per transaction is one leaked per autosave and one per shelf read, and it
 *   stays invisible until some future schema version cannot upgrade past it.
 */
function scopedTransaction<T>(
  mode: IDBTransactionMode,
  storeNames: readonly string[],
  action: (store: (name: string) => IDBObjectStore) => Promise<T>
): Promise<T> {
  return openDatabase().then(async (database) => {
    const tx = database.transaction(
      storeNames.length === 1 ? storeNames[0]! : [...storeNames],
      mode
    );
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
      const value = await action((name) => tx.objectStore(name));
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

function transactionScope<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => Promise<T>,
  storeName: string = STORE_NAME
): Promise<T> {
  return scopedTransaction(mode, [storeName], (store) =>
    action(store(storeName))
  );
}

function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE_NAME
): Promise<T> {
  return transactionScope(mode, (store) => settled(action(store)), storeName);
}

/**
 * Runs `action` against several stores in one transaction, so the records it
 * touches move together or not at all. `action` may read as well as write; its
 * requests are awaited by the transaction itself, and the resolved value is
 * whatever `read` reports once every request has completed.
 *
 * The fire-and-continue shape {@link scopedTransaction} does not have: `action`
 * issues its requests without awaiting them and hands back a `read` closure,
 * which is called only after the transaction commits. Callers that need to
 * branch on a result mid-transaction want `scopedTransaction` instead.
 */
function multiStoreTransaction<T = void>(
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  action: (stores: Record<string, IDBObjectStore>) => (() => T) | void
): Promise<T> {
  return scopedTransaction(mode, storeNames, async (store) =>
    action(Object.fromEntries(storeNames.map((name) => [name, store(name)])))
  ).then((read) => (read ? read() : (undefined as T)));
}

interface SourceBlobRecord {
  checksumSha256: string;
  body: Blob;
  logicalBytes: number;
  createdAt: string;
}

interface SourceBlobClaimRecord extends SourceBlobClaim {
  /** Both identities in the key make each import run exactly one record. */
  claimKey: string;
}

function sourceBlobClaimKey(checksumSha256: string, claimId: string): string {
  return `${checksumSha256}:${claimId}`;
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Reads a blob whole, reporting bytes as they arrive when anyone is listening.
 *
 * Streamed rather than buffered because `arrayBuffer()` is one opaque call
 * that can run for seconds on a 250 MB import, and the progress card has
 * nothing to show for that stretch otherwise. The destination is allocated
 * once at the blob's declared size and chunks are written into it, so peak
 * memory matches `arrayBuffer()` rather than doubling it by concatenating.
 *
 * Anything unexpected — no `stream()` (older engines, and the plain objects
 * tests use as files), or a stream whose length disagrees with `size` — falls
 * back to `arrayBuffer()`. Progress is presentation; the bytes are not.
 */
async function readBlobBytes(
  source: Blob,
  onBytesRead?: (read: number, total: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if ((!onBytesRead && !signal) || typeof source.stream !== 'function') {
    signal?.throwIfAborted();
    return new Uint8Array(await source.arrayBuffer());
  }
  const total = source.size;
  const bytes = new Uint8Array(total);
  let read = 0;
  const reader = source.stream().getReader();
  try {
    for (;;) {
      // Between chunks, which is the only place this loop can be stopped
      // without leaving a half-filled buffer to be hashed.
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (read + value.byteLength > total) {
        // The blob grew, or `size` lied. Neither should happen; take the
        // safe path rather than throwing inside an import.
        return new Uint8Array(await source.arrayBuffer());
      }
      bytes.set(value, read);
      read += value.byteLength;
      onBytesRead?.(read, total);
    }
  } finally {
    // Cancels the underlying source too, so an abandoned read stops pulling
    // from disk instead of running to completion behind the caller's back.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return read === total ? bytes : new Uint8Array(await source.arrayBuffer());
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
  source: Blob | Uint8Array<ArrayBuffer>,
  options: {
    claimId?: string;
    /** Read progress, for a caller with somewhere to show it. */
    onBytesRead?(read: number, total: number): void;
    /**
     * Stops the read between chunks. Aborting here writes nothing at all —
     * the record is put in a single transaction after the whole blob has been
     * read and hashed, so there is no partial state to undo.
     */
    signal?: AbortSignal;
  } = {}
): Promise<StoredSourceBlob> {
  const bytes =
    source instanceof Uint8Array
      ? source
      : await readBlobBytes(source, options.onBytesRead, options.signal);
  const checksumSha256 = await sha256Hex(bytes);
  // Hashing 250 MB takes about 0.2 s, and the transaction below is the point
  // of no return for this key, so it is worth one more check.
  options.signal?.throwIfAborted();
  const createdAt = new Date().toISOString();
  const record: SourceBlobRecord = {
    checksumSha256,
    body: source instanceof Blob ? source : new Blob([bytes]),
    logicalBytes: bytes.byteLength,
    createdAt
  };
  const created = await scopedTransaction(
    'readwrite',
    [BLOB_STORE_NAME, CLAIM_STORE_NAME],
    async (store) => {
      if (options.claimId !== undefined) {
        const claim: SourceBlobClaimRecord = {
          claimKey: sourceBlobClaimKey(checksumSha256, options.claimId),
          checksumSha256,
          claimId: options.claimId,
          createdAt
        };
        await settled(store(CLAIM_STORE_NAME).put(claim));
      }
      const blobs = store(BLOB_STORE_NAME);
      if ((await settled(blobs.count(checksumSha256))) > 0) {
        return false;
      }
      await settled(blobs.put(record));
      return true;
    }
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

/** Gives up one import run's device-wide hold on a checksum. */
export function releaseSourceBlobClaim(
  checksumSha256: string,
  claimId: string
): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.delete(sourceBlobClaimKey(checksumSha256, claimId)),
    CLAIM_STORE_NAME
  ).then(() => undefined);
}

/**
 * Deletes one source blob only when the whole device says it is abandoned.
 *
 * Claims, every persisted project document, and the delete share one readwrite
 * transaction. No other tab can land a claim or autosave a document in a gap
 * between the proof and the deletion. Documents are cursor-walked one at a time
 * because each can carry large derived meshes; the walk stops on the first
 * reference.
 *
 * The asking run's own claim does not block its cleanup and is removed with the
 * blob. Expired claims are swept opportunistically. `false` is a safe verdict,
 * not a storage failure: some live claim or saved document still needs bytes.
 */
export interface SourceBlobDeleteInput {
  checksumSha256: string;
  claimId?: string;
  now?: number;
}

export function deleteSourceBlobIfUnreferenced(
  input: SourceBlobDeleteInput
): Promise<boolean> {
  // Refused-import cleanup is rare and walks persisted project documents. Keep
  // it off first paint; a failed chunk load is caught by the caller and leaves
  // bytes in place, which is the no-data-loss direction.
  return import('./sourceBlobCleanup').then((cleanup) => cleanup.run(input));
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
    (store) =>
      store.get(checksumSha256) as IDBRequest<SourceBlobRecord | undefined>,
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

/**
 * The shelf's view of a document. The single definition of that projection:
 * what {@link saveLocalProject} persists and what a backfill reproduces have to
 * agree, or the start screen shows one thing and opening the project another.
 */
export function summarizeProjectDocument(
  document: ProjectDocument
): ProjectSummaryRecord {
  return {
    projectId: document.projectId,
    name: document.name,
    lastRevisionId: document.revisions.at(-1)?.revisionId,
    updatedAt: document.derived.updatedAt,
    revisionCount: document.checkpoints.length,
    documentVersion: document.version
  };
}

/**
 * Stores a document and refreshes its shelf projection in the same
 * transaction. Split across two, a crash between them leaves the start screen
 * describing a version of the project that is no longer on disk — and since
 * nothing else reads the documents store on that path, nothing would ever
 * notice the disagreement.
 */
export function saveLocalProject(document: ProjectDocument): Promise<void> {
  return scopedTransaction(
    'readwrite',
    [STORE_NAME, SUMMARY_STORE_NAME, CHECKPOINT_STORE_NAME],
    async (store) => {
      store(STORE_NAME).put(document);
      store(SUMMARY_STORE_NAME).put(summarizeProjectDocument(document));
      // Inspected here rather than before the transaction opens, so a document
      // this function cannot make sense of still fails where it always did —
      // inside, with the writes above rolled back — instead of throwing early
      // and leaving the store's rollback contract untested. The checkpoint
      // store is in scope on every save for the same reason: the decision is
      // made after the scope is fixed.
      const saveState = unstoredSaveState(document);
      if (saveState) {
        await putSaveState(store(CHECKPOINT_STORE_NAME), document, saveState);
      }
    }
  );
}

/**
 * The checkpoint this document *is*, if it holds one.
 *
 * `createCheckpoint` stamps the version it was taken at and does not advance
 * it, so a document whose newest checkpoint names its current version is that
 * save state exactly — not an edited descendant of it. One edit later the
 * versions differ and this reports nothing, which is what keeps an ordinary
 * autosave from writing a snapshot body every 450ms.
 */
function unstoredSaveState(
  document: ProjectDocument
): ProjectCheckpoint | null {
  const latest = document.checkpoints.at(-1);
  return latest && latest.documentVersion === document.version ? latest : null;
}

async function putSaveState(
  store: IDBObjectStore,
  document: ProjectDocument,
  checkpoint: ProjectCheckpoint
): Promise<void> {
  // Each save state is written once and never revised, so an existing row is
  // already the right bytes. Counted rather than read: the value here is a
  // whole document, and re-reading one on the save path is the cost this
  // guard exists to avoid.
  const stored = await settled(
    store.count([document.projectId, checkpoint.checkpointId])
  );
  if (stored > 0) {
    return;
  }
  const record: ProjectCheckpointDocumentRecord = {
    projectId: document.projectId,
    checkpointId: checkpoint.checkpointId,
    revisionId: checkpoint.revisionId,
    documentVersion: checkpoint.documentVersion,
    createdAt: checkpoint.createdAt,
    reason: checkpoint.reason,
    // Meshes are a projection the kernel rebuilds from this very history, so
    // storing them here would multiply the largest part of the document across
    // every save state to buy nothing.
    document: withoutDerivedProjection(document)
  };
  store.put(record);
  await pruneSaveStates(store, document.projectId);
}

/**
 * Drops a project's oldest stored save states beyond the cap.
 *
 * Key-only cursor: the point is to delete documents without loading them.
 */
async function pruneSaveStates(
  store: IDBObjectStore,
  projectId: string
): Promise<void> {
  const index = store.index(CHECKPOINT_AGE_INDEX);
  const oldestFirst = await settled(
    index.getAllKeys(checkpointKeyRange(projectId))
  );
  const excess = oldestFirst.length - MAX_LOCAL_CHECKPOINT_DOCUMENTS;
  for (let position = 0; position < excess; position += 1) {
    store.delete(oldestFirst[position]!);
  }
}

/**
 * Every key under one project, in the primary key's space and the age index's
 * alike. Both bounds are arrays because the keys are: `[projectId]` sorts below
 * every `[projectId, value]`, and an empty array sorts above every number and
 * string, so the pair spans exactly this project's rows whichever of the two
 * the second component holds.
 */
function checkpointKeyRange(projectId: string): IDBKeyRange {
  return IDBKeyRange.bound([projectId], [projectId, []]);
}

/**
 * One stored save state's document, or null when this device does not hold it.
 *
 * Null is ordinary rather than exceptional: retention prunes bodies while the
 * checkpoints naming them stay in the document, and a project that predates
 * this store has none of its older save states here at all. The caller falls
 * back to the account copy.
 */
export function loadLocalSaveState(
  projectId: string,
  checkpointId: string
): Promise<ProjectDocument | null> {
  return transaction<ProjectCheckpointDocumentRecord | undefined>(
    'readonly',
    (store) =>
      store.get([projectId, checkpointId]) as IDBRequest<
        ProjectCheckpointDocumentRecord | undefined
      >,
    CHECKPOINT_STORE_NAME
  ).then((record) => record?.document ?? null);
}

/**
 * Which of a project's save states this device can open without the network.
 * Key-only, so a project with dense imported geometry costs the same as any
 * other to ask about.
 */
export function listLocalSaveStateIds(
  projectId: string
): Promise<Set<string>> {
  return transactionScope(
    'readonly',
    async (store) => {
      const keys = await settled(
        store.getAllKeys(checkpointKeyRange(projectId))
      );
      return new Set(
        keys
          .map((key) => (Array.isArray(key) ? key[1] : undefined))
          .filter((checkpointId): checkpointId is string =>
            typeof checkpointId === 'string'
          )
      );
    },
    CHECKPOINT_STORE_NAME
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
  const copiedFromRevisionId = duplicate.revisions.at(-2)?.revisionId;
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
  thumbnail: {
    source: string | null;
    artifactId?: ArtifactId;
    version: number;
    updatedAt: string;
  }
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
 * Writes this project's measurements, replacing whatever was there.
 *
 * The whole record at once rather than row-by-row: the list is small, it is
 * always read whole, and a partial write is a state the reader would have to
 * be taught to distinguish from a genuinely short list.
 */
export function saveProjectMeasurements(
  record: StoredMeasurementRecord
): Promise<void> {
  return transaction(
    'readwrite',
    (store) => store.put(record),
    MEASUREMENT_STORE_NAME
  ).then(() => undefined);
}

/**
 * This project's measurements, or null when there are none to read.
 *
 * Parsed rather than cast. A record from a newer build is refused whole — see
 * `parseStoredMeasurements` for why reading it partially would be worse than
 * not reading it — and a single malformed row is dropped without taking the
 * rest of the list with it.
 */
export function loadProjectMeasurements(
  projectId: string
): Promise<StoredMeasurementRecord | null> {
  return transaction<unknown>(
    'readonly',
    (store) => store.get(projectId) as IDBRequest<unknown>,
    MEASUREMENT_STORE_NAME
  ).then(async (value) => {
    if (value === undefined) {
      return null;
    }
    // The defensive parser is sizeable and needed only on this read path. Keep
    // it out of the initial workspace bundle; writes use the small codec in
    // `measurementRecord` directly.
    const { parseStoredMeasurements } = await import('./measurementStore');
    const parsed = parseStoredMeasurements(value);
    if (!parsed) {
      // Refusing a future or malformed record is only protective if the caller
      // cannot mistake it for "there was no record" and immediately write an
      // empty current-version one over it.
      throw new Error(
        'Stored measurements use an unsupported or malformed format.'
      );
    }
    return parsed;
  });
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
 * Destroys a project's document, its shelf state, its shelf projection, its
 * cached preview, and its sync baseline in a single transaction.
 *
 * Split across several, a crash between them can leave a baseline behind that
 * describes a document this device no longer holds. Should that project id
 * come back — re-adoption, or a fresh download of the account copy — the
 * surviving baseline is consumed as agreement about a lineage that ended, and
 * reconciliation picks a side instead of reporting the divergence. A surviving
 * projection is the same failure in the other direction: a start-screen tile
 * for a project that cannot be opened.
 */
export function deleteLocalProject(projectId: string): Promise<void> {
  // Every per-project store, in one transaction. A store missing from this
  // list is not merely untidy: `adoptProjectDocument` reuses a project id, so
  // an orphaned record would surface under a DIFFERENT project that later
  // claimed the same id.
  const storeNames = [
    STORE_NAME,
    META_STORE_NAME,
    SYNC_STORE_NAME,
    THUMBNAIL_STORE_NAME,
    SUMMARY_STORE_NAME,
    MEASUREMENT_STORE_NAME
  ];
  return multiStoreTransaction(
    [...storeNames, CHECKPOINT_STORE_NAME],
    'readwrite',
    (stores) => {
      for (const storeName of storeNames) {
        stores[storeName]?.delete(projectId);
      }
      // Keyed by project *and* checkpoint, so this one takes a range rather
      // than the bare id — and it matters for the reason above: adoption
      // reuses project ids, and a left-behind save state would offer one
      // project's model as another's history.
      stores[CHECKPOINT_STORE_NAME]?.delete(checkpointKeyRange(projectId));
    }
  );
}

/**
 * Which projects exist and which of them already have a projection, read
 * together so the two cannot disagree. Only the documents store's *keys* are
 * read — no document value is deserialized, which is the whole point.
 */
function readShelfSnapshot(): Promise<{
  projectIds: string[];
  summaries: Map<string, ProjectSummaryRecord>;
}> {
  return multiStoreTransaction(
    [STORE_NAME, SUMMARY_STORE_NAME],
    'readonly',
    (stores) => {
      const keys = stores[STORE_NAME]?.getAllKeys();
      const records = stores[SUMMARY_STORE_NAME]?.getAll() as
        IDBRequest<ProjectSummaryRecord[]> | undefined;
      return () => ({
        projectIds: (keys?.result ?? []).filter(
          (key): key is string => typeof key === 'string'
        ),
        summaries: new Map(
          (records?.result ?? []).map((record) => [record.projectId, record])
        )
      });
    }
  );
}

/**
 * Writes the shelf projection for one document that predates the projections
 * store, and returns it. Deliberately one document at a time: holding even a
 * few of these open at once reintroduces the spike the store exists to avoid,
 * and this runs at most once per project on the first refresh after upgrading.
 *
 * The recheck, document read, and summary write share one transaction. Another
 * tab may save the project after the shelf snapshot found no summary; without
 * the recheck it would be needlessly deserialized, and without the shared
 * transaction a stale backfill could land after that save and replace its newer
 * projection.
 */
function backfillProjectSummary(
  projectId: string
): Promise<ProjectSummaryRecord | null> {
  let record: ProjectSummaryRecord | null = null;
  return multiStoreTransaction(
    [STORE_NAME, SUMMARY_STORE_NAME],
    'readwrite',
    (stores) => {
      const documentStore = stores[STORE_NAME];
      const summaryStore = stores[SUMMARY_STORE_NAME];
      if (!documentStore || !summaryStore) {
        throw new Error('Local project storage is incomplete.');
      }

      const existing = summaryStore.get(projectId) as IDBRequest<
        ProjectSummaryRecord | undefined
      >;
      existing.onsuccess = () => {
        if (existing.result) {
          record = existing.result;
          return;
        }
        const document = documentStore.get(projectId) as IDBRequest<
          ProjectDocument | undefined
        >;
        document.onsuccess = () => {
          if (!document.result) {
            return;
          }
          record = summarizeProjectDocument(document.result);
          summaryStore.put(record);
        };
      };
      return () => record;
    }
  );
}

/**
 * The shelf rows for every project on this device, read from the projections
 * store rather than from the documents themselves. A document is only opened
 * when it has no projection yet, and then one at a time — see
 * {@link SUMMARY_STORE_NAME}.
 */
export async function listLocalProjects(): Promise<ProjectSummary[]> {
  const [snapshot, organizations] = await Promise.all([
    readShelfSnapshot(),
    listLocalProjectOrganizations().catch(
      () => new Map<string, ProjectOrganization>()
    )
  ]);
  const projects: ProjectSummary[] = [];
  // Driven by the document keys, not by the projections: a projection whose
  // document is gone describes a project that cannot be opened, so it is
  // ignored rather than drawn as a tile that leads nowhere.
  for (const projectId of snapshot.projectIds) {
    const summary =
      snapshot.summaries.get(projectId) ??
      // A document this device cannot read is skipped rather than allowed to
      // fail the whole listing, which would empty the shelf over one bad
      // record. The next refresh tries it again.
      (await backfillProjectSummary(projectId).catch(() => null));
    if (!summary) {
      continue;
    }
    const organization = organizations.get(projectId);
    projects.push({
      ...summary,
      // Left undefined when this device has never organised the project, so a
      // merge can fall back to whatever the account knows instead of treating
      // "no record" as "active, unpinned, first".
      ...(organization ? { organization } : {})
    });
  }
  return projects;
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

/** Reuses derived geometry only when it describes the same canonical model. */
export function withMatchingLocalDerived(
  remote: ProjectDocument,
  local: ProjectDocument
): ProjectDocument {
  if (!projectMatchesInterruptedAdoption(local, remote)) {
    return remote;
  }
  return {
    ...remote,
    derived: {
      ...remote.derived,
      bodyRepresentations: local.derived.bodyRepresentations,
      exportableBodyIds: local.derived.exportableBodyIds
    }
  };
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
