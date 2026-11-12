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
    if (index) store.put({ ...index, usedAt: now });
    await completed;
  });
}

/**
 * Stores a project's session in place of any earlier one, then evicts the
 * least recently used others until the count and byte bounds hold. Resolves
 * false, storing nothing, when the session alone exceeds its bound.
 */
export function saveKernelSession(
  entry: Omit<KernelSessionIndexRecord, 'savedAt' | 'usedAt'> & {
    session: PersistedHistorySession;
  },
  now = Date.now()
): Promise<boolean> {
  if (entry.bytes > MAX_KERNEL_SESSION_BYTES) {
    return deleteKernelSession(entry.projectId).then(() => false);
  }
  return withDatabase(async (database) => {
    const transaction = database.transaction(
      [INDEX_STORE, SESSION_STORE],
      'readwrite'
    );
    const completed = done(transaction);
    const indexStore = transaction.objectStore(INDEX_STORE);
    const sessionStore = transaction.objectStore(SESSION_STORE);
    const others = (
      (await request(indexStore.getAll())) as KernelSessionIndexRecord[]
    )
      .filter((record) => record.projectId !== entry.projectId)
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

/** Forgets a project's session; the project itself is untouched. */
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

/** The stored sessions' index rows, for tests and diagnostics. */
export function listKernelSessions(): Promise<KernelSessionIndexRecord[]> {
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
