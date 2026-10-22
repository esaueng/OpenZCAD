import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from '@openzcad/crypto';
import * as deviceStores from './deviceStore';
import { signOutAfterSaving } from './signOut';
import {
  lockAccountsExcept,
  rememberUnlockedAccount,
  unlockedAccount
} from './unlockedKeys';

afterEach(() => {
  lockAccountsExcept(null);
  vi.restoreAllMocks();
});

async function fixture() {
  const userId = 'user_sign_out';
  const store = deviceStores.memoryDeviceStore();
  const signing = await generateSigningKeyPair(false);
  const unlock = await generateEncryptionKeyPair(false);
  await store.saveDevice({
    userId,
    deviceId: 'sign_out_device',
    label: 'Browser',
    signing,
    unlock,
    signingPublicKey: await exportPublicKey(signing.publicKey),
    unlockPublicKey: await exportPublicKey(unlock.publicKey),
    createdAt: 1,
    approval: null
  });
  const accountKey = new Uint8Array(32).fill(0x71);
  rememberUnlockedAccount(userId, {
    generation: 1,
    commitment: 'test',
    accountKey,
    encryptionPrivateKey: unlock.privateKey
  });
  vi.spyOn(deviceStores, 'indexedDbDeviceStore').mockReturnValue(store);
  return { userId, store, accountKey };
}

describe('saving before device-key sign-out', () => {
  it('does not drain or revoke a session that replaced the inspected account', async () => {
    const savePending = vi.fn(async () => {});
    const revokeSession = vi.fn();
    await expect(
      signOutAfterSaving({
        userId: 'user_sign_out',
        isCurrentSession: () => false,
        savePending,
        revokeSession
      })
    ).rejects.toThrow('signed-in account changed');
    expect(savePending).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('preserves device keys and the new session when the account changes during saving', async () => {
    const { userId, store, accountKey } = await fixture();
    let current = true;
    const remove = vi.spyOn(store, 'deleteDevice');
    const revokeSession = vi.fn();
    await expect(
      signOutAfterSaving({
        userId,
        keepDevice: false,
        isCurrentSession: () => current,
        savePending: async () => {
          current = false;
        },
        revokeSession
      })
    ).rejects.toThrow('signed-in account changed');
    expect(remove).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
    expect(await store.loadDevice(userId)).not.toBeNull();
    expect(unlockedAccount(userId)?.accountKey).toBe(accountKey);
  });

  it('does not remove keys or revoke the session when saving fails', async () => {
    const { userId, store, accountKey } = await fixture();
    const remove = vi.spyOn(store, 'deleteDevice');
    const revokeSession = vi.fn();
    await expect(
      signOutAfterSaving({
        userId,
        keepDevice: false,
        isCurrentSession: () => true,
        savePending: async () => {
          throw new Error('Save failed');
        },
        revokeSession
      })
    ).rejects.toThrow('Save failed');
    expect(remove).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
    expect(await store.loadDevice(userId)).not.toBeNull();
    expect(unlockedAccount(userId)?.accountKey).toBe(accountKey);
    expect(accountKey.some((byte) => byte !== 0)).toBe(true);
  });

  it('blocks session revocation on deletion failure, locks cached keys and allows retry', async () => {
    const { userId, store, accountKey } = await fixture();
    const remove = vi
      .spyOn(store, 'deleteDevice')
      .mockRejectedValueOnce(new Error('Deletion aborted'));
    const savePending = vi.fn(async () => {});
    const revokeSession = vi.fn(async () => {
      expect(await store.loadDevice(userId)).toBeNull();
    });
    const input = {
      userId,
      keepDevice: false,
      isCurrentSession: () => true,
      savePending,
      revokeSession
    };
    await expect(signOutAfterSaving(input)).rejects.toThrow('Deletion aborted');
    expect(revokeSession).not.toHaveBeenCalled();
    expect(await store.loadDevice(userId)).not.toBeNull();
    expect(unlockedAccount(userId)).toBeUndefined();
    expect(accountKey.every((byte) => byte === 0)).toBe(true);
    await signOutAfterSaving(input);
    expect(savePending).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(revokeSession).toHaveBeenCalledOnce();
  });

  it.each([true, false, undefined])(
    'saves before applying the %s choice and revoking the session',
    async (keepDevice) => {
      const { userId, store } = await fixture();
      const remove = vi.spyOn(store, 'deleteDevice');
      const order: string[] = [];
      await signOutAfterSaving({
        userId,
        keepDevice,
        isCurrentSession: () => true,
        savePending: async () => {
          expect(await store.loadDevice(userId)).not.toBeNull();
          expect(unlockedAccount(userId)).toBeDefined();
          order.push('saved');
        },
        revokeSession: async () => {
          expect((await store.loadDevice(userId)) !== null).toBe(
            keepDevice !== false
          );
          expect(unlockedAccount(userId) !== undefined).toBe(
            keepDevice === undefined
          );
          order.push('revoked');
        }
      });
      expect(order).toEqual(['saved', 'revoked']);
      expect(remove).toHaveBeenCalledTimes(keepDevice === false ? 1 : 0);
    }
  );
});
