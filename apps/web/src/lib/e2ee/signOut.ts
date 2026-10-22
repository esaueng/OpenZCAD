import { lockAccount } from './unlockedKeys';
import { indexedDbDeviceStore } from './deviceStore';
import { createE2eeApi } from './e2eeApi';

export interface DeviceKeySignOutChoice {
  readonly userId: string;
  readonly keepDevice?: boolean;
}

/**
 * Ends this page's hold on the account's keys at sign-out. Keeping the
 * device unlocked leaves its device key in this browser for the next
 * sign-in; declining deletes it with the session (ADR-024, Key lifecycle).
 * The device stays listed until another device removes it.
 */
export async function endKeySession(
  userId: string,
  keepDevice: boolean,
  requireCurrentSession: () => void
): Promise<void> {
  requireCurrentSession();
  lockAccount(userId);
  if (!keepDevice) {
    const store = indexedDbDeviceStore();
    const device = await store.loadDevice(userId);
    requireCurrentSession();
    if (device?.approval) {
      // Keep the request ID and keys if cancellation cannot finish; the user
      // can retry without leaving an approvable request for discarded keys.
      await createE2eeApi().cancelApproval(device.approval.id);
      requireCurrentSession();
    }
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
  if (input.userId && input.keepDevice !== undefined) {
    await endKeySession(input.userId, input.keepDevice, requireCurrentSession);
  }
  requireCurrentSession();
  await input.revokeSession();
}
