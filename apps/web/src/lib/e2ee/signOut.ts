import { lockAccount } from './unlockedKeys';
import { indexedDbDeviceStore } from './deviceStore';

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
  keepDevice: boolean
): Promise<void> {
  lockAccount(userId);
  if (!keepDevice) await indexedDbDeviceStore().deleteDevice(userId);
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
    await endKeySession(input.userId, input.keepDevice);
  }
  requireCurrentSession();
  await input.revokeSession();
}
