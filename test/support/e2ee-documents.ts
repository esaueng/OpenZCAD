/**
 * Shared harness for encrypted document tests (ADR-024 Phase 4, slices
 * 4-5 to 4-7): accounts with real device lists, the real Worker over SQLite
 * with an in-memory object bucket (multipart uploads and ranged reads
 * included), and Node devices that run the real client modules
 * (`projectGroups.ts`, `encryptedProjectStore.ts`,
 * `encryptedContentBlobs.ts`, `encryptedProjectInfo.ts`,
 * `replacedEnvelopes.ts`) with the in-process MLS engine.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import worker from '../../apps/web/worker/index';
import {
  accountKeyCommitment,
  deviceListEntryHash,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  nextDeviceListEntry,
  signDeviceListEntry,
  toBase64Url,
  toHex,
  verifyDeviceList,
  type DeviceListEntry,
  type ListedDevice,
  type SignedDeviceListEntry,
  type VerifiedDeviceList,
  type VersionCutoff
} from '@openzcad/crypto';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { inProcessMls } from '../../packages/mls/src/test-support';
import {
  createProjectGroupsApi,
  type ProjectGroupContext
} from '../../apps/web/src/lib/e2ee/projectGroups';
import { MlsProjectSessions } from '../../apps/web/src/lib/e2ee/mls/projectSessions';
import { createMlsLoader } from '../../apps/web/src/lib/e2ee/mls/loader';
import {
  memoryMlsSessionStore,
  type MlsSessionStore
} from '../../apps/web/src/lib/e2ee/mls/sessionStore';
import type { CertifyingDevice } from '../../apps/web/src/lib/e2ee/mls/certify';
import {
  createEncryptedDocumentsApi,
  type EncryptedDocumentsApi
} from '../../apps/web/src/lib/e2ee/encryptedDocumentsApi';
import {
  createEncryptedProjectStore,
  type EncryptedProjectStore,
  type EncryptedProjectWarning,
  type EncryptedShareHead
} from '../../apps/web/src/lib/e2ee/encryptedProjectStore';
import {
  memoryVersionPins,
  type VersionPinStore
} from '../../apps/web/src/lib/e2ee/versionPins';
import {
  createBlobReferenceRegistry,
  type BlobReferenceRegistry
} from '../../apps/web/src/lib/e2ee/blobReferences';
import {
  createContentBlobsApi,
  createEncryptedContentBlobs,
  uploadTransport,
  type EncryptedContentBlobs
} from '../../apps/web/src/lib/e2ee/encryptedContentBlobs';
import type { ProjectFilesDeps } from '../../apps/web/src/lib/e2ee/encryptedProjectInfo';
import {
  createEncryptedMeasurements,
  createEncryptedViewStates,
  createReplacedEnvelopesApi,
  type EncryptedMeasurements,
  type EncryptedViewStates
} from '../../apps/web/src/lib/e2ee/replacedEnvelopes';
import { migratedDatabase, sqliteD1 } from './sqlite-d1';
import { createE2eeShareLinksApi } from '@openzcad/shared';
import type { ShareLinksContext } from '../../apps/web/src/lib/e2ee/shareLinks';

export const OWNER = 'user_owner';
export const OTHER = 'user_other';
const NOW = '2026-10-24T00:00:00.000Z';
const ADDED_AT = 1_700_000_000_000;

// --- Accounts --------------------------------------------------------------

export interface Account {
  userId: string;
  list: VerifiedDeviceList;
  devices: Map<string, CertifyingDevice>;
  accountKey: Uint8Array;
  /** The identity's private key (share delegations, slice 5-10). */
  identityPrivateKey: CryptoKey;
  /** Rows the Worker reads the device list from. */
  seed(db: DatabaseSync): void;
  /** Revokes a device in a new identity-signed entry, seeded into `db`. */
  revoke(db: DatabaseSync, deviceId: string): Promise<void>;
}

const ecdhPublic = async () =>
  exportPublicKey((await generateEncryptionKeyPair()).publicKey);

