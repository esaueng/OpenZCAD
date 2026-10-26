/**
 * The account key and encryption private key while this page holds them,
 * per account. Kept apart from `accountKeys.ts`, and free of any crypto
 * import, so the app shell can clear it on every way a session ends
 * (sign-out, expiry, offline mode, account deletion, a different account)
 * without pulling the key code into the entry chunk.
 */
import {
  getKeySessionRevision,
  isCurrentKeySession,
  subscribeKeySession
} from './keySession';

export interface UnlockedAccount {
  readonly generation: number;
  /** Hex of the device list's account-key commitment. */
  readonly commitment: string;
  readonly accountKey: Uint8Array;
  readonly encryptionPrivateKey: CryptoKey;
}

const unlockedAccounts = new Map<string, UnlockedAccount>();
const pendingReads = new Map<string, { scopes: WeakMap<object, object> }>();

/** Capture before any await, including when no unlocked cache entry exists. */
export function captureAccountKeyRead(
  userId: string,
  scope?: object
): () => boolean {
  const reads = pendingReads.get(userId) ?? {
    scopes: new WeakMap<object, object>()
  };
  pendingReads.set(userId, reads);
  const token = scope ? (reads.scopes.get(scope) ?? {}) : null;
  if (scope) reads.scopes.set(scope, token!);
  return () =>
    pendingReads.get(userId) === reads &&
    (!scope || reads.scopes.get(scope) === token);
}

/** A pending passkey prompt cannot outlive view or cross-tab session teardown. */
export function keyOperationGuard(userId: string, scope?: object): () => void {
  const readCurrent = captureAccountKeyRead(userId, scope);
  const revision = getKeySessionRevision();
  return () => {
    if (!readCurrent() || !isCurrentKeySession(revision)) {
      throw new DOMException(
        'The encryption session ended. Sign in again.',
        'AbortError'
      );
    }
  };
}

/** Closing the settings view cancels its loads without locking a valid cache. */
export function invalidateAccountKeyReads(
  userId: string,
  scope?: object
): void {
  if (scope) pendingReads.get(userId)?.scopes.delete(scope);
  else pendingReads.delete(userId);
}

/** A verification failure clears cached secrets without ending a live session. */
export function clearCachedAccountKeys(userId: string): void {
  unlockedAccounts.get(userId)?.accountKey.fill(0);
  unlockedAccounts.delete(userId);
}

export function unlockedAccount(userId: string): UnlockedAccount | undefined {
  return unlockedAccounts.get(userId);
}

export function rememberUnlockedAccount(
  userId: string,
  account: UnlockedAccount
): void {
  clearCachedAccountKeys(userId);
  unlockedAccounts.set(userId, account);
}

/** Forgets this page's unlocked keys for the account. */
export function lockAccount(userId: string): void {
  invalidateAccountKeyReads(userId);
  clearCachedAccountKeys(userId);
}

/** Forgets every account's unlocked keys except `keep`'s. */
export function lockAccountsExcept(keep: string | null): void {
  for (const userId of new Set([
    ...unlockedAccounts.keys(),
    ...pendingReads.keys()
  ])) {
    if (userId !== keep) lockAccount(userId);
  }
}

subscribeKeySession((event) => {
  if (event.phase !== 'ready') lockAccountsExcept(null);
});
