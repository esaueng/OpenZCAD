/**
 * The account key and encryption private key while this page holds them,
 * per account. Kept apart from `accountKeys.ts`, and free of any crypto
 * import, so the app shell can clear it on every way a session ends
 * (sign-out, expiry, offline mode, account deletion, a different account)
 * without pulling the key code into the entry chunk.
 */
export interface UnlockedAccount {
  readonly generation: number;
  /** Hex of the device list's account-key commitment. */
  readonly commitment: string;
  readonly accountKey: Uint8Array;
  readonly encryptionPrivateKey: CryptoKey;
}

const unlockedAccounts = new Map<string, UnlockedAccount>();
const keyOperationVersions = new Map<string, number>();

/** A pending passkey prompt must not outlive session teardown. */
export function keyOperationGuard(userId: string): () => void {
  const version = keyOperationVersions.get(userId) ?? 0;
  keyOperationVersions.set(userId, version);
  return () => {
    if (keyOperationVersions.get(userId) !== version) {
      throw new DOMException(
        'The encryption session ended. Sign in again.',
        'AbortError'
      );
    }
  };
}

export function unlockedAccount(userId: string): UnlockedAccount | undefined {
  return unlockedAccounts.get(userId);
}

export function rememberUnlockedAccount(
  userId: string,
  account: UnlockedAccount
): void {
  unlockedAccounts.get(userId)?.accountKey.fill(0);
  unlockedAccounts.set(userId, account);
}

/** Forgets this page's unlocked keys for the account. */
export function lockAccount(userId: string): void {
  keyOperationVersions.set(userId, (keyOperationVersions.get(userId) ?? 0) + 1);
  unlockedAccounts.get(userId)?.accountKey.fill(0);
  unlockedAccounts.delete(userId);
}

/** Forgets every account's unlocked keys except `keep`'s. */
export function lockAccountsExcept(keep: string | null): void {
  for (const userId of new Set([
    ...unlockedAccounts.keys(),
    ...keyOperationVersions.keys()
  ])) {
    if (userId !== keep) lockAccount(userId);
  }
}
