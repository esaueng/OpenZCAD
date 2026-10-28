import { lockAccount } from './unlockedKeys';
import type { DeviceKeyStore } from './deviceStore';
import { deviceKeyStore } from './keychainDeviceKeys';
import * as mlsStores from './mls/sessionStore';
import { createE2eeApi } from './e2eeApi';
import { confirmApprovalCancellation } from './approvalCancellation';
import { shareWorkStore } from './shareWorkStore';
import { projectAuthorityStore } from './projectAuthorityStore';
import { forgetShelfNames } from '../projectShelfNames';
import {
  beginKeySessionTeardown,
  finishKeySessionTeardown
} from './keySession';

export interface DeviceKeySignOutChoice {
  readonly userId: string;
  readonly keepDevice?: boolean;
}

/**
 * Ends this page's hold on the account's keys at sign-out. Keeping the
 * device unlocked leaves its device key in this browser for the next
 * sign-in; declining deletes it with the session (ADR-024, Key lifecycle),
 * together with the account's MLS state key and sealed project sessions.
 * The device stays listed until another device removes it.
 */
export async function endKeySession(
  userId: string,
  keepDevice: boolean,
  requireCurrentSession: () => void
): Promise<void> {
  const store = deviceKeyStore();
  await store.withDeviceLock(userId, () =>
    clearDeviceUnderLock(store, userId, keepDevice, requireCurrentSession)
  );
}

async function clearDeviceUnderLock(
  store: DeviceKeyStore,
  userId: string,
  keepDevice: boolean,
  requireCurrentSession: () => void
): Promise<void> {
  requireCurrentSession();
  lockAccount(userId);
  forgetShelfNames(userId);
  if (!keepDevice) {
    const device = await store.loadDevice(userId);
    requireCurrentSession();
    if (device?.approval) {
      // Keep the request ID and keys if cancellation cannot finish; the user
      // can retry without leaving an approvable request for discarded keys.
      await confirmApprovalCancellation(
        createE2eeApi(),
        device.approval.id,
        requireCurrentSession
      );
    }
    requireCurrentSession();
    // Remove journals and MLS state before the device keys. A failed cleanup
    // keeps the device record so signing out can be retried.
    await shareWorkStore().deleteAccount(userId);
    requireCurrentSession();
    await projectAuthorityStore().deleteAccount(userId);
    requireCurrentSession();
    await mlsStores.indexedDbMlsSessionStore().deleteAccount(userId);
    requireCurrentSession();
    await store.deleteDevice(userId);
  }
}

/** Save with the live session, then finish its key choice before revoking it. */
export async function signOutAfterSaving(input: {
  userId: string | null;
  keepDevice?: boolean;
  isCurrentSession(): boolean;
  savePending(): Promise<void>;
  revokeSession(): Promise<unknown>;
}): Promise<void> {
  const requireCurrentSession = () => {
    if (!input.isCurrentSession()) {
      throw new Error('The signed-in account changed. Try signing out again.');
    }
  };
  requireCurrentSession();
  await input.savePending();
  requireCurrentSession();
  const teardown = beginKeySessionTeardown();
  try {
    if (input.userId && input.keepDevice !== undefined) {
      const store = deviceKeyStore();
      const userId = input.userId;
      const keepDevice = input.keepDevice;
      await store.withDeviceLock(userId, async () => {
        await clearDeviceUnderLock(
          store,
          userId,
          keepDevice,
          requireCurrentSession
        );
        requireCurrentSession();
        await input.revokeSession();
        // Invalidate queued writers before releasing the shared device lock.
        finishKeySessionTeardown(teardown.operation, true);
      });
    } else {
      requireCurrentSession();
      await input.revokeSession();
      finishKeySessionTeardown(teardown.operation, true);
    }
  } catch (error) {
    finishKeySessionTeardown(teardown.operation, false);
    throw error;
  }
}
