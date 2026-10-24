/**
 * This device's MLS state in IndexedDB (ADR-024 Phase 3: "sealed MLS client
 * state in IndexedDB"), in a database of its own so the device-key database
 * (`openzcad-e2ee`, `deviceStore.ts`) and its schema version stay untouched.
 *
 * - `stateKeys`: one non-extractable AES-256-GCM key per account. IndexedDB
 *   stores it by structured clone, so script never reads its bytes; every
 *   session is sealed under it inside the MLS Worker.
 * - `sessions`: per (account, project), the sealed session bytes, the leaf
 *   key and its certification (public; the directory and later the room
 *   need them), the bytes of a Commit the room has not ruled on yet, and a
 *   local revision counter.
 *
 * Two tabs must never fork a project's MLS state: both would build a Commit
 * for the same epoch from the same secrets, and whichever lost would hold a
 * session the group has left behind. Every change therefore runs under a
 * per-project Web Lock and is written with compare-and-swap on the revision
 * in one readwrite transaction; a stale writer is refused and re-reads.
 */

export interface StoredPendingCommit {
  readonly commit: Uint8Array;
  readonly welcome: Uint8Array | null;
}

export interface StoredLeaf {
  readonly signatureKey: Uint8Array;
  readonly certification: Uint8Array;
}

export interface StoredMlsSession {
  readonly userId: string;
  readonly projectId: string;
  readonly deviceId: string;
  /** 1 for the first write, then +1 per write. */
  readonly revision: number;
  readonly sealed: Uint8Array;
  readonly leaf: StoredLeaf;
  /** Persisted before the Commit is sent, so a reload can resend or drop it. */
  readonly pendingCommit: StoredPendingCommit | null;
}

export type MlsSessionWrite = Omit<StoredMlsSession, 'revision'>;

export interface MlsSessionStore {
  loadStateKey(userId: string): Promise<CryptoKey | null>;
  /** Keep the existing key when two tabs create one at once. */
  getOrCreateStateKey(userId: string, candidate: CryptoKey): Promise<CryptoKey>;
  loadSession(
    userId: string,
    projectId: string
  ): Promise<StoredMlsSession | null>;
  /**
   * Write only if the stored revision is still `expectedRevision` (0: no
   * session yet). Returns the stored record, or null when another context
   * wrote first; the caller must then re-read. When `isCurrent` returns
   * false inside the write (the key session ended), nothing is written and
   * the promise rejects.
   */
  writeSessionIfCurrent(
    expectedRevision: number,
    next: MlsSessionWrite,
    isCurrent?: () => boolean
  ): Promise<StoredMlsSession | null>;
  /**
   * Forget one account's MLS state on this device: its state key and every
   * sealed session, so nothing here can reopen its projects. Holds the
   * account lock exclusively, so it waits for project operations already
   * running in any tab and removes what they wrote.
   */
  deleteAccount(userId: string): Promise<void>;
  /**
   * Every project operation holds its account's lock shared; deletion holds
   * it exclusively. Taken before the project lock.
   */
  withAccountLock<T>(
    userId: string,
    mode: 'shared' | 'exclusive',
    run: () => Promise<T>
  ): Promise<T>;
  /** Serialize every operation on one project's MLS state across tabs. */
  withProjectLock<T>(
    userId: string,
    projectId: string,
    run: () => Promise<T>
  ): Promise<T>;
}

export class MlsSessionConflict extends Error {
  override readonly name = 'MlsSessionConflict';
  constructor() {
    super('This project’s encryption state changed in another tab. Try again.');
  }
}

function copyRecord(record: StoredMlsSession): StoredMlsSession {
  return {
    userId: record.userId,
    projectId: record.projectId,
    deviceId: record.deviceId,
    revision: record.revision,
    sealed: new Uint8Array(record.sealed),
    leaf: {
      signatureKey: new Uint8Array(record.leaf.signatureKey),
      certification: new Uint8Array(record.leaf.certification)
    },
    pendingCommit: record.pendingCommit
      ? {
          commit: new Uint8Array(record.pendingCommit.commit),
          welcome: record.pendingCommit.welcome
            ? new Uint8Array(record.pendingCommit.welcome)
            : null
        }
      : null
  };
}

