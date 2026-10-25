import { admitDevelopmentE2eeWrite } from '../../apps/web/worker/e2eeWriteAuthorization';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { DatabaseSync } from 'node:sqlite';
import {
  exportPrivateKey,
  generateEncryptionKeyPair,
  generateRecoveryKey,
  generateSigningKeyPair,
  type DeviceListPin
} from '@openzcad/crypto';
import { handleE2eeRequest } from '../../apps/web/worker/e2ee';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { toUserId } from '@openzcad/shared';
import {
  enrollWithRecoveryKey,
  loadEncryption,
  setUpEncryption,
  type E2eeContext
} from '../../apps/web/src/lib/e2ee/accountKeys';
import { createE2eeApi } from '../../apps/web/src/lib/e2ee/e2eeApi';
import {
  memoryDeviceStore,
  type StoredDevice
} from '../../apps/web/src/lib/e2ee/deviceStore';
import { d1Database, migratedDatabase } from '../d1-sqlite';

/** The user `stubApi` signs in. */
export const E2E_USER_ID = 'user_e2e';

/**
 * The real `/api/e2ee/*` Worker routes over in-memory SQLite with every
 * migration applied, served to the browser through Playwright routing. One
 * server can back several browser contexts, which is how the approval specs
 * run two devices of one account.
 */
export interface E2eeServer {
  readonly db: DatabaseSync;
  enabled: boolean;
  /** E2EE_PROJECTS_ENABLED for the account (encrypted projects, Phase 4). */
  projectsEnabled: boolean;
  /**
   * Runs an account's key flows in Node, as another device would; the
   * signed-in account unless another one (`addE2eeUser`) is named.
   */
  readonly nodeDevice: (userId?: string) => E2eeContext;
  /** The artifact bucket encrypted content blobs are uploaded to. */
  readonly objects: Map<string, Uint8Array>;
  readonly bucket: unknown;
}

/**
 * An in-memory R2 bucket with what upload sessions use: single puts,
 * multipart uploads, heads, ranged and streamed reads, deletes.
 */
function memoryBucket(objects: Map<string, Uint8Array>) {
  const multipart = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array> }
  >();
  let next = 0;
  const bytes = (body: ArrayBuffer | ArrayBufferView) =>
    body instanceof ArrayBuffer
      ? new Uint8Array(body.slice(0))
      : new Uint8Array(
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        );
  const resumed = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: async (partNumber: number, body: ArrayBuffer) => {
      multipart.get(uploadId)!.parts.set(partNumber, bytes(body));
      return { partNumber, etag: `${uploadId}-${partNumber}` };
    },
    complete: async (parts: { partNumber: number }[]) => {
      const upload = multipart.get(uploadId)!;
      const chunks = parts.map((part) => upload.parts.get(part.partNumber)!);
      const out = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      );
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(key, out);
      multipart.delete(uploadId);
      return { key, size: out.byteLength };
    },
    abort: async () => {
      multipart.delete(uploadId);
    }
  });
  return {
    put: async (key: string, body: ArrayBuffer) => {
      objects.set(key, bytes(body));
      return { size: objects.get(key)!.byteLength };
    },
    head: async (key: string) =>
      objects.has(key) ? { size: objects.get(key)!.byteLength } : null,
    get: async (
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
        size: stored.byteLength,
        arrayBuffer: async () => body.slice().buffer,
        get body() {
          return new Blob([body.slice()]).stream();
        }
      };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    createMultipartUpload: async (key: string) => {
      const uploadId = `multipart-${++next}`;
      multipart.set(uploadId, { key, parts: new Map() });
      return resumed(key, uploadId);
    },
    resumeMultipartUpload: (key: string, uploadId: string) =>
      resumed(key, uploadId)
  };
}

export function createE2eeServer({
  enabled = true,
  projectsEnabled = false
} = {}): E2eeServer {
  const db = migratedDatabase();
  db.prepare(
    `INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)`
  ).run(E2E_USER_ID, new Date().toISOString());
  const objects = new Map<string, Uint8Array>();
  const server: E2eeServer = {
    db,
    enabled,
    projectsEnabled,
    objects,
    bucket: memoryBucket(objects),
    nodeDevice: (userId = E2E_USER_ID) => ({
      userId,
      api: createE2eeApi((path, init) => call(server, path, init, userId)),
      store: memoryDeviceStore(),
      // Node-side devices are made extractable so they can be moved into a
      // browser; the app's own devices never are.
      createDeviceKeys: async () => ({
        signing: await generateSigningKeyPair(true),
        unlock: await generateEncryptionKeyPair(true)
      })
    })
  };
  return server;
}

/**
 * Adds another account to the server, for specs that sign two people in
 * (each in its own browser context, with `installE2eeServer` and
 * `seedE2eeDevice` naming it).
 */
