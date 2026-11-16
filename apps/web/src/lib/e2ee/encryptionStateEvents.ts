import type { EncryptionState } from './accountKeys';
import { getKeySessionRevision } from './keySession';

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

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * What the page's encrypted-project clients capture of the account: its
 * identity, device-list head, this device's standing and whether it is
 * unlocked. Two loads with the same key need no new clients.
 */
export function encryptionStateKey(state: EncryptionState): string {
  switch (state.kind) {
    case 'not-set-up':
      return 'not-set-up';
    case 'fork':
      return `fork:${state.message}`;
    default: {
      const { account } = state;
      return JSON.stringify([
        state.kind,
        account.userId,
        account.generation,
        account.fingerprint,
        hex(account.list.pin.identityKeyHash),
        account.list.pin.sequence,
        hex(account.list.pin.entryHash),
        account.device?.deviceId ?? null,
        account.deviceStatus,
        account.unlocked
      ]);
    }
  }
}

/** The account state this page last acted on, per user and key session. */
const observed = new Map<string, { revision: number; key: string }>();

/**
 * Records `state` as the account state this page last loaded, and says
 * whether it differs from the one before it in this key session (or is the
 * first). A read-only reload that finds the same state need not announce
 * it: announcing retires every encrypted-project client and its verified
 * caches, so the shelf's next listing reads each project's authority and
 * device lists again (Settings › Encryption › Refresh spent the account's
 * read budget that way). Only callers that announce a change, or whose own
 * clients hold `state`, record it.
 */
export function observeEncryptionState(
  userId: string,
  state: EncryptionState
): boolean {
  const revision = getKeySessionRevision();
  const key = encryptionStateKey(state);
  const previous = observed.get(userId);
  observed.set(userId, { revision, key });
  return previous?.revision !== revision || previous.key !== key;
}