const keySessionEnded = () =>
  new Error('The key session ended before the MLS state was written.');

function nextRecord(
  current: StoredMlsSession | undefined,
  expectedRevision: number,
  next: MlsSessionWrite
): StoredMlsSession | null {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('An MLS session revision is a non-negative integer.');
  }
  if ((current?.revision ?? 0) !== expectedRevision) return null;
  return copyRecord({ ...next, revision: expectedRevision + 1 });
}

const projectLockName = (userId: string, projectId: string) =>
  `openzcad-e2ee-mls:${JSON.stringify([userId, projectId])}`;
const accountLockName = (userId: string) =>
  `openzcad-e2ee-mls-account:${JSON.stringify(userId)}`;

/** A shared/exclusive account lock within one realm (the memory store). */
function memoryAccountLocks() {
  const locks = new Map<
    string,
    { tail: Promise<void>; readers: Set<Promise<void>> }
  >();
  const settle = (active: Promise<unknown>) =>
    active.then(
      () => {},
      () => {}
    );
  return <T>(
    userId: string,
    mode: 'shared' | 'exclusive',
    run: () => Promise<T>
  ): Promise<T> => {
    let lock = locks.get(userId);
    if (!lock) {
      lock = { tail: Promise.resolve(), readers: new Set() };
      locks.set(userId, lock);
    }
    if (mode === 'shared') {
      const active = lock.tail.then(run);
      const settled = settle(active);
      const readers = lock.readers;
      readers.add(settled);
      void settled.then(() => readers.delete(settled));
      return active;
    }
    const active = Promise.all([lock.tail, ...lock.readers]).then(run);
    lock.tail = settle(active);
    return active;
  };
}

/** Tests, and a store whose contexts share one JavaScript realm. */
export function memoryMlsSessionStore(): MlsSessionStore {
  const keys = new Map<string, CryptoKey>();
  const sessions = new Map<string, StoredMlsSession>();
  const locks = new Map<string, Promise<void>>();
  const withAccountLock = memoryAccountLocks();
  const id = (userId: string, projectId: string) =>
    JSON.stringify([userId, projectId]);
  return {
    loadStateKey: async (userId) => keys.get(userId) ?? null,
    getOrCreateStateKey: async (userId, candidate) => {
      const existing = keys.get(userId);
      if (existing) return existing;
      keys.set(userId, candidate);
      return candidate;
    },
    loadSession: async (userId, projectId) => {
      const record = sessions.get(id(userId, projectId));
      return record ? copyRecord(record) : null;
    },
    writeSessionIfCurrent: async (expectedRevision, next, isCurrent) => {
      if (isCurrent && !isCurrent()) throw keySessionEnded();
      const key = id(next.userId, next.projectId);
      const record = nextRecord(sessions.get(key), expectedRevision, next);
      if (!record) return null;
      sessions.set(key, record);
      return copyRecord(record);
    },
    deleteAccount: (userId) =>
      withAccountLock(userId, 'exclusive', async () => {
        keys.delete(userId);
        for (const [key, record] of sessions)
          if (record.userId === userId) sessions.delete(key);
      }),
    withAccountLock,
    withProjectLock: (userId, projectId, run) => {
      const name = projectLockName(userId, projectId);
      const active = (locks.get(name) ?? Promise.resolve()).then(run);
      const settled = active.then(
        () => {},
        () => {}
      );
      locks.set(name, settled);
      return active.finally(() => {
        if (locks.get(name) === settled) locks.delete(name);
      });
    }
  };
}

export const MLS_DATABASE = 'openzcad-e2ee-mls';
const STATE_KEYS = 'stateKeys';
const SESSIONS = 'sessions';

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(MLS_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_KEYS)) {
        db.createObjectStore(STATE_KEYS, { keyPath: 'userId' });
      }
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: ['userId', 'projectId'] });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB did not open'));
    };
  });
  return opening;
}

