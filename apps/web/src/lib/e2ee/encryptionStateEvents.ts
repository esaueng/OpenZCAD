/** Notifications carry no key material; background setup rechecks all authority. */
const listeners = new Map<string, Set<() => void>>();

export function encryptionStateChanged(userId: string): void {
  for (const listener of listeners.get(userId) ?? []) listener();
}

export function subscribeEncryptionState(
  userId: string,
  listener: () => void
): () => void {
  const account = listeners.get(userId) ?? new Set<() => void>();
  listeners.set(userId, account);
  account.add(listener);
  return () => {
    account.delete(listener);
    if (!account.size) listeners.delete(userId);
  };
}
