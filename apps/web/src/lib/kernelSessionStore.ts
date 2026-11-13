/**
 * Persisted kernel sessions: what lets a reopened project become editable
 * without replaying its feature history (see
 * `packages/kernel-adapter/src/exact-session-snapshot.ts`).
 *
 * A session is a cache of derived state, never project data:
 *
 * - It lives in its own database, not in the project database, so nothing
 *   that reads project data — backups, data downloads, account sync, sharing
 *   with collaborators, identity transfers — can see it. Only the geometry
 *   worker reads and writes it; deleting a project deletes its session.
 * - Each record names the exact document content and the exact build that
 *   wrote it (app commit, Remus package version and commit, kernel snapshot
 *   identity). Anything else is a miss, and the worker replays.
 * - It is bounded: one session per project, at most
 *   {@link MAX_KERNEL_SESSION_BYTES} each and {@link MAX_KERNEL_SESSIONS} /
 *   {@link MAX_KERNEL_SESSION_TOTAL_BYTES} in all, least recently used first
 *   out.
 * - Only the current user's own local projects get one: the worker stores
 *   and offers sessions only for syncs the app marks `persistSession`, never
 *   for a shared link's model or someone else's project.
 * - Two kinds of byte-free marker rows share the index (at most
 *   {@link MAX_KERNEL_SESSION_MARKERS}, never counted against the session
 *   bounds). A *rejected* marker names a content and build whose session
 *   failed to restore, so it is not written again only to be rejected on
 *   every reopen. A *retired* marker is left by {@link retireKernelSession}
 *   when the project is deleted: a capture still in flight then finds it in
 *   its own write transaction and stores nothing, for
 *   {@link KERNEL_SESSION_RETIRED_HOLD_MS}.
 *
 * Local project data is stored unencrypted on this device, and a session is
 * derived only from that same document, so it is stored the same way.
 */
import type { PersistedHistorySession } from '@openzcad/kernel-adapter/exact';

export const KERNEL_SESSION_DATABASE_NAME = 'openzcad-kernel-sessions';
const DATABASE_VERSION = 1;
/** Small rows: what eviction and matching read without the session bytes. */
const INDEX_STORE = 'sessionIndex';
const SESSION_STORE = 'sessions';

/** A larger session is not stored; that project replays on reopen. */
export const MAX_KERNEL_SESSION_BYTES = 48 * 1024 * 1024;
export const MAX_KERNEL_SESSION_TOTAL_BYTES = 160 * 1024 * 1024;
export const MAX_KERNEL_SESSIONS = 8;
/** Rejected and retired markers kept at most, oldest first out. */
export const MAX_KERNEL_SESSION_MARKERS = 64;
/**
 * How long a deleted project refuses new sessions: far longer than any
 * capture can be in flight (an idle wait and the write throttle, seconds),
 * and short enough that a project id brought back later (re-adopted, or
 * downloaded again from the account) gets sessions again.
 */
export const KERNEL_SESSION_RETIRED_HOLD_MS = 10 * 60 * 1000;

export interface KernelSessionIndexRecord {
  projectId: string;
  /** `geometryContentKey` of the document the session was built for. */
  contentKey: string;
  /** {@link kernelSessionIdentity} of the build that wrote it. */
  identity: string;
  /** Accounted bytes of the session. */
  bytes: number;
  savedAt: number;
  usedAt: number;
  /** A byte-free marker row rather than a session (see the module notes). */
  marker?: 'rejected' | 'retired';
}

interface KernelSessionRecord {
  projectId: string;
  session: PersistedHistorySession;
}

/**
 * Everything that must match for a stored session to be offered: this app
 * build (the adapter's builders), the Remus package (its version and the
 * commit it was built from) and the snapshot identity of the kernel itself.
 * Null when any part is unknown: such a build never stores or offers one.
 */