/** One readwrite or readonly transaction; resolves after it commits. */
async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore, done: (value: T) => void) => void
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB MLS transaction failed'));
    run(tx.objectStore(store), (value) => {
      result = value;
    });
  });
}

export function indexedDbMlsSessionStore(): MlsSessionStore {
  return {
    loadStateKey: (userId) =>
      transact<CryptoKey | null>(STATE_KEYS, 'readonly', (objects, done) => {
        const read = objects.get(userId);
        read.onsuccess = () =>
          done((read.result as { key: CryptoKey } | undefined)?.key ?? null);
      }),
    getOrCreateStateKey: (userId, candidate) =>
      transact<CryptoKey>(STATE_KEYS, 'readwrite', (objects, done) => {
        const read = objects.get(userId);
        read.onsuccess = () => {
          const existing = (read.result as { key: CryptoKey } | undefined)?.key;
          if (existing) {
            done(existing);
            return;
          }
          objects.add({ userId, key: candidate });
          done(candidate);
        };
      }),
    loadSession: (userId, projectId) =>
      transact<StoredMlsSession | null>(
        SESSIONS,
        'readonly',
        (objects, done) => {
          const read = objects.get([userId, projectId]);
          read.onsuccess = () => {
            const record = read.result as StoredMlsSession | undefined;
            done(record ? copyRecord(record) : null);
          };
        }
      ),
    writeSessionIfCurrent: (expectedRevision, next, isCurrent) => {
      // Snapshot before the first await: the caller may reuse its buffers.
      const value = copyRecord({ ...next, revision: 0 });
      return transact<StoredMlsSession | null>(
        SESSIONS,
        'readwrite',
        (objects, done) => {
          // IndexedDB serializes readwrite transactions across connections
          // and tabs, so the revision read here is the one this write
          // replaces.
          const read = objects.get([value.userId, value.projectId]);
          read.onsuccess = () => {
            // Decided inside the transaction, so a teardown that lands
            // before this point leaves the stored state untouched.
            if (isCurrent && !isCurrent()) {
              objects.transaction.abort();
              return;
            }
            const record = nextRecord(
              read.result as StoredMlsSession | undefined,
              expectedRevision,
              value
            );
            if (record) objects.put(record);
            done(record);
          };
        }
      );
    },
    deleteAccount: async (userId) => {
      // Without IndexedDB this store never held anything to forget.
      if (typeof indexedDB === 'undefined') return;
      const forget = async () => {
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STATE_KEYS, SESSIONS], 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () =>
            reject(tx.error ?? new Error('IndexedDB MLS transaction failed'));
          tx.objectStore(STATE_KEYS).delete(userId);
          // Every [userId, projectId] key: a string sorts below any array.
          tx.objectStore(SESSIONS).delete(
            IDBKeyRange.bound([userId], [userId, []])
          );
        });
      };
      // Without Web Locks no project operation can run here (the locks
      // refuse), so there is nothing to wait for.
      if (typeof navigator === 'undefined' || !navigator.locks) return forget();
      return navigator.locks.request(
        accountLockName(userId),
        { mode: 'exclusive' },
        forget
      );
    },
    withAccountLock: async (userId, mode, run) => {
      if (typeof navigator === 'undefined' || !navigator.locks)
        throw new Error(
          'This browser cannot safely coordinate encrypted projects across tabs.'
        );
      return navigator.locks.request(
        accountLockName(userId),
        { mode },
        async () => run()
      );
    },
    withProjectLock: async (userId, projectId, run) => {
      if (typeof navigator === 'undefined' || !navigator.locks)
        throw new Error(
          'This browser cannot safely coordinate encrypted projects across tabs.'
        );
      return navigator.locks.request(
        projectLockName(userId, projectId),
        { mode: 'exclusive' },
        async () => run()
      );
    }
  };
}
