import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountKeyCommitment,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  signDeviceListEntry,
  verifyDeviceList,
  type DeviceListEntry
} from '@openzcad/crypto';
import type { E2eeApi } from './e2eeApi';

/**
 * zcad.app moved from the beta Worker to stable, whose database starts
 * empty. A browser that had set up encryption on beta at zcad.app kept
 * beta's device-list pin under the same user id, so stable's "no keys"
 * answer read as keys that had disappeared: encryption reported a forked
 * device list and could never be set up there.
 */
const USER = 'user_realm';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function pinnedList() {
  const identity = await generateSigningKeyPair(false);
  const key = async () =>
    exportPublicKey((await generateEncryptionKeyPair()).publicKey);
  const genesis: DeviceListEntry = {
    userId: USER,
    sequence: 0,
    previousEntryHash: null,
    previousIdentityKeyHash: null,
    issuedAt: 1,
    encryptionKey: await key(),
    accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey()),
    devices: [
      {
        deviceId: 'dev_1',
        label: 'Browser',
        signingKey: await exportPublicKey(
          (await generateSigningKeyPair()).publicKey
        ),
        unlockKey: await key(),
        addedAt: 1
      }
    ],
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'rk_1',
        publicKey: await key(),
        addedAt: 1
      }
    ],
    revoked: []
  };
  return verifyDeviceList(await exportPublicKey(identity.publicKey), [
    await signDeviceListEntry(identity.privateKey, genesis)
  ]);
}

/** Loads the modules as a page at `hostname` would. */
async function pageAt(hostname: string) {
  vi.stubGlobal('location', { hostname });
  vi.resetModules();
  const [deviceStore, accountKeys] = await Promise.all([
    import('./deviceStore'),
    import('./accountKeys')
  ]);
  return { deviceStore, accountKeys };
}

/** A server whose database has no keys for the account. */
const emptyServer = {
  account: async () => ({ current: null, previous: [] })
} as unknown as E2eeApi;

describe('encryption state per deployment realm', () => {
  it('sets up on stable at an origin that still holds beta’s pin', async () => {
    // Beta, when it served zcad.app, pinned this account's device list
    // under the unlabelled name beta still uses.
    const beta = (await pageAt('beta.zcad.app')).deviceStore;
    expect(beta.E2EE_DATABASE).toBe('openzcad-e2ee');
    await beta.indexedDbDeviceStore().savePin(USER, await pinnedList());

    const stable = await pageAt('zcad.app');
    expect(stable.deviceStore.E2EE_DATABASE).toBe('openzcad-e2ee@stable');
    const store = stable.deviceStore.indexedDbDeviceStore();
    expect(await store.loadPin(USER)).toBeNull();
    await expect(
      stable.accountKeys.loadEncryption({
        userId: USER,
        api: emptyServer,
        store
      })
    ).resolves.toEqual({ kind: 'not-set-up', previous: [] });
  });

  it('still refuses keys that vanish from the deployment that pinned them', async () => {
    const beta = await pageAt('beta.zcad.app');
    const store = beta.deviceStore.indexedDbDeviceStore();
    await store.savePin(USER, await pinnedList());
    await expect(
      beta.accountKeys.loadEncryption({
        userId: USER,
        api: emptyServer,
        store
      })
    ).resolves.toMatchObject({ kind: 'fork' });
  });
});