export function addE2eeUser(
  server: E2eeServer,
  userId: string,
  email: string | null = null
): void {
  server.db
    .prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
    .run(userId, email, new Date().toISOString());
}

async function call(
  server: E2eeServer,
  path: string,
  init: RequestInit = {},
  userId = E2E_USER_ID
): Promise<Response> {
  const env = {
    DB: d1Database(server.db),
    AUTH_MODE: 'development',
    ENVIRONMENT: 'development',
    ARTIFACTS: server.bucket
  };
  const session = { userId };
  if (
    server.enabled &&
    !['GET', 'HEAD', 'OPTIONS'].includes(init.method ?? 'GET')
  )
    await admitDevelopmentE2eeWrite(env.DB, session);
  return handleE2eeRequest(
    new Request(`https://zcad.test${path}`, init),
    env,
    session,
    server.enabled,
    server.projectsEnabled
  );
}

/**
 * Routes this page's upload-session calls (`/api/uploads/:id/…`, which
 * encrypted content blobs ride on) to the real persistence service over
 * the server's database and bucket.
 */
export async function installUploadRoutes(
  page: Page,
  server: E2eeServer
): Promise<void> {
  const persistence = new D1R2PersistenceService({
    DB: d1Database(server.db),
    ARTIFACTS: server.bucket
  } as never);
  const user = toUserId(E2E_USER_ID);
  await page.route('**/api/uploads/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataBuffer();
    const buffer = () =>
      new Uint8Array(body ?? new Uint8Array(0)).slice().buffer;
    const match =
      /^\/api\/uploads\/([^/]+)\/(content|multipart|multipart\/complete|parts\/(\d+))$/.exec(
        url.pathname
      );
    try {
      if (!match) throw new Error('Unknown upload route');
      const [, id, action, part] = match;
      const uploadId = url.searchParams.get('uploadId') ?? '';
      if (action === 'content' && request.method() === 'PUT') {
        await persistence.putUpload(user, id!, buffer());
        return await route.fulfill({ status: 204, body: '' });
      }
      if (action === 'multipart' && request.method() === 'POST') {
        return await route.fulfill({
          status: 201,
          json: await persistence.createMultipartUpload(user, id!)
        });
      }
      if (action === 'multipart' && request.method() === 'DELETE') {
        await persistence.abortMultipartUpload(user, id!, uploadId);
        return await route.fulfill({ status: 204, body: '' });
      }
      if (part && request.method() === 'PUT') {
        return await route.fulfill({
          json: await persistence.putUploadPart(
            user,
            id!,
            uploadId,
            Number(part),
            buffer()
          )
        });
      }
      if (action === 'multipart/complete') {
        await persistence.completeMultipartUpload(
          user,
          id!,
          JSON.parse(new TextDecoder().decode(buffer())) as never
        );
        return await route.fulfill({ status: 204, body: '' });
      }
      throw new Error('Unknown upload route');
    } catch (error) {
      return route.fulfill({
        status: 409,
        json: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  });
}

/**
 * Routes this browser context's `/api/e2ee/*` calls to `server`, signed in
 * as `userId` (the account `stubApi` signs in, unless named).
 */
export async function installE2eeServer(
  context: BrowserContext,
  server: E2eeServer,
  userId = E2E_USER_ID
): Promise<void> {
  await context.route('**/api/e2ee/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Encrypted documents travel as binary frames: pass bytes both ways.
    const body = request.postDataBuffer();
    const response = await call(
      server,
      `${url.pathname}${url.search}`,
      {
        method: request.method(),
        headers: {
          'content-type':
            request.headers()['content-type'] ?? 'application/json'
        },
        ...(body === null ? {} : { body: new Uint8Array(body) })
      },
      userId
    );
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/json',
      body: Buffer.from(await response.arrayBuffer())
    });
  });
}

export interface SeededAccount {
  /** The formatted recovery key, as a user would type it. */
  readonly recoveryKey: string;
  readonly deviceLabel: string;
  /** The seeded device, to write into another browser as the same device. */
  readonly device: DeviceMaterial;
  /** The recovery key's secret, for enrolling more seeded browsers. */
  readonly recoverySecret: Uint8Array;
}

export interface DeviceMaterial {
  readonly record: Omit<
    StoredDevice,
    'signing' | 'unlock' | 'signingPublicKey' | 'unlockPublicKey'
  > & {
    readonly signingPublicKey: number[];
    readonly unlockPublicKey: number[];
    readonly signingPrivate: number[];
    readonly unlockPrivate: number[];
  };
  readonly pin: {
    identityKeyHash: number[];
    sequence: number;
    entryHash: number[];
  };
}