export function kernelSessionIdentity(parts: {
  appCommit: string | undefined;
  remusVersion: string | undefined;
  remusCommit: string | undefined;
  kernelBuildId: string | null;
}): string | null {
  const values = [
    parts.appCommit,
    parts.remusVersion,
    parts.remusCommit,
    parts.kernelBuildId
  ];
  return values.every(
    (value): value is string =>
      typeof value === 'string' && value !== '' && value !== 'unknown'
  )
    ? JSON.stringify(values)
    : null;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () =>
      reject(operation.error ?? new Error('Kernel session storage failed.'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('Kernel session storage failed.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable.'));
      return;
    }
    const opening = indexedDB.open(
      KERNEL_SESSION_DATABASE_NAME,
      DATABASE_VERSION
    );
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(INDEX_STORE))
        database.createObjectStore(INDEX_STORE, { keyPath: 'projectId' });
      if (!database.objectStoreNames.contains(SESSION_STORE))
        database.createObjectStore(SESSION_STORE, { keyPath: 'projectId' });
    };
    opening.onsuccess = () => {
      const database = opening.result;
      // A later version in another tab must never wait on this one.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    opening.onerror = () =>
      reject(opening.error ?? new Error('IndexedDB unavailable.'));
    opening.onblocked = () =>
      reject(new Error('Kernel session storage is blocked.'));
  });
}

async function withDatabase<T>(
  work: (database: IDBDatabase) => Promise<T>
): Promise<T> {
  const database = await openDatabase();
  try {
    return await work(database);
  } finally {
    database.close();
  }
}

/**
 * The stored session for this exact content and build, or null. A stored
 * session for anything else is left for {@link saveKernelSession} to replace.
 */
export function loadKernelSession(
  projectId: string,
  contentKey: string,
  identity: string
): Promise<PersistedHistorySession | null> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(
      [INDEX_STORE, SESSION_STORE],
      'readonly'
    );
    const completed = done(transaction);
    const index = (await request(
      transaction.objectStore(INDEX_STORE).get(projectId)
    )) as KernelSessionIndexRecord | undefined;
    let session: PersistedHistorySession | null = null;
    if (
      index &&
      !index.marker &&
      index.contentKey === contentKey &&
      index.identity === identity
    ) {
      const record = (await request(
        transaction.objectStore(SESSION_STORE).get(projectId)
      )) as KernelSessionRecord | undefined;
      session = record?.session ?? null;
    }
    await completed;
    return session;
  });
}

/** Marks a session as just used, so eviction keeps it longest. */
export function touchKernelSession(
  projectId: string,
  now = Date.now()
): Promise<void> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(INDEX_STORE, 'readwrite');
    const completed = done(transaction);
    const store = transaction.objectStore(INDEX_STORE);
    const index = (await request(store.get(projectId))) as
      KernelSessionIndexRecord | undefined;
    if (index && !index.marker) store.put({ ...index, usedAt: now });
    await completed;
  });
}

/**
 * Whether `index` refuses a session of this content and build: a deleted
 * project still within its hold, or the same content and build that was
 * rejected before.
 */
function refuses(
  index: KernelSessionIndexRecord | undefined,
  contentKey: string,
  identity: string,
  now: number
): boolean {
  if (index?.marker === 'retired')
    return now - index.savedAt < KERNEL_SESSION_RETIRED_HOLD_MS;
  return (
    index?.marker === 'rejected' &&
    index.contentKey === contentKey &&
    index.identity === identity
  );
}

/** Drops the oldest markers past {@link MAX_KERNEL_SESSION_MARKERS}. */
function pruneMarkers(
  indexStore: IDBObjectStore,
  rows: readonly KernelSessionIndexRecord[],
  keep: KernelSessionIndexRecord | null
): void {
  const markers = rows
    .filter((row) => row.marker && row.projectId !== keep?.projectId)
    .sort((a, b) => b.usedAt - a.usedAt);
  const room = MAX_KERNEL_SESSION_MARKERS - (keep?.marker ? 1 : 0);
  for (const row of markers.slice(Math.max(0, room)))
    indexStore.delete(row.projectId);
}

/**
 * Stores a project's session in place of any earlier one, then evicts the
 * least recently used others until the count and byte bounds hold. Resolves
 * false, storing nothing, when the session alone exceeds its bound (any
 * older session of the project goes too), when the project was deleted
 * moments ago, or when this content and build were rejected before.
 */
