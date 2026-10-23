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

  it('keeps the flow going when the Keychain cannot remove an unused key', async () => {
    const { host: keychain } = host();
    keychain.remove = vi.fn(async () => {
      throw new Error('Keychain locked');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = keychainDeviceStore(cloningStore(), keychain);
    await store.saveDevice(await device(keychain));
    await expect(store.deleteDevice(USER)).resolves.toBeUndefined();
    expect(await store.loadDevice(USER)).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
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
});
