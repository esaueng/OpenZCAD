/**
 * A request to open one person's verification in Settings › Encryption ›
 * Contacts (ADR-024 Phase 5, slice 5-3b): the sharing dialog's and the
 * invitations list's Verify actions name the person; the contacts list
 * opens their comparison when it next renders. No crypto here.
 */
let requested: string | null = null;
const listeners = new Set<() => void>();

export function requestContactVerification(userId: string): void {
  requested = userId;
  for (const listener of listeners) listener();
}

/** The person to open, once: the request is cleared as it is taken. */
export function takeContactVerificationRequest(): string | null {
  const userId = requested;
  requested = null;
  return userId;
}

export function subscribeContactVerification(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const changeListeners = new Set<() => void>();

/** A contact's standing changed (a verification was signed). */
export function notifyContactsChanged(): void {
  for (const listener of changeListeners) listener();
}

export function subscribeContactsChanged(listener: () => void) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
