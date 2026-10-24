/**
 * Project keys this page has opened, per account, project and key epoch
 * (ADR-024 Consequences: "Shelf loading unwraps one key per project, cached
 * in memory for the session"). Modeled on `unlockedKeys.ts` and, like it,
 * free of any crypto import so the shell can clear it on every way a key
 * session ends: any teardown zeroes and forgets every key.
 */
import { subscribeKeySession } from './keySession';

const KEY_BYTES = 32;

const keys = new Map<string, Map<string, Map<number, Uint8Array>>>();

/** A copy of the cached key, or undefined; the caller may zero its copy. */
export function unlockedProjectKey(
  userId: string,
  projectId: string,
  keyEpoch: number
): Uint8Array | undefined {
  const key = keys.get(userId)?.get(projectId)?.get(keyEpoch);
  return key ? new Uint8Array(key) : undefined;
}

/** Keep a copy of `key`; a different key already cached for the epoch is refused. */
export function rememberProjectKey(
  userId: string,
  projectId: string,
  keyEpoch: number,
  key: Uint8Array
): void {
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) {
    throw new Error('A project key is cached by its key epoch.');
  }
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new Error('A project key is 32 bytes.');
  }
  let projects = keys.get(userId);
  if (!projects) {
    projects = new Map<string, Map<number, Uint8Array>>();
    keys.set(userId, projects);
  }
  let epochs = projects.get(projectId);
  if (!epochs) {
    epochs = new Map<number, Uint8Array>();
    projects.set(projectId, epochs);
  }
  const known = epochs.get(keyEpoch);
  if (known) {
    if (known.length !== key.length || known.some((b, i) => b !== key[i])) {
      throw new Error(
        `Two different project keys were opened for key epoch ${keyEpoch}.`
      );
    }
    return;
  }
  epochs.set(keyEpoch, new Uint8Array(key));
}

/** Forget (and zero) one account's project keys, or one project's. */
export function forgetProjectKeys(userId: string, projectId?: string): void {
  const projects = keys.get(userId);
  if (!projects) return;
  for (const [id, epochs] of projects) {
    if (projectId !== undefined && id !== projectId) continue;
    for (const key of epochs.values()) key.fill(0);
    projects.delete(id);
  }
  if (projects.size === 0) keys.delete(userId);
}

/** Forget every account's project keys. */
export function forgetAllProjectKeys(): void {
  for (const userId of [...keys.keys()]) forgetProjectKeys(userId);
}

/** Cached keys (tests and diagnostics). */
export function cachedProjectKeyCount(): number {
  let count = 0;
  for (const projects of keys.values())
    for (const epochs of projects.values()) count += epochs.size;
  return count;
}

subscribeKeySession((event) => {
  if (event.phase !== 'ready') forgetAllProjectKeys();
});
