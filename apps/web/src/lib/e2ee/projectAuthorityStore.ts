/** Durable owner intent and accepted authority pins, scoped to this account. */
import type { E2eeProjectAuthorityRecord } from '@openzcad/shared';

export interface ExpectedProjectOwner {
  readonly userId: string;
  readonly identityKeyHash: string;
}
export interface ProjectAuthorityPin {
  readonly hash: string;
  readonly authority: E2eeProjectAuthorityRecord;
}
export interface ProjectAuthorityLocalState {
  readonly owner: ExpectedProjectOwner | null;
  readonly accepted: ProjectAuthorityPin | null;
  readonly manifest: {
    readonly statement: string;
    readonly signature: string;
  } | null;
}
export interface ProjectAuthorityStore {
  read(userId: string, projectId: string): Promise<ProjectAuthorityLocalState>;
  update(
    userId: string,
    projectId: string,
    change: (current: ProjectAuthorityLocalState) => ProjectAuthorityLocalState
  ): Promise<ProjectAuthorityLocalState>;
  forgetProject(userId: string, projectId: string): Promise<void>;
  deleteAccount(userId: string): Promise<void>;
}
const empty = (): ProjectAuthorityLocalState => ({
  owner: null,
  accepted: null,
  manifest: null
});
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function readState(value: unknown): ProjectAuthorityLocalState {
  if (value === undefined) return empty();
  const state = value as Partial<ProjectAuthorityLocalState> | null;
  const record = state?.accepted?.authority;
  if (
    !state ||
    (state.owner !== null &&
      (!state.owner ||
        !text(state.owner.userId, 128) ||
        !hash(state.owner.identityKeyHash))) ||
    (state.manifest !== undefined &&
      state.manifest !== null &&
      (!text(state.manifest.statement, 1048576) ||
        !text(state.manifest.signature, 87))) ||
    (state.accepted !== null &&
      (!state.accepted ||
        !hash(state.accepted.hash) ||
        !record ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence < 1 ||
        !Number.isSafeInteger(record.accountKeyGeneration) ||
        record.accountKeyGeneration < 1 ||
        !Number.isSafeInteger(record.accountKeySequence) ||
        record.accountKeySequence < 0 ||
        !text(record.signerDeviceId, 128) ||
        !text(record.record, 1048576) ||
        !text(record.recordMac, 43) ||
        !text(record.signature, 87)))
  )
    throw new Error(
      'Saved project authority is invalid. Its pins were preserved.'
    );
  return structuredClone({
    ...state,
    manifest: state.manifest ?? null
  } as ProjectAuthorityLocalState);
}
const id = (userId: string, projectId: string) =>
  JSON.stringify([userId, projectId]);
export function memoryProjectAuthorityStore(): ProjectAuthorityStore {
  const records = new Map<string, ProjectAuthorityLocalState>();
  return {
    read: async (user, project) => readState(records.get(id(user, project))),
    update: async (user, project, change) => {
      const key = id(user, project);
      const next = readState(change(readState(records.get(key))));
      records.set(key, next);
      return readState(next);
    },
    forgetProject: async (user, project) => {
      records.delete(id(user, project));
    },
    deleteAccount: async (user) => {
      for (const key of records.keys())
        if ((JSON.parse(key) as string[])[0] === user) records.delete(key);
    }
  };
}

export const PROJECT_AUTHORITY_DATABASE = 'openzcad-e2ee-project-authority';
let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_AUTHORITY_DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('authority');
    request.onerror = () => {
      opening = undefined;
      reject(
        request.error ?? new Error('Project authority storage did not open.')
      );
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
export function indexedDbProjectAuthorityStore(): ProjectAuthorityStore {
  async function run(
    user: string,
    project: string,
    change?: (current: ProjectAuthorityLocalState) => ProjectAuthorityLocalState
  ): Promise<ProjectAuthorityLocalState> {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('authority', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('authority');
      const request = store.get([user, project]);
      let result = empty();
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const current = readState(request.result);
          result = change ? readState(change(current)) : current;
          if (change) store.put(result, [user, project]);
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
            : (tx.error ?? new Error('Project authority storage failed.'))
        );
    });
  }
  async function erase(user: string, project?: string): Promise<void> {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      if (project !== undefined) store.delete([user, project]);
      else {
        const request = store.openKeyCursor(
          IDBKeyRange.bound([user], [user, []])
        );
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          tx.error ?? new Error('Project authority could not be forgotten.')
        );
    });
  }
  return {
    read: (user, project) => run(user, project),
    update: run,
    forgetProject: (user, project) => erase(user, project),
    deleteAccount: (user) => erase(user)
  };
}
let shared: ProjectAuthorityStore | undefined;
export function projectAuthorityStore(): ProjectAuthorityStore {
  return (shared ??=
    typeof indexedDB === 'undefined'
      ? memoryProjectAuthorityStore()
      : indexedDbProjectAuthorityStore());
}
const queue = new Map<string, Promise<unknown>>();
export async function withProjectAuthorityLock<T>(
  user: string,
  project: string,
  work: () => Promise<T>
): Promise<T> {
  const name = `openzcad-e2ee-project-authority:${user}:${project}`;
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
