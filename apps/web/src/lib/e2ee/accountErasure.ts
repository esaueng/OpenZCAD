import type { DeviceKeyStore } from './deviceStore';
import { deviceKeyStore } from './keychainDeviceKeys';
import { lockAccount } from './unlockedKeys';
import { confirmKeySessionEnded } from './keySession';

/** Only the successful, explicitly requested erasure may reset local trust. */
export async function eraseAccountWithKeyCleanup<
  T extends { signedOut: boolean }
>(input: {
  userId: string | null;
  isCurrentSession(): boolean;
  erase(): Promise<T>;
  onSignedOut(): void;
  store?: DeviceKeyStore;
}): Promise<T> {
  const requireCurrent = () => {
    if (!input.isCurrentSession())
      throw new Error('The signed-in account changed. Try deleting again.');
  };
  requireCurrent();
  const store = input.store ?? deviceKeyStore();
  const pin = input.userId ? await store.loadPin(input.userId) : null;
  requireCurrent();
  const result = await input.erase();
  if (result.signedOut) {
    // Synchronous: neither a failed IndexedDB write nor a failed library read
    // may leave the erased account's raw key in this page.
    if (input.userId) lockAccount(input.userId);
    confirmKeySessionEnded();
    try {
      if (input.isCurrentSession()) input.onSignedOut();
    } finally {
      if (input.userId) await store.forgetErasedIdentity(input.userId, pin);
    }
  }
  return result;
}
