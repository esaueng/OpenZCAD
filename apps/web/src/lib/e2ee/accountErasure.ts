import type { DeviceKeyStore } from './deviceStore';
import { deviceKeyStore } from './keychainDeviceKeys';
import * as mlsStores from './mls/sessionStore';
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
    let cleanup: PromiseSettledResult<void>[] = [];
    try {
      if (input.isCurrentSession()) input.onSignedOut();
    } finally {
      // Separate databases: one failing cleanup must not skip the other.
      if (input.userId)
        cleanup = await Promise.allSettled([
          store.forgetErasedIdentity(input.userId, pin),
          mlsStores.indexedDbMlsSessionStore().deleteAccount(input.userId)
        ]);
    }
    for (const outcome of cleanup)
      if (outcome.status === 'rejected') throw outcome.reason;
  }
  return result;
}
