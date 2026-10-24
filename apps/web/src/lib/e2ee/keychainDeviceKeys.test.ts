import { describe, expect, it, vi } from 'vitest';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  isExternalAgreementKey,
  isExternalSigningKey
} from '@openzcad/crypto';
import {
  memoryDeviceStore,
  type DeviceKeyStore,
  type StoredDevice
} from './deviceStore';
import { NativeDeviceKeysError } from '../desktopBridge';
import {
  createKeychainDeviceKeys,
  keychainDeviceStore,
  type KeychainHost
} from './keychainDeviceKeys';

const USER = 'user_keychain';

function host() {
  const live = new Set<string>();
  let next = 0;
  const value: KeychainHost = {
    create: async () => {
      const keyId = `dk_${(++next).toString(16).padStart(32, '0')}`;
      live.add(keyId);
      const signing = await generateSigningKeyPair(false);
      const unlock = await generateEncryptionKeyPair(false);
      return {
        keyId,
        signingPublicKey: await exportPublicKey(signing.publicKey),
        unlockPublicKey: await exportPublicKey(unlock.publicKey)
      };
    },
    sign: async () => new Uint8Array(64),
    derive: async () => new Uint8Array(32),
    remove: vi.fn(async (keyId: string) => {
      live.delete(keyId);
    })
  };
  return { host: value, live };
}

/** IndexedDB stores by structured clone: functions there would throw. */
function cloningStore(): DeviceKeyStore {
  const inner = memoryDeviceStore();
  return {
    ...inner,
    saveDevice: (device) => inner.saveDevice(structuredClone(device)),
    getOrCreateDevice: (candidate) =>
      inner.getOrCreateDevice(structuredClone(candidate)),
    replaceDeviceIfCurrent: (expected, candidate) =>
      inner.replaceDeviceIfCurrent(expected, structuredClone(candidate))
  };
}

async function device(
  keychain: KeychainHost,
  deviceId = 'dev_mac'
): Promise<StoredDevice> {
  const keys = await createKeychainDeviceKeys(keychain)();
  return {
    userId: USER,
    deviceId,
    label: 'Mac',
    signing: keys.signing,
    unlock: keys.unlock,
    signingPublicKey: await exportPublicKey(keys.signing.publicKey),
    unlockPublicKey: await exportPublicKey(keys.unlock.publicKey),
    createdAt: 1,
    approval: null
  };
}

function keyIdOf(device: StoredDevice): string {
  return (device.signing.privateKey as unknown as { keychainKeyId: string })
    .keychainKeyId;
}

