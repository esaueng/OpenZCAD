/**
 * Encryption setup open in this page (Settings' setup dialog, L11 slice 5).
 * While it is, default-on automatic migration waits: existing projects are
 * encrypted only when the dialog's last screen says so, never because the
 * account became ready halfway through it. Releasing the last hold for an
 * account tells the waiting controller to check again.
 */
const holds = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** Holds automatic migration for `userId`; the returned call releases it. */
export function holdForSetup(userId: string): () => void {
  holds.set(userId, (holds.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(userId) ?? 1) - 1;
    if (left > 0) {
      holds.set(userId, left);
      return;
    }
    holds.delete(userId);
    for (const listener of [...(listeners.get(userId) ?? [])]) listener();
  };
}

export function setupInProgress(userId: string): boolean {
  return (holds.get(userId) ?? 0) > 0;
}

/** Called each time the last hold for `userId` is released. */
export function subscribeSetupReleased(
  userId: string,
  listener: () => void
): () => void {
  const set = listeners.get(userId) ?? new Set();
  set.add(listener);
  listeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
}