export async function makeAccount(
  userId: string,
  certified: readonly string[],
  readOnly: readonly string[] = []
): Promise<Account> {
  const identity = await generateSigningKeyPair(false);
  const identityRaw = await exportPublicKey(identity.publicKey);
  const devices = new Map<string, CertifyingDevice>();
  const listed: ListedDevice[] = [];
  for (const deviceId of [...certified, ...readOnly]) {
    const signing = await generateSigningKeyPair(false);
    devices.set(deviceId, { userId, deviceId, signing });
    if (!certified.includes(deviceId)) continue;
    listed.push({
      deviceId,
      label: deviceId,
      signingKey: await exportPublicKey(signing.publicKey),
      unlockKey: await ecdhPublic(),
      addedAt: ADDED_AT
    });
  }
  const accountKey = generateSymmetricKey();
  const genesis: DeviceListEntry = {
    userId,
    sequence: 0,
    previousEntryHash: null,
    issuedAt: ADDED_AT,
    previousIdentityKeyHash: null,
    encryptionKey: await ecdhPublic(),
    accountKeyCommitment: await accountKeyCommitment(accountKey),
    devices: listed,
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'rk_1',
        publicKey: await ecdhPublic(),
        addedAt: ADDED_AT
      }
    ],
    revoked: []
  };
  const chain: SignedDeviceListEntry[] = [
    await signDeviceListEntry(identity.privateKey, genesis)
  ];
  const hashes = [toHex(await deviceListEntryHash(chain[0]!.entry))];
  const insertEntry = (db: DatabaseSync, sequence: number) => {
    const signed = chain[sequence]!;
    db.prepare(
      `INSERT INTO e2ee_device_list_entries
         (user_id, generation, sequence, entry, signature, entry_hash, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      sequence,
      toBase64Url(signed.entry),
      toBase64Url(signed.signature),
      hashes[sequence]!,
      NOW
    );
  };
  const account: Account = {
    userId,
    list: await verifyDeviceList(identityRaw, chain),
    devices,
    accountKey,
    identityPrivateKey: identity.privateKey,
    seed(db) {
      db.prepare(
        `INSERT INTO e2ee_identities (user_id, generation, identity_key, created_at)
         VALUES (?, 1, ?, ?)`
      ).run(userId, toBase64Url(identityRaw), NOW);
      insertEntry(db, 0);
    },
    async revoke(db, deviceId) {
      // A revocation rotates the account key; project-key wraps made under
      // the old one stay readable through the account-key history, which
      // these tests do not need: they keep the old key for reading.
      const nextKey = generateSymmetricKey();
      const entry = nextDeviceListEntry(account.list, {
        issuedAt: ADDED_AT + chain.length * 1000,
        removeDeviceIds: [deviceId],
        encryptionKey: await ecdhPublic(),
        accountKeyCommitment: await accountKeyCommitment(nextKey)
      });
      const signed = await signDeviceListEntry(identity.privateKey, entry);
      chain.push(signed);
      hashes.push(toHex(await deviceListEntryHash(signed.entry)));
      insertEntry(db, chain.length - 1);
      account.list = await verifyDeviceList(identityRaw, chain);
    }
  };
  return account;
}

// --- Server ----------------------------------------------------------------

export interface Bucket {
  objects: Map<string, ArrayBuffer>;
  /** Open multipart uploads, by upload id. */
  multipart: Map<string, { key: string; parts: Map<number, Uint8Array> }>;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  createMultipartUpload: ReturnType<typeof vi.fn>;
  resumeMultipartUpload: ReturnType<typeof vi.fn>;
}

export function objectBucket(): Bucket {
  const objects = new Map<string, ArrayBuffer>();
  const multipart: Bucket['multipart'] = new Map();
  let nextUpload = 0;
  const resumed = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: async (partNumber: number, body: ArrayBuffer | Uint8Array) => {
      const upload = multipart.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
      upload.parts.set(partNumber, new Uint8Array(body).slice());
      return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
    },
    complete: async (parts: { partNumber: number; etag: string }[]) => {
      const upload = multipart.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
      const chunks = parts.map((part) => {
        const bytes = upload.parts.get(part.partNumber);
        if (!bytes || part.etag !== `etag-${uploadId}-${part.partNumber}`) {
          throw new Error('R2 multipart part mismatch');
        }
        return bytes;
      });
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const assembled = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(key, assembled.buffer);
      multipart.delete(uploadId);
      return { key, size };
    },
    abort: async () => {
      multipart.delete(uploadId);
    }
  });
  return {
    objects,
    multipart,
    put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array) => {
      objects.set(key, new Uint8Array(body).slice().buffer);
    }),
    get: vi.fn(
      async (
        key: string,
        options?: { range?: { offset?: number; length?: number } }
      ) => {
        const stored = objects.get(key);
        if (!stored) return null;
        const offset = options?.range?.offset ?? 0;
        const body = stored.slice(
          offset,
          options?.range?.length === undefined
            ? undefined
            : offset + options.range.length
        );
        return {
          arrayBuffer: async () => body.slice(0),
          size: stored.byteLength,
          get body() {
            return new Blob([body.slice(0)]).stream();
          }
        };
      }
    ),
    createMultipartUpload: vi.fn(async (key: string) => {
      const uploadId = `multipart-${++nextUpload}`;
      multipart.set(uploadId, { key, parts: new Map() });
      return resumed(key, uploadId);
    }),
    resumeMultipartUpload: vi.fn((key: string, uploadId: string) =>
      resumed(key, uploadId)
    ),
    head: vi.fn(async (key: string) => {
      const body = objects.get(key);
      return body ? { size: body.byteLength } : null;
    }),
    delete: vi.fn(async (key: string | string[]) => {
      for (const item of typeof key === 'string' ? [key] : key)
        objects.delete(item);
    }),
    // R2's listing, in key order, a page of `limit` (at most 1000) keys.
    list: vi.fn(
      async (
        options: { prefix?: string; cursor?: string; limit?: number } = {}
      ) => {
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(options.prefix ?? ''))
          .sort();
        const start = options.cursor ? Number(options.cursor) : 0;
        const limit = Math.min(options.limit ?? 1000, 1000);
        const page = keys.slice(start, start + limit);
        const truncated = start + limit < keys.length;
        return {
          objects: page.map((key) => ({
            key,
            size: objects.get(key)!.byteLength,
            uploaded: new Date(0)
          })),
          truncated,
          ...(truncated ? { cursor: String(start + limit) } : {})
        };
      }
    )
  };
}

export interface Server {
  db: DatabaseSync;
  env: Record<string, unknown>;
  bucket: Bucket;
  statements: string[];
  call(
    method: string,
    path: string,
    options?: {
      user?: string;
      body?: unknown;
      raw?: Uint8Array<ArrayBuffer>;
      contentType?: string;
    }
  ): Promise<Response>;
}

export function newServer(
  accounts: readonly Account[],
  db: DatabaseSync = migratedDatabase(),
  extraEnv: Record<string, unknown> = {}
): Server {
  for (const account of accounts) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)'
    ).run(account.userId, NOW);
    account.seed(db);
  }
  const statements: string[] = [];
  const bucket = objectBucket();
  const room = vi.fn(
    // A plaintext room holding nothing: it confirms a migration lock.
    async () =>
      new Response(JSON.stringify({ ok: true, latestVersion: null }), {
        status: 200
      })
  );
  const env: Record<string, unknown> = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db, { onStatement: (sql) => statements.push(sql) }),
    PROJECT_STORAGE: bucket,
    ARTIFACTS: bucket,
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_ROOM: { getByName: vi.fn(() => ({ fetch: room })) },
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
    ...extraEnv
  };
  const call: Server['call'] = (method, path, options = {}) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers: {
          'x-openzcad-development-user': options.user ?? OWNER,
          ...(options.raw
            ? {
                'content-type':
                  options.contentType ?? 'application/octet-stream'
              }
            : options.body === undefined
              ? {}
              : { 'content-type': 'application/json' })
        },
        ...(options.raw
          ? { body: options.raw }
          : options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) })
      }),
      env
    );
  return { db, env, bucket, statements, call };
}

/** Every tracked migration before `number`, as `pnpm deploy:beta` may leave D1. */
export function databaseBefore(number: number): DatabaseSync {
  const dir = new URL('../../apps/web/migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith('.sql') && Number.parseInt(name.slice(0, 4), 10) < number
    )
    .sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return db;
}

// --- Devices ---------------------------------------------------------------

export type Hook = (path: string, init: RequestInit) => Promise<void>;

export interface Device {
  account: Account;
  deviceId: string | null;
  groups: ProjectGroupContext;
  documents: EncryptedDocumentsApi;
  store: EncryptedProjectStore;
  sessions: MlsProjectSessions;
  mls: MlsSessionStore;
  pins: VersionPinStore;
  warnings: EncryptedProjectWarning[];
  /** This page's content blob references (a fresh page holds none). */
  references: BlobReferenceRegistry;
  blobs: EncryptedContentBlobs;
  /** Thumbnails and archived exports through the project info (4-7). */
  files: ProjectFilesDeps;
  measurements: EncryptedMeasurements;
  viewStates: EncryptedViewStates;
  /** Share links (slice 5-10), over this device's store and groups. */
  shareLinks: ShareLinksContext;
  /**
   * What the page does after each write it made (slice 5-10: republishing
   * share snapshots), when `DeviceOptions.onVersionWritten` asks for it.
   */
  shareWork: Promise<unknown>[];
  fetcher(path: string, init?: RequestInit): Promise<Response>;
  /** Runs before a request reaches the Worker. */
  before?: Hook;
  /** Rewrites the Worker's answer before the device sees it. */
  answer?: (
    path: string,
    init: RequestInit,
    response: Response
  ) => Promise<Response>;
}

export interface DeviceOptions {
  mls?: MlsSessionStore;
  pins?: VersionPinStore;
  cutoffs?: Map<string, VersionCutoff>;
  now?: () => number;
  /** Upload part and envelope chunk sizes for content blobs. */
  partBytes?: number;
  chunkSize?: number;
  /** This page's blob references; a fresh registry by default. */
  references?: BlobReferenceRegistry;
  /**
   * This device's source store, by plaintext SHA-256: lost blobs are
   * stored again from it (409 `E2EE_BLOB_UNKNOWN`). Without it, a write
   * naming a lost blob fails as before.
   */
  localSources?: Map<string, Uint8Array>;
  /**
   * The project's other members (slice 5-2): their current verified device
   * lists, as contacts and pins (slice 5-1) will supply them.
   */
  members?: readonly Account[];
  /**
   * Runs after each version this device wrote (the page republishes share
   * snapshots there, slice 5-10); its promise is kept in `shareWork`.
   */
  onVersionWritten?: (
    d: Device,
    projectId: string,
    head: EncryptedShareHead
  ) => Promise<unknown>;
}

/** One device: its own engine, MLS store and pins over the shared server. */
export function device(
  srv: Server,
  account: Account,
  deviceId: string | null,
  options: DeviceOptions = {}
): Device {
  const mls = options.mls ?? memoryMlsSessionStore();
  const pins = options.pins ?? memoryVersionPins();
  const sessions = new MlsProjectSessions(
    mls,
    createMlsLoader(async () => inProcessMls())
  );
  const result = {
    account,
    deviceId,
    sessions,
    mls,
    pins,
    warnings: [],
    shareWork: []
  } as unknown as Device;
  result.fetcher = async (path: string, init: RequestInit = {}) => {
    await result.before?.(path, init);
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'x-openzcad-development-user': account.userId
        }
      }),
      srv.env
    );
    return result.answer ? result.answer(path, init, response) : response;
  };
  const fetcher = (path: string, init?: RequestInit) =>
    result.fetcher(path, init);
  result.groups = {
    api: createProjectGroupsApi(fetcher),
    sessions,
    account: {
      userId: account.userId,
      get list() {
        return account.list;
      },
      currentAccountKey: async () => ({
        key: new Uint8Array(account.accountKey),
        generation: 1,
        keySequence: 0
      }),
      openAccountKey: async () => {
        throw new Error('no older account key in this test');
      }
    },
    device: deviceId ? account.devices.get(deviceId)! : null,
    ...(options.members
      ? {
          members: {
            lists: async () => options.members!.map((member) => member.list)
          }
        }
      : {})
  };
  result.documents = createEncryptedDocumentsApi(fetcher);
  result.references = options.references ?? createBlobReferenceRegistry();
  result.blobs = createEncryptedContentBlobs({
    groups: result.groups,
    references: result.references,
    api: createContentBlobsApi(fetcher),
    transport: uploadTransport(fetcher),
    ...(options.partBytes ? { partBytes: options.partBytes } : {}),
    ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    ...(options.localSources
      ? {
          loadLocal: async (checksum: string) =>
            options.localSources!.get(checksum) ?? null
        }
      : {})
  });
  result.store = createEncryptedProjectStore({
    groups: result.groups,
    api: result.documents,
    blobReferences: result.references,
    pins,
    ...(options.localSources
      ? {
          restoreBlobs: (projectId: string, blobIds: readonly string[]) =>
            result.blobs.restore(projectId, blobIds)
        }
      : {}),
    ...(options.cutoffs ? { cutoffs: async () => options.cutoffs! } : {}),
    ...(options.now ? { now: options.now } : {}),
    onWarning: (warning) => result.warnings.push(warning),
    ...(options.onVersionWritten
      ? {
          onVersionWritten: (projectId: string, head: EncryptedShareHead) => {
            const work = options.onVersionWritten!(result, projectId, head);
            result.shareWork.push(work);
            return work.then(() => undefined);
          }
        }
      : {})
  });
  result.shareLinks = {
    groups: result.groups,
    store: result.store,
    api: createE2eeShareLinksApi(fetcher),
    blobReferences: result.references,
    origin: 'https://app.example',
    ...(options.now ? { now: options.now } : {})
  };
  result.files = {
    info: result.store.info,
    references: result.references,
    archive: (projectId, input) => result.blobs.archive(projectId, input)
  };
  const replacedApi = createReplacedEnvelopesApi(fetcher);
  result.measurements = createEncryptedMeasurements({
    userId: account.userId,
    kit: result.store.replaced,
    pins,
    api: replacedApi
  });
  result.viewStates = createEncryptedViewStates({
    userId: account.userId,
    kit: result.store.replaced,
    pins,
    api: replacedApi
  });
  return result;
}

/** A device reloaded: a new page and engine over the same storage. */
export const reload = (srv: Server, old: Device, options: DeviceOptions = {}) =>
  device(srv, old.account, old.deviceId, {
    mls: old.mls,
    pins: old.pins,
    ...options
  });

export function initialDocument(
  name = 'Bracket',
  userId = OWNER
): ProjectDocument {
  return withoutDerivedProjection(
    createProjectDocument(name, toUserId(userId))
  );
}

export async function createEncrypted(d: Device, name = 'Bracket') {
  return d.store.createProject({
    name,
    initialDocument: initialDocument(name, d.account.userId)
  });
}

/** The same document with one more edit: a new name and version. */
export function edited(
  document: ProjectDocument,
  name?: string
): ProjectDocument {
  return {
    ...document,
    name: name ?? document.name,
    version: document.version + 1
  };
}

export function rows<T>(
  srv: Server,
  sql: string,
  ...binds: (string | number)[]
): T[] {
  return srv.db.prepare(sql).all(...binds) as T[];
}

export function count(srv: Server, table: string, projectId: string): number {
  return (
    srv.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
      .get(projectId) as { n: number }
  ).n;
}