export function saveKernelSession(
  entry: Omit<KernelSessionIndexRecord, 'savedAt' | 'usedAt' | 'marker'> & {
    session: PersistedHistorySession;
  },
  now = Date.now()
): Promise<boolean> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(
      [INDEX_STORE, SESSION_STORE],
      'readwrite'
    );
    const completed = done(transaction);
    const indexStore = transaction.objectStore(INDEX_STORE);
    const sessionStore = transaction.objectStore(SESSION_STORE);
    const rows = (await request(
      indexStore.getAll()
    )) as KernelSessionIndexRecord[];
    const current = rows.find((row) => row.projectId === entry.projectId);
    if (refuses(current, entry.contentKey, entry.identity, now)) {
      await completed;
      return false;
    }
    if (entry.bytes > MAX_KERNEL_SESSION_BYTES) {
      // The older session no longer describes the project either.
      if (current && !current.marker) {
        indexStore.delete(entry.projectId);
        sessionStore.delete(entry.projectId);
      }
      await completed;
      return false;
    }
    const others = rows
      .filter((row) => !row.marker && row.projectId !== entry.projectId)
      .sort((a, b) => b.usedAt - a.usedAt);
    const kept: KernelSessionIndexRecord[] = [];
    let total = entry.bytes;
    for (const record of others) {
      if (
        kept.length + 1 < MAX_KERNEL_SESSIONS &&
        total + record.bytes <= MAX_KERNEL_SESSION_TOTAL_BYTES
      ) {
        kept.push(record);
        total += record.bytes;
      } else {
        indexStore.delete(record.projectId);
        sessionStore.delete(record.projectId);
      }
    }
    const index: KernelSessionIndexRecord = {
      projectId: entry.projectId,
      contentKey: entry.contentKey,
      identity: entry.identity,
      bytes: entry.bytes,
      savedAt: now,
      usedAt: now
    };
    sessionStore.put({
      projectId: entry.projectId,
      session: entry.session
    } satisfies KernelSessionRecord);
    indexStore.put(index);
    await completed;
    return true;
  });
}

/** Writes a marker row in place of the project's session, if any. */
function markKernelSession(
  marker: NonNullable<KernelSessionIndexRecord['marker']>,
  projectId: string,
  contentKey: string,
  identity: string,
  now: number
): Promise<void> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(
      [INDEX_STORE, SESSION_STORE],
      'readwrite'
    );
    const completed = done(transaction);
    const indexStore = transaction.objectStore(INDEX_STORE);
    const rows = (await request(
      indexStore.getAll()
    )) as KernelSessionIndexRecord[];
    const current = rows.find((row) => row.projectId === projectId);
    transaction.objectStore(SESSION_STORE).delete(projectId);
    // A rejection never shortens a deleted project's hold.
    const record: KernelSessionIndexRecord =
      marker === 'rejected' && refuses(current, contentKey, identity, now)
        ? current!
        : {
            projectId,
            contentKey,
            identity,
            bytes: 0,
            savedAt: now,
            usedAt: now,
            marker
          };
    indexStore.put(record);
    pruneMarkers(indexStore, rows, record);
    await completed;
  });
}

/**
 * A stored session of this content and build failed to restore: drops it
 * and keeps it from being stored again, so every reopen does not pay a
 * restore before its replay. Other content (any edit) or another build
 * stores normally, replacing the marker.
 */
export function rejectKernelSession(
  projectId: string,
  contentKey: string,
  identity: string,
  now = Date.now()
): Promise<void> {
  return markKernelSession('rejected', projectId, contentKey, identity, now);
}

/**
 * The project was deleted: drops its session (and any rejection marker),
 * and refuses any capture of it still in flight (see
 * {@link KERNEL_SESSION_RETIRED_HOLD_MS}).
 */
export function retireKernelSession(
  projectId: string,
  now = Date.now()
): Promise<void> {
  return markKernelSession('retired', projectId, '', '', now);
}

/** Forgets a project's session and markers; the project is untouched. */
export function deleteKernelSession(projectId: string): Promise<void> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(
      [INDEX_STORE, SESSION_STORE],
      'readwrite'
    );
    const completed = done(transaction);
    transaction.objectStore(INDEX_STORE).delete(projectId);
    transaction.objectStore(SESSION_STORE).delete(projectId);
    await completed;
  });
}

/**
 * Every index row, markers included, for tests and diagnostics; see
 * {@link listKernelSessions} for the stored sessions alone.
 */
export function listKernelSessionRows(): Promise<KernelSessionIndexRecord[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(INDEX_STORE, 'readonly');
    const completed = done(transaction);
    const rows = (await request(
      transaction.objectStore(INDEX_STORE).getAll()
    )) as KernelSessionIndexRecord[];
    await completed;
    return rows;
  });
}

/** The stored sessions' index rows, for tests and diagnostics. */
export async function listKernelSessions(): Promise<
  KernelSessionIndexRecord[]
> {
  return (await listKernelSessionRows()).filter((row) => !row.marker);
}
