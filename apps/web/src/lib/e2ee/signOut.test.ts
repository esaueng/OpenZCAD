import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from '@openzcad/crypto';
import * as deviceStores from './deviceStore';
import * as e2eeApis from './e2eeApi';
import { signOutAfterSaving } from './signOut';
import {
  keyOperationGuard,
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
  async function pendingApproval() {
    const current = await fixture();
    const device = (await current.store.loadDevice(current.userId))!;
    await current.store.saveDevice({
      ...device,
      approval: { id: 'sign_out_pending_approval', nonce: new Uint8Array(32) }
    });
    const api = e2eeApis.createE2eeApi(async () =>
      Response.json({ state: 'pending' })
    );
    const readLiveApproval = api.getApproval;
    const get = vi
      .spyOn(api, 'getApproval')
      .mockRejectedValue(
        new e2eeApis.E2eeApiError(404, 'Approval unavailable')
      );
    const cancel = vi.fn(async () => ({ ok: true as const }));
    vi.spyOn(e2eeApis, 'createE2eeApi').mockReturnValue({
      ...api,
      cancelApproval: cancel
    });
    return { ...current, cancel, get, readLiveApproval };
  }

  it('cancels the pending server approval before its only device keys disappear', async () => {
    const { userId, store, cancel } = await pendingApproval();
    let requestLive = true;
    cancel.mockImplementation(async () => {
      expect(await store.loadDevice(userId)).not.toBeNull();
      requestLive = false;
      return { ok: true };
    });
    const remove = store.deleteDevice.bind(store);
    vi.spyOn(store, 'deleteDevice').mockImplementation(async (id) => {
      // A previously scanned approval must already be unusable at key removal.
      expect(requestLive).toBe(false);
      await remove(id);
    });
    const revokeSession = vi.fn(async () => {
      expect(requestLive).toBe(false);
      expect(await store.loadDevice(userId)).toBeNull();
    });
    await signOutAfterSaving({
      userId,
      keepDevice: false,
      isCurrentSession: () => true,
      savePending: async () => {},
      revokeSession
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('sign_out_pending_approval');
    expect(revokeSession).toHaveBeenCalledOnce();
  });

  it('keeps another key writer behind deletion and server revocation', async () => {
    const { userId, store, cancel } = await pendingApproval();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    cancel.mockImplementation(async () => {
      entered();
      await held;
      return { ok: true };
    });
    let sessionLive = true;
    let writerStartedBeforeLogout: boolean | undefined;
    const signingOut = signOutAfterSaving({
      userId,
      keepDevice: false,
      isCurrentSession: () => sessionLive,
      savePending: async () => {},
      revokeSession: async () => {
        sessionLive = false;
      }
    });
    await started;
    const writing = store.withDeviceLock(userId, async () => {
      writerStartedBeforeLogout = sessionLive;
      if (sessionLive)
        throw new Error('A key writer ran before sign-out finished');
    });
    const outcome = writing.then(
      () => null,
      (error: unknown) => error
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(writerStartedBeforeLogout).toBeUndefined();
    } finally {
      release();
      await signingOut;
    }
    expect(await outcome).toBeNull();
    expect(writerStartedBeforeLogout).toBe(false);
    expect(await store.loadDevice(userId)).toBeNull();
  });

  it('keeps the approval ID and keys for retry when cancellation fails', async () => {
    const { userId, store, cancel } = await pendingApproval();
    cancel.mockRejectedValueOnce(new Error('Cancellation unavailable'));
    const revokeSession = vi.fn();
    const input = {
      userId,
      keepDevice: false,
      isCurrentSession: () => true,
      savePending: async () => {},
      revokeSession
    };
    await expect(signOutAfterSaving(input)).rejects.toThrow(
      'Cancellation unavailable'
    );
    expect((await store.loadDevice(userId))?.approval?.id).toBe(
      'sign_out_pending_approval'
    );
    expect(revokeSession).not.toHaveBeenCalled();
    await signOutAfterSaving(input);
    expect(await store.loadDevice(userId)).toBeNull();
    expect(revokeSession).toHaveBeenCalledOnce();
  });

  it('retains a pending approval when keeping the device unlocked', async () => {
    const { userId, store, cancel } = await pendingApproval();
    await signOutAfterSaving({
      userId,
      keepDevice: true,
      isCurrentSession: () => true,
      savePending: async () => {},
      revokeSession: async () => {}
    });
    expect(cancel).not.toHaveBeenCalled();
    expect((await store.loadDevice(userId))?.approval?.id).toBe(
      'sign_out_pending_approval'
    );
  });

  it('retains keys when an idempotent cancellation leaves the request readable', async () => {
    const { userId, store, cancel, get, readLiveApproval } =
      await pendingApproval();
    get.mockImplementation(readLiveApproval);
    const revokeSession = vi.fn();
    await expect(
      signOutAfterSaving({
        userId,
        keepDevice: false,
        isCurrentSession: () => true,
        savePending: async () => {},
        revokeSession
      })
    ).rejects.toThrow('could not be canceled');
    expect(cancel).toHaveBeenCalledOnce();
    expect((await store.loadDevice(userId))?.approval?.id).toBe(
      'sign_out_pending_approval'
    );
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('retains keys when authorization is revoked before cancellation can be confirmed', async () => {
    const { userId, store, get } = await pendingApproval();
    get.mockRejectedValue(new e2eeApis.E2eeApiError(401, 'Session revoked'));
    const revokeSession = vi.fn();
    await expect(
      signOutAfterSaving({
        userId,
        keepDevice: false,
        isCurrentSession: () => true,
        savePending: async () => {},
        revokeSession
      })
    ).rejects.toThrow('Session revoked');
    expect((await store.loadDevice(userId))?.approval?.id).toBe(
      'sign_out_pending_approval'
    );
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('stops removing keys or revoking a new session if the account changes during cancellation', async () => {
    const { userId, store, cancel } = await pendingApproval();
    let current = true;
    cancel.mockImplementation(async () => {
      current = false;
      return { ok: true };
    });
    const revokeSession = vi.fn();
    await expect(
      signOutAfterSaving({
        userId,
        keepDevice: false,
        isCurrentSession: () => current,
        savePending: async () => {},
        revokeSession
      })
    ).rejects.toThrow('signed-in account changed');
    expect(await store.loadDevice(userId)).not.toBeNull();
    expect(revokeSession).not.toHaveBeenCalled();
  });

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
    const pendingKeyOperation = keyOperationGuard(userId);
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
    expect(pendingKeyOperation).toThrow(DOMException);
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
          expect(unlockedAccount(userId)).toBeUndefined();
          order.push('revoked');
        }
      });
      expect(order).toEqual(['saved', 'revoked']);
      expect(remove).toHaveBeenCalledTimes(keepDevice === false ? 1 : 0);
    }
  );
});
