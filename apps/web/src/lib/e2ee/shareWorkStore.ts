/** Durable, account-scoped share follow-ups. Keys are stored only wrapped. */
import type { ShareLinkMode } from '@openzcad/crypto';

export interface ShareWorkLink {
  readonly shareId: string;
  readonly mode: ShareLinkMode;
}

export interface PendingShareCreation extends ShareWorkLink {
  readonly ownerIdentityHash: string;
  readonly shareKeyHash: string;
  readonly keyEpoch: number;
  /** Project-key-wrapped share key, with the existing share-key context. */
  readonly wrapped: string;
  readonly sourceId: string | null;
}

export interface ShareWork {
  readonly notice: string | null;
  readonly removalEpoch: number;
  readonly removalLinks: readonly ShareWorkLink[];
  readonly retired: readonly ShareWorkLink[];
  readonly pending: readonly PendingShareCreation[];
  readonly replacements: readonly { sourceId: string; shareId: string }[];
}

export interface ShareWorkStore {
  read(userId: string, projectId: string): Promise<ShareWork>;
  update(
    userId: string,
    projectId: string,
    change: (current: ShareWork) => ShareWork
  ): Promise<ShareWork>;
}

const empty = (): ShareWork => ({
  notice: null,
  removalEpoch: -1,
  removalLinks: [],
  retired: [],
  pending: [],
  replacements: []
});
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const link = (value: unknown): value is ShareWorkLink => {
  const entry = value as Partial<ShareWorkLink> | null;
  return (
    !!entry &&
    text(entry.shareId) &&
    (entry.mode === 'view' || entry.mode === 'tweak')
  );
};
function pendingCreation(value: unknown): value is PendingShareCreation {
  const entry = value as Partial<PendingShareCreation> | null;
  return (
    link(value) &&
    !!entry &&
    text(entry.ownerIdentityHash) &&
    text(entry.shareKeyHash) &&
    typeof entry.keyEpoch === 'number' &&
    Number.isSafeInteger(entry.keyEpoch) &&
    entry.keyEpoch >= 0 &&
    text(entry.wrapped, 2048) &&
    (entry.sourceId === null || text(entry.sourceId))
  );
}
function replacement(
  value: unknown
): value is { sourceId: string; shareId: string } {
  const entry = value as { sourceId?: unknown; shareId?: unknown } | null;
  return !!entry && text(entry.sourceId) && text(entry.shareId);
}

function readWork(value: unknown): ShareWork {
  if (value === undefined) return empty();
  const work: Partial<ShareWork> | null =
    typeof value === 'object' ? value : null;
  if (
    !work ||
    typeof work.removalEpoch !== 'number' ||
    !Number.isSafeInteger(work.removalEpoch) ||
    work.removalEpoch < -1 ||
    (work.notice !== null && !text(work.notice)) ||
    (work.removalLinks !== undefined &&
      (!Array.isArray(work.removalLinks) ||
        work.removalLinks.length > 256 ||
        !work.removalLinks.every(link))) ||
    !Array.isArray(work.retired) ||
    work.retired.length > 256 ||
    !work.retired.every(link) ||
    !Array.isArray(work.pending) ||
    work.pending.length > 256 ||
    !work.pending.every(pendingCreation) ||
    !Array.isArray(work.replacements) ||
    work.replacements.length > 256 ||
    !work.replacements.every(replacement)
  ) {
    throw new Error('Saved share-link work is invalid. Nothing was discarded.');
  }
  return structuredClone({
    ...work,
    removalLinks: work.removalLinks ?? []
  } as ShareWork);
}

export function memoryShareWorkStore(): ShareWorkStore {
  const records = new Map<string, ShareWork>();
  const id = (userId: string, projectId: string) =>
    JSON.stringify([userId, projectId]);
  return {
    read: async (userId, projectId) =>
      readWork(records.get(id(userId, projectId))),
    update: async (userId, projectId, change) => {
      const key = id(userId, projectId);
      const next = readWork(change(readWork(records.get(key))));
      records.set(key, next);
      return readWork(next);
    }
  };
}

export const SHARE_WORK_DATABASE = 'openzcad-e2ee-share-work';
let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_WORK_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('work');
    request.onerror = () => {
      opening = undefined;
      reject(request.error ?? new Error('Share-link work did not open.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
  });
  return opening;
}

export function indexedDbShareWorkStore(): ShareWorkStore {
  async function run(
    userId: string,
    projectId: string,
    change?: (current: ShareWork) => ShareWork
  ): Promise<ShareWork> {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('work', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('work');
      const key = [userId, projectId];
      const request = store.get(key);
      let result = empty();
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const current = readWork(request.result);
          result = change ? readWork(change(current)) : current;
          if (change) store.put(result, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(
          failure instanceof Error
            ? failure
            : (tx.error ?? new Error('Share-link work could not be saved.'))
        );
    });
  }
  return {
    read: (user, project) => run(user, project),
    update: (user, project, change) => run(user, project, change)
  };
}

let shared: ShareWorkStore | undefined;
export function shareWorkStore(): ShareWorkStore {
  return (shared ??=
    typeof indexedDB === 'undefined'
      ? memoryShareWorkStore()
      : indexedDbShareWorkStore());
}

const queue = new Map<string, Promise<unknown>>();
export async function withShareWorkLock<T>(
  userId: string,
  projectId: string,
  work: () => Promise<T>
): Promise<T> {
  const name = `openzcad-e2ee-share-work:${userId}:${projectId}`;
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(name, work);
  const previous = queue.get(name) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  queue.set(name, next);
  try {
    return await next;
  } finally {
    if (queue.get(name) === next) queue.delete(name);
  }
}
