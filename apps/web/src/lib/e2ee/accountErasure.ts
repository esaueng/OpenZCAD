import type { DeviceKeyStore } from './deviceStore';
import { deviceKeyStore } from './keychainDeviceKeys';
import * as mlsStores from './mls/sessionStore';
import { lockAccount } from './unlockedKeys';
import { confirmKeySessionEnded } from './keySession';
import { shareWorkStore } from './shareWorkStore';
import { projectAuthorityStore } from './projectAuthorityStore';
import { forgetShelfNames } from '../projectShelfNames';

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
    if (input.userId) {
      lockAccount(input.userId);
      forgetShelfNames(input.userId);
    }
    confirmKeySessionEnded();
    let cleanup: PromiseSettledResult<void>[] = [];
    try {
      if (input.isCurrentSession()) input.onSignedOut();
    } finally {
      // Independent cleanups: one failing must not skip the others.
      if (input.userId) {
        const userId = input.userId;
        cleanup = await Promise.allSettled([
          store.forgetErasedIdentity(userId, pin),
          mlsStores.indexedDbMlsSessionStore().deleteAccount(userId),
          shareWorkStore().deleteAccount(userId),
          projectAuthorityStore().deleteAccount(userId),
          // The erased account's device keys open nothing any more. On
          // desktop the Keychain keys go before the record, so a refused
          // native removal keeps the record and its key id. User ids are
          // stable per email, so the account's own later flows reach it:
          // another erasure or signing out without keeping the device
          // retries the removal, and a new setup reuses the keys.
          store.withDeviceLock(userId, () => store.deleteDevice(userId))
        ]);
      }
    }
    for (const outcome of cleanup)
      if (outcome.status === 'rejected') throw outcome.reason;
  }
  return result;
}
