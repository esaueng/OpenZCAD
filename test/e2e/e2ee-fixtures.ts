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
  /** Runs the account's key flows in Node, as another device would. */
  readonly nodeDevice: () => E2eeContext;
}

export function createE2eeServer({
  enabled = true,
  projectsEnabled = false
} = {}): E2eeServer {
  const db = migratedDatabase();
  db.prepare(
    `INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)`
  ).run(E2E_USER_ID, new Date().toISOString());
  const server: E2eeServer = {
    db,
    enabled,
    projectsEnabled,
    nodeDevice: () => ({
      userId: E2E_USER_ID,
      api: createE2eeApi((path, init) => call(server, path, init)),
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

async function call(
  server: E2eeServer,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const env = { DB: d1Database(server.db), AUTH_MODE: 'development', ENVIRONMENT: 'development' };
  const session = { userId: E2E_USER_ID };
  if (server.enabled && !['GET', 'HEAD', 'OPTIONS'].includes(init.method ?? 'GET')) await admitDevelopmentE2eeWrite(env.DB, session);
  return handleE2eeRequest(
    new Request(`https://zcad.test${path}`, init),
    env,
    session,
    server.enabled,
    server.projectsEnabled
  );
}

/** Routes this browser context's `/api/e2ee/*` calls to `server`. */
export async function installE2eeServer(
  context: BrowserContext,
  server: E2eeServer
): Promise<void> {
  await context.route('**/api/e2ee/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Encrypted documents travel as binary frames: pass bytes both ways.
    const body = request.postDataBuffer();
    const response = await call(server, `${url.pathname}${url.search}`, {
      method: request.method(),
      headers: {
        'content-type': request.headers()['content-type'] ?? 'application/json'
      },
      ...(body === null ? {} : { body: new Uint8Array(body) })
    });
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
}

interface DeviceMaterial {
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
async function writeDevice(
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
    otherDevices = []
  }: { label?: string; otherDevices?: string[] } = {}
): Promise<SeededAccount> {
  const recovery = await generateRecoveryKey();
  const node = server.nodeDevice();
  await setUpEncryption(node, { recoverySecret: recovery.secret, label });
  const device = (await node.store.loadDevice(E2E_USER_ID))!;
  for (const other of otherDevices) {
    const ctx = server.nodeDevice();
    const state = await loadEncryption(ctx);
    if (state.kind !== 'ready') throw new Error('seed failed');
    await enrollWithRecoveryKey(ctx, state.account, recovery.secret, other);
  }
  const state = await loadEncryption(node);
  if (state.kind !== 'ready') throw new Error('seed failed');
  await writeDevice(page, await materialOf(device, state.account.list.pin));
  return { recoveryKey: recovery.formatted, deviceLabel: label };
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
