/**
 * What this browser keeps about invitations to encrypted projects (ADR-024
 * Phase 5, slice 5-3b), in its own small IndexedDB database,
 * `openzcad-e2ee-invitations`, as the contact pins and version pins keep
 * theirs:
 *
 * - **Emails** (the owner's browser). The server stores only a hash of the
 *   invitee's email, so the pending list names an invitation by the email
 *   this browser sent it to. Another browser of the owner shows the
 *   invitee's email once they accepted (contacts), and a number before.
 * - **Claims** (the owner's browser). A claim hands each KeyPackage out
 *   once, so the claimed KeyPackages are kept until the Add that consumes
 *   them lands: a reload between the claim and the Add retries with them.
 *   KeyPackages are public; nothing secret is stored here.
 * - **Published** (the invitee's devices). Which invitations this device
 *   published a KeyPackage for, so it publishes once, and later looks for
 *   its Welcome.
 *
 * Everything is kept per account, like the contact pins; a memory store
 * stands in where IndexedDB is unavailable.
 */
import type { E2eeKeyPackageRecord } from '@openzcad/shared';

export interface InvitationEmail {
  readonly projectId: string;
  readonly invitationId: string;
  readonly email: string;
}

export interface StoredClaim {
  readonly projectId: string;
  readonly invitationId: string;
  readonly keyPackages: readonly E2eeKeyPackageRecord[];
}

export interface PublishedKeyPackage {
  readonly projectId: string;
  readonly invitationId: string;
  readonly deviceId: string;
  /** Unix milliseconds. */
  readonly publishedAt: number;
}

export interface InvitationStore {
  rememberEmail(userId: string, entry: InvitationEmail): Promise<void>;
  emails(userId: string): Promise<InvitationEmail[]>;
  saveClaim(userId: string, claim: StoredClaim): Promise<void>;
  claim(userId: string, invitationId: string): Promise<StoredClaim | null>;
  dropClaim(userId: string, invitationId: string): Promise<void>;
  markPublished(userId: string, entry: PublishedKeyPackage): Promise<void>;
  published(userId: string): Promise<PublishedKeyPackage[]>;
  dropPublished(userId: string, projectId: string): Promise<void>;
}

const isText = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function readEmail(value: unknown): InvitationEmail | null {
  const entry = value as Partial<InvitationEmail> | null;
  return entry &&
    isText(entry.projectId) &&
    isText(entry.invitationId) &&
    isText(entry.email, 254)
    ? {
        projectId: entry.projectId,
        invitationId: entry.invitationId,
        email: entry.email
      }
    : null;
}

function readClaim(value: unknown): StoredClaim | null {
  const entry = value as Partial<StoredClaim> | null;
  return entry &&
    isText(entry.projectId) &&
    isText(entry.invitationId) &&
    Array.isArray(entry.keyPackages)
    ? {
        projectId: entry.projectId,
        invitationId: entry.invitationId,
        keyPackages: entry.keyPackages as E2eeKeyPackageRecord[]
      }
    : null;
}

function readPublished(value: unknown): PublishedKeyPackage | null {
  const entry = value as Partial<PublishedKeyPackage> | null;
  return entry &&
    isText(entry.projectId) &&
    isText(entry.invitationId) &&
    isText(entry.deviceId) &&
    Number.isSafeInteger(entry.publishedAt)
    ? {
        projectId: entry.projectId,
        invitationId: entry.invitationId,
        deviceId: entry.deviceId,
        publishedAt: entry.publishedAt!
      }
    : null;
}

export function memoryInvitationStore(): InvitationStore {
  const emails = new Map<string, InvitationEmail>();
  const claims = new Map<string, StoredClaim>();
  const published = new Map<string, PublishedKeyPackage>();
  const id = (...parts: string[]) => JSON.stringify(parts);
  const ofUser = <T>(map: Map<string, T>, userId: string) =>
    [...map].filter(([key]) => (JSON.parse(key) as string[])[0] === userId);
  return {
    rememberEmail: async (userId, entry) => {
      emails.set(id(userId, entry.invitationId), { ...entry });
    },
    emails: async (userId) => ofUser(emails, userId).map(([, v]) => v),
    saveClaim: async (userId, claim) => {
      claims.set(id(userId, claim.invitationId), claim);
    },
    claim: async (userId, invitationId) =>
      claims.get(id(userId, invitationId)) ?? null,
    dropClaim: async (userId, invitationId) => {
      claims.delete(id(userId, invitationId));
    },
    markPublished: async (userId, entry) => {
      published.set(id(userId, entry.projectId), { ...entry });
    },
    published: async (userId) => ofUser(published, userId).map(([, v]) => v),
    dropPublished: async (userId, projectId) => {
      published.delete(id(userId, projectId));
    }
  };
}

export const INVITATION_DATABASE = 'openzcad-e2ee-invitations';
const EMAILS = 'emails';
const CLAIMS = 'claims';
const PUBLISHED = 'published';

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(INVITATION_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [EMAILS, CLAIMS, PUBLISHED]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
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

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (objects: IDBObjectStore) => IDBRequest | null,
  result: (request: IDBRequest | null) => T
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(result(request));
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB invitation transaction failed'));
  });
}

/** Every record of `userId` (keys are `[userId, …]` arrays). */
const userRange = (userId: string) =>
  IDBKeyRange.bound([userId, ''], [userId, []]);

function all<T>(
  store: string,
  userId: string,
  read: (value: unknown) => T | null
): Promise<T[]> {
  return run(
    store,
    'readonly',
    (objects) => objects.getAll(userRange(userId)),
    (request) =>
      ((request?.result as unknown[]) ?? [])
        .map(read)
        .filter((value): value is T => value !== null)
  );
}

export function indexedDbInvitationStore(): InvitationStore {
  const put = (store: string, key: IDBValidKey, value: unknown) =>
    run(
      store,
      'readwrite',
      (objects) => objects.put(value, key),
      () => undefined
    );
  const remove = (store: string, key: IDBValidKey) =>
    run(
      store,
      'readwrite',
      (objects) => objects.delete(key),
      () => undefined
    );
  return {
    rememberEmail: (userId, entry) =>
      put(EMAILS, [userId, entry.invitationId], { ...entry }),
    emails: (userId) => all(EMAILS, userId, readEmail),
    saveClaim: (userId, claim) =>
      put(CLAIMS, [userId, claim.invitationId], claim),
    claim: (userId, invitationId) =>
      run(
        CLAIMS,
        'readonly',
        (objects) => objects.get([userId, invitationId]),
        (request) => readClaim(request?.result)
      ),
    dropClaim: (userId, invitationId) => remove(CLAIMS, [userId, invitationId]),
    markPublished: (userId, entry) =>
      put(PUBLISHED, [userId, entry.projectId], { ...entry }),
    published: (userId) => all(PUBLISHED, userId, readPublished),
    dropPublished: (userId, projectId) => remove(PUBLISHED, [userId, projectId])
  };
}

let shared: InvitationStore | null = null;

/** This browser's invitation store: IndexedDB, or memory without it. */
export function invitationStore(): InvitationStore {
  shared ??=
    typeof indexedDB === 'undefined'
      ? memoryInvitationStore()
      : indexedDbInvitationStore();
  return shared;
}