async function materialOf(
  device: StoredDevice,
  pin: DeviceListPin
): Promise<DeviceMaterial> {
  const { signing, unlock, ...rest } = device;
  return {
    record: {
      ...rest,
      signingPublicKey: [...device.signingPublicKey],
      unlockPublicKey: [...device.unlockPublicKey],
      signingPrivate: [
        ...(await exportPrivateKey(signing.privateKey as CryptoKey))
      ],
      unlockPrivate: [
        ...(await exportPrivateKey(unlock.privateKey as CryptoKey))
      ]
    },
    pin: {
      identityKeyHash: [...pin.identityKeyHash],
      sequence: pin.sequence,
      entryHash: [...pin.entryHash]
    }
  };
}

/**
 * Writes a device record into this page's IndexedDB as the app stores it:
 * the private halves imported non-extractable, the pin beside them. Run it
 * after the first navigation and before opening Settings › Encryption.
 */
export async function writeDevice(
  page: Page,
  material: DeviceMaterial
): Promise<void> {
  await page.evaluate(async ({ record, pin }) => {
    const subtle = crypto.subtle;
    const bytes = (values: number[]) => new Uint8Array(values);
    const signing: CryptoKeyPair = {
      privateKey: await subtle.importKey(
        'pkcs8',
        bytes(record.signingPrivate),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
      ),
      publicKey: await subtle.importKey(
        'raw',
        bytes(record.signingPublicKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
      )
    };
    const unlock: CryptoKeyPair = {
      privateKey: await subtle.importKey(
        'pkcs8',
        bytes(record.unlockPrivate),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      ),
      publicKey: await subtle.importKey(
        'raw',
        bytes(record.unlockPublicKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
      )
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('openzcad-e2ee', 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('devices', { keyPath: 'userId' });
        open.result.createObjectStore('pins');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('open failed'));
    });
    const { signingPrivate: _s, unlockPrivate: _u, ...stored } = record;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['devices', 'pins'], 'readwrite');
      tx.objectStore('devices').put({
        ...stored,
        signingPublicKey: bytes(record.signingPublicKey),
        unlockPublicKey: bytes(record.unlockPublicKey),
        signing,
        unlock
      });
      tx.objectStore('pins').put(
        {
          identityKeyHash: bytes(pin.identityKeyHash),
          sequence: pin.sequence,
          entryHash: bytes(pin.entryHash)
        },
        record.userId
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
    });
    db.close();
  }, material);
}

/**
 * Sets the account up on the server (as if on another browser) and makes
 * this page a certified, unlockable device of it, so a spec starts unlocked
 * without running setup. `otherDevices` adds more certified devices.
 */
export async function seedE2eeDevice(
  page: Page,
  server: E2eeServer,
  {
    label = 'Seeded browser',
    otherDevices = [],
    userId = E2E_USER_ID
  }: { label?: string; otherDevices?: string[]; userId?: string } = {}
): Promise<SeededAccount> {
  const recovery = await generateRecoveryKey();
  const node = server.nodeDevice(userId);
  await setUpEncryption(node, { recoverySecret: recovery.secret, label });
  const device = (await node.store.loadDevice(userId))!;
  for (const other of otherDevices) {
    const ctx = server.nodeDevice(userId);
    const state = await loadEncryption(ctx);
    if (state.kind !== 'ready') throw new Error('seed failed');
    await enrollWithRecoveryKey(ctx, state.account, recovery.secret, other);
  }
  const state = await loadEncryption(node);
  if (state.kind !== 'ready') throw new Error('seed failed');
  const material = await materialOf(device, state.account.list.pin);
  await writeDevice(page, material);
  return {
    recoveryKey: recovery.formatted,
    deviceLabel: label,
    device: material,
    recoverySecret: recovery.secret
  };
}

/**
 * Makes another browser (its own context) a second certified, unlockable
 * device of the account `seeded` set up, enrolled with its recovery key.
 */
export async function seedAnotherE2eeDevice(
  page: Page,
  server: E2eeServer,
  seeded: SeededAccount,
  label = 'Second browser'
): Promise<void> {
  const node = server.nodeDevice();
  const before = await loadEncryption(node);
  if (before.kind !== 'ready') throw new Error('seed failed');
  await enrollWithRecoveryKey(
    node,
    before.account,
    seeded.recoverySecret,
    label
  );
  const device = (await node.store.loadDevice(E2E_USER_ID))!;
  const after = await loadEncryption(node);
  if (after.kind !== 'ready') throw new Error('seed failed');
  await writeDevice(page, await materialOf(device, after.account.list.pin));
}

/** Opens Settings › Encryption, unless a reload already restored it. */
export async function openEncryptionSettings(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const open = page.getByRole('button', { name: 'Open settings' });
  await expect(settings.or(open).first()).toBeVisible();
  if (!(await settings.isVisible())) await open.click();
  await settings
    .getByRole('button', { name: 'Encryption', exact: true })
    .click();
  return settings;
}
