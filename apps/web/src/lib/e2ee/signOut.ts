import { lockAccount } from './unlockedKeys';
import { indexedDbDeviceStore } from './deviceStore';

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
