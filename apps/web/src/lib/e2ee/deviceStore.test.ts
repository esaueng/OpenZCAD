import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountKeyCommitment,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  nextDeviceListEntry,
  signDeviceListEntry,
  verifyDeviceList,
  type DeviceListEntry,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type { DeviceKeyStore } from './deviceStore';

const USER = 'pin_user';
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('openzcad-e2ee');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Test database did not close'));
  });
  vi.unstubAllGlobals();
});

async function stores(
  backend: 'memory' | 'indexeddb'
): Promise<[DeviceKeyStore, DeviceKeyStore]> {
  const first = await import('./deviceStore');
  if (backend === 'memory') {
    const store = first.memoryDeviceStore();
    return [store, store];
  }
  const left = first.indexedDbDeviceStore();
  await left.loadPin(USER);
  // A separate module has its own open connection, as another tab would.
  vi.resetModules();
  const second = await import('./deviceStore');
  const right = second.indexedDbDeviceStore();
  await right.loadPin(USER);
  return [left, right];
}

async function fixture() {
  const identity = await generateSigningKeyPair(false);
  const identityKey = await exportPublicKey(identity.publicKey);
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
  const chain = [await signDeviceListEntry(identity.privateKey, genesis)];
  const list = await verifyDeviceList(identityKey, chain);
  const extend = async (
    before: VerifiedDeviceList,
    prefix: SignedDeviceListEntry[],
    issuedAt: number
  ) => {
    const entry = nextDeviceListEntry(before, { issuedAt });
    const next = [
      ...prefix,
      await signDeviceListEntry(identity.privateKey, entry)
    ];
    return { list: await verifyDeviceList(identityKey, next), chain: next };
  };
  return { list, chain, extend };
}

describe.each(['memory', 'indexeddb'] as const)(
  '%s atomic device-list pins',
  (backend) => {
    it('accepts first sight, identical heads and descendants, refusing a stale head', async () => {
      const [left, right] = await stores(backend);
      const f = await fixture();
      const newer = await f.extend(f.list, f.chain, 2);
      const newest = await f.extend(newer.list, newer.chain, 3);
      await left.savePin(USER, f.list);
      await right.savePin(USER, newer.list);
      await expect(left.savePin(USER, f.list)).rejects.toHaveProperty(
        'reason',
        'chain'
      );
      await left.savePin(USER, newer.list);
      await left.savePin(USER, newest.list);
      expect(await right.loadPin(USER)).toEqual(newest.list.pin);
    });

    it('refuses both equal-height and longer signed sibling forks', async () => {
      const [left, right] = await stores(backend);
      const f = await fixture();
      const accepted = await f.extend(f.list, f.chain, 2);
      const fork = await f.extend(f.list, f.chain, 3);
      const longerFork = await f.extend(fork.list, fork.chain, 4);
      await left.savePin(USER, accepted.list);
      for (const candidate of [fork.list, longerFork.list]) {
        await expect(right.savePin(USER, candidate)).rejects.toHaveProperty(
          'reason',
          'chain'
        );
        expect(await left.loadPin(USER)).toEqual(accepted.list.pin);
      }
    });

    it('requires exact snapshot authorization for a different identity', async () => {
      const [left, right] = await stores(backend);
      const a = await fixture();
      const b = await fixture();
      await left.savePin(USER, a.list);
      await expect(right.savePin(USER, b.list)).rejects.toHaveProperty(
        'reason',
        'identity'
      );
      await expect(
        right.savePin(USER, b.list, { replaceIdentityFrom: null })
      ).rejects.toHaveProperty('reason', 'identity');
      await right.savePin(USER, b.list, { replaceIdentityFrom: a.list.pin });
      await expect(left.savePin(USER, a.list)).rejects.toHaveProperty(
        'reason',
        'identity'
      );
      expect(await left.loadPin(USER)).toEqual(b.list.pin);
    });

    it('serializes competing first-sight writes from independent connections', async () => {
      const [left, right] = await stores(backend);
      const a = await fixture();
      const b = await fixture();
      const results = await Promise.allSettled([
        left.savePin(USER, a.list),
        right.savePin(USER, b.list)
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(await right.loadPin(USER)).toEqual(a.list.pin);
    });

    it('allows only one of two replacements authorized against the same snapshot', async () => {
      const [left, right] = await stores(backend);
      const a = await fixture();
      const b = await fixture();
      const c = await fixture();
      await left.savePin(USER, a.list);
      const options = { replaceIdentityFrom: a.list.pin };
      const results = await Promise.allSettled([
        left.savePin(USER, b.list, options),
        right.savePin(USER, c.list, options)
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(await right.loadPin(USER)).toEqual(b.list.pin);
    });

    it('does not let replacement permission bypass same-identity ancestry checks', async () => {
      const [left, right] = await stores(backend);
      const f = await fixture();
      const accepted = await f.extend(f.list, f.chain, 2);
      const fork = await f.extend(f.list, f.chain, 3);
      await left.savePin(USER, accepted.list);
      await expect(
        right.savePin(USER, fork.list, {
          replaceIdentityFrom: accepted.list.pin
        })
      ).rejects.toHaveProperty('reason', 'chain');
      expect(await left.loadPin(USER)).toEqual(accepted.list.pin);
    });

    it('snapshots caller bytes and returns independent pin copies', async () => {
      const [left, right] = await stores(backend);
      const f = await fixture();
      const expected = structuredClone(f.list.pin);
      const writing = left.savePin(USER, f.list);
      f.list.pin.entryHash.fill(0);
      f.list.pin.identityKeyHash.fill(0);
      await writing;
      const loaded = (await left.loadPin(USER))!;
      expect(loaded).toEqual(expected);
      loaded.entryHash.fill(0);
      expect(await right.loadPin(USER)).toEqual(expected);
    });

    it('refuses a list for a different account', async () => {
      const [left] = await stores(backend);
      const f = await fixture();
      await expect(left.savePin('other_user', f.list)).rejects.toHaveProperty(
        'reason',
        'chain'
      );
      expect(await left.loadPin('other_user')).toBeNull();
    });
  }
);