describe('Keychain device store', () => {
  it('stores only key ids and rebuilds native handles on load', async () => {
    const { host: keychain } = host();
    const inner = cloningStore();
    const store = keychainDeviceStore(inner, keychain);
    const mac = await device(keychain);
    await store.saveDevice(mac);
    const raw = (await inner.loadDevice(USER))!;
    for (const stored of [raw.signing.privateKey, raw.unlock.privateKey]) {
      expect(Object.keys(stored)).toEqual(['keychainKeyId']);
      expect(
        (stored as unknown as { keychainKeyId: unknown }).keychainKeyId
      ).toMatch(/^dk_[0-9a-f]{32}$/);
    }
    const loaded = (await store.loadDevice(USER))!;
    expect(isExternalSigningKey(loaded.signing.privateKey)).toBe(true);
    expect(isExternalAgreementKey(loaded.unlock.privateKey)).toBe(true);
    expect(loaded.signingPublicKey).toEqual(mac.signingPublicKey);
  });

  it('removes Keychain keys no record references any more', async () => {
    const { host: keychain, live } = host();
    const store = keychainDeviceStore(cloningStore(), keychain);
    const first = await device(keychain, 'dev_first');
    // A losing setup race keeps the stored device and drops the candidate.
    expect((await store.getOrCreateDevice(first)).deviceId).toBe('dev_first');
    const loser = await device(keychain, 'dev_loser');
    expect((await store.getOrCreateDevice(loser)).deviceId).toBe('dev_first');
    expect(live.size).toBe(1);
    // A replacement retires the keys it replaced.
    const replacement = await device(keychain, 'dev_second');
    expect(
      await store.replaceDeviceIfCurrent(
        await store.loadDevice(USER),
        replacement
      )
    ).toBe(true);
    expect(live.size).toBe(1);
    // Saving over a device retires its keys too.
    await store.saveDevice(await device(keychain, 'dev_third'));
    expect(live.size).toBe(1);
    // Keeping the same keys (an approval update) retires nothing.
    const current = (await store.loadDevice(USER))!;
    await store.saveDevice({ ...current, approval: null });
    expect(live.size).toBe(1);
    await store.deleteDevice(USER);
    expect(live.size).toBe(0);
    expect(await store.loadDevice(USER)).toBeNull();
  });

  it('removes the keys of a losing replacement candidate', async () => {
    const { host: keychain, live } = host();
    const store = keychainDeviceStore(cloningStore(), keychain);
    const first = await device(keychain, 'dev_first');
    await store.saveDevice(first);
    // Another tab replaced the device after this one read it.
    const stale = await store.loadDevice(USER);
    const winner = await device(keychain, 'dev_winner');
    expect(await store.replaceDeviceIfCurrent(stale, winner)).toBe(true);
    const loser = await device(keychain, 'dev_loser');
    expect(await store.replaceDeviceIfCurrent(stale, loser)).toBe(false);
    // Only the winner's keys remain in the Keychain.
    expect(live.size).toBe(1);
    expect((await store.loadDevice(USER))?.deviceId).toBe('dev_winner');
  });

  it('keeps the flow going when the Keychain cannot remove an unused key', async () => {
    const { host: keychain } = host();
    keychain.remove = vi.fn(async () => {
      throw new Error('Keychain locked');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = keychainDeviceStore(cloningStore(), keychain);
    await store.saveDevice(await device(keychain, 'dev_first'));
    // Replacing the device leaves the old keys unused: removal is housekeeping.
    await expect(
      store.saveDevice(await device(keychain, 'dev_second'))
    ).resolves.toBeUndefined();
    expect((await store.loadDevice(USER))?.deviceId).toBe('dev_second');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps the record when the Keychain refuses an explicit device removal', async () => {
    const { host: keychain, live } = host();
    const store = keychainDeviceStore(cloningStore(), keychain);
    await store.saveDevice(await device(keychain));
    const remove = keychain.remove;
    keychain.remove = vi.fn(async () => {
      throw new Error('Keychain locked');
    });
    await expect(store.deleteDevice(USER)).rejects.toThrow('Keychain locked');
    // The key id survives, so removal can be retried.
    expect(await store.loadDevice(USER)).not.toBeNull();
    keychain.remove = remove;
    await store.deleteDevice(USER);
    expect(await store.loadDevice(USER)).toBeNull();
    expect(live.size).toBe(0);
  });

  it('removes freshly created keys when their public keys cannot be imported', async () => {
    const { host: keychain, live } = host();
    const create = keychain.create;
    keychain.create = async () => ({
      ...(await create()),
      signingPublicKey: new Uint8Array(65)
    });
    await expect(createKeychainDeviceKeys(keychain)()).rejects.toThrow();
    expect(live.size).toBe(0);
  });

  it.each([
    'getOrCreateDevice',
    'replaceDeviceIfCurrent',
    'saveDevice'
  ] as const)(
    'removes the candidate keys when IndexedDB rejects %s',
    async (write) => {
      const { host: keychain, live } = host();
      const inner = cloningStore();
      const store = keychainDeviceStore(
        {
          ...inner,
          [write]: async () => {
            throw new Error('IndexedDB transaction aborted');
          }
        },
        keychain
      );
      // A device is stored already, except for first setup.
      const kept =
        write === 'getOrCreateDevice'
          ? null
          : await device(keychain, 'dev_kept');
      if (kept) await keychainDeviceStore(inner, keychain).saveDevice(kept);
      const candidate = await device(keychain, 'dev_candidate');
      const attempt =
        write === 'getOrCreateDevice'
          ? store.getOrCreateDevice(candidate)
          : write === 'replaceDeviceIfCurrent'
            ? store.replaceDeviceIfCurrent(kept, candidate)
            : store.saveDevice(candidate);
      await expect(attempt).rejects.toThrow('IndexedDB transaction aborted');
      // The candidate's keys are gone; the stored device keeps its own.
      expect([...live]).toEqual(kept ? [keyIdOf(kept)] : []);
      expect((await store.loadDevice(USER))?.deviceId ?? null).toBe(
        kept?.deviceId ?? null
      );
    }
  );

  it('discards an abandoned candidate unless the stored record holds its keys', async () => {
    const { host: keychain, live } = host();
    const inner = cloningStore();
    const store = keychainDeviceStore(inner, keychain);
    const stored = await device(keychain, 'dev_stored');
    await store.saveDevice(stored);
    // The stored device's own keys are never discarded.
    await store.discardCandidate(stored);
    expect(live.has(keyIdOf(stored))).toBe(true);
    const abandoned = await device(keychain, 'dev_abandoned');
    await store.discardCandidate(abandoned);
    expect([...live]).toEqual([keyIdOf(stored)]);
    // When the record cannot be read, a stray key is safer than a lost one.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = keychainDeviceStore(
      {
        ...inner,
        loadDevice: async () => {
          throw new Error('IndexedDB unavailable');
        }
      },
      keychain
    );
    const unsure = await device(keychain, 'dev_unsure');
    await unreadable.discardCandidate(unsure);
    expect(live.has(keyIdOf(unsure))).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('retries removing keys a failed native creation left behind', async () => {
    const { host: keychain, live } = host();
    const leftover = `dk_${'f'.repeat(32)}`;
    const create = keychain.create;
    keychain.create = async () => {
      // The host stored the signing key and could not remove it again.
      live.add(leftover);
      throw new NativeDeviceKeysError('Keychain write failed', leftover);
    };
    const remove = keychain.remove;
    keychain.remove = vi.fn(async () => {
      throw new Error('Keychain locked');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const makeKeys = createKeychainDeviceKeys(keychain);
    await expect(makeKeys()).rejects.toThrow('Keychain write failed');
    // Removing it right away failed too, so the id is kept for a retry.
    expect(keychain.remove).toHaveBeenCalledWith(leftover);
    expect(live.has(leftover)).toBe(true);
    keychain.create = create;
    keychain.remove = remove;
    // The next creation removes the leftover first.
    const keys = await makeKeys();
    expect(live.has(leftover)).toBe(false);
    expect([...live]).toEqual([
      (keys.signing.privateKey as unknown as { keychainKeyId: string })
        .keychainKeyId
    ]);
    error.mockRestore();
  });
});
