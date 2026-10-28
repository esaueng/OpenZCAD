import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  accountKeyCommitment,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  nextDeviceListEntry,
  signDeviceListEntry,
  toHex,
  verifyDeviceList,
  type DeviceListEntry
} from '@openzcad/crypto';
import type { AccountView } from './accountKeys';

beforeEach(() => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const keys = await import('./unlockedKeys');
  const accountKeys = await import('./accountKeys');
  const bridge = await import('../desktopBridge');
  const userId = 'page_owner';
  vi.spyOn(bridge, 'desktopFetch').mockImplementation(async (path) => {
    if (path !== '/api/session') throw new Error('Unexpected request');
    return new Response(JSON.stringify({ userId, email: null }));
  });
  const identity = await generateSigningKeyPair(false);
  const signing = await generateSigningKeyPair(false);
  const unlock = await generateEncryptionKeyPair(false);
  let encryption = await generateEncryptionKeyPair(false);
  const accountKey = generateSymmetricKey();
  const signingPublicKey = await exportPublicKey(signing.publicKey);
  const unlockPublicKey = await exportPublicKey(unlock.publicKey);
  const entry: DeviceListEntry = {
    userId,
    sequence: 0,
    previousEntryHash: null,
    previousIdentityKeyHash: null,
    issuedAt: 1_700_000_000_000,
    encryptionKey: await exportPublicKey(encryption.publicKey),
    accountKeyCommitment: await accountKeyCommitment(accountKey),
    devices: [
      {
        deviceId: 'browser',
        label: 'Browser',
        signingKey: signingPublicKey,
        unlockKey: unlockPublicKey,
        addedAt: 1_700_000_000_000
      }
    ],
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'recovery',
        publicKey: await exportPublicKey(
          (await generateEncryptionKeyPair(false)).publicKey
        ),
        addedAt: 1_700_000_000_000
      }
    ],
    revoked: []
  };
  const chain = [await signDeviceListEntry(identity.privateKey, entry)];
  const list = await verifyDeviceList(identity.publicKey, chain);
  let account: AccountView = {
    userId,
    generation: 1,
    createdAt: '2026-01-01T00:00:00Z',
    list,
    persistedPin: list.pin,
    fingerprint: '',
    wraps: [],
    approvedDevices: [],
    device: {
      userId,
      deviceId: 'browser',
      label: 'Browser',
      signing,
      unlock,
      signingPublicKey,
      unlockPublicKey,
      createdAt: 1_700_000_000_000,
      approval: null
    },
    deviceStatus: 'certified',
    unlocked: true,
    unlockError: null,
    previous: []
  };
  const remember = (key: Uint8Array) =>
    keys.rememberUnlockedAccount(userId, {
      generation: account.generation,
      commitment: toHex(account.list.head.accountKeyCommitment),
      accountKey: key.slice(),
      encryptionPrivateKey: encryption.privateKey
    });
  remember(accountKey);
  const load = vi
    .spyOn(accountKeys, 'loadEncryption')
    .mockImplementation(async () => ({ kind: 'ready', account }));
  const page = await import('./encryptedProjects');
  const events = await import('./encryptionStateEvents');
  return {
    page,
    events,
    load,
    userId,
    accountKey,
    lock() {
      keys.lockAccount(userId);
      account = { ...account, unlocked: false };
      events.encryptionStateChanged(userId);
    },
    async rotate() {
      const nextKey = generateSymmetricKey();
      encryption = await generateEncryptionKeyPair(false);
      const next = nextDeviceListEntry(account.list, {
        issuedAt: entry.issuedAt + 1,
        encryptionKey: await exportPublicKey(encryption.publicKey),
        accountKeyCommitment: await accountKeyCommitment(nextKey)
      });
      chain.push(await signDeviceListEntry(identity.privateKey, next));
      account = {
        ...account,
        list: await verifyDeviceList(identity.publicKey, chain)
      };
      remember(nextKey);
      events.encryptionStateChanged(userId);
      return nextKey;
    }
  };
}

it('refreshes sharing, invitations and project clients after Settings rotates account keys without reloading', async () => {
  const f = await fixture();
  const oldShare = await f.page.encryptedShareLinks();
  const oldStore = await f.page.encryptedProjectStore();
  const oldInvitations = await f.page.encryptedInvitations();
  expect((await oldShare.ctx.groups.account.currentAccountKey()).key).toEqual(
    f.accountKey
  );
  f.events.encryptionStateChanged('another_account');
  expect(await f.page.encryptedShareLinks()).toBe(oldShare);
  const nextKey = await f.rotate();
  // This is the production refusal: the old verified account view cannot
  // use the newly unlocked key. Refresh the clients, never relax the check.
  await expect(oldShare.ctx.groups.account.currentAccountKey()).rejects.toThrow(
    'Unlock this device before opening older account keys.'
  );
  const nextShare = await f.page.encryptedShareLinks();
  expect((await nextShare.ctx.groups.account.currentAccountKey()).key).toEqual(
    nextKey
  );
  expect(await f.page.encryptedProjectStore()).not.toBe(oldStore);
  expect(await f.page.encryptedInvitations()).not.toBe(oldInvitations);
  expect(await f.page.encryptedShareLinks()).toBe(nextShare);
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('keeps a fresh store usable after repeated encryption-settings rechecks', async () => {
  const f = await fixture();
  await f.page.encryptedShareLinks();
  f.events.encryptionStateChanged(f.userId);
  f.events.encryptionStateChanged(f.userId);
  const current = await f.page.encryptedShareLinks();
  expect((await current.ctx.groups.account.currentAccountKey()).key).toEqual(
    f.accountKey
  );
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('refuses cached sharing clients once Settings reports the account locked', async () => {
  const f = await fixture();
  await f.page.encryptedShareLinks();
  f.lock();
  await expect(f.page.encryptedShareLinks()).rejects.toMatchObject({
    code: 'E2EE_KEYS_LOCKED'
  });
});

it('does not let a superseded opening failure overwrite fresh verification status', async () => {
  const f = await fixture();
  const status = await import('./encryptionStatus');
  const failure = vi.spyOn(status, 'reportEncryptedFailure');
  let reject!: (error: Error) => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      })
  );
  const oldOpening = f.page.encryptedShareLinks();
  const refused = expect(oldOpening).rejects.toThrow('Old opening failed');
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  f.events.encryptionStateChanged(f.userId);
  const fresh = await f.page.encryptedShareLinks();
  reject(new Error('Old opening failed'));
  await refused;
  expect(await f.page.encryptedShareLinks()).toBe(fresh);
  expect(failure).not.toHaveBeenCalled();
});
