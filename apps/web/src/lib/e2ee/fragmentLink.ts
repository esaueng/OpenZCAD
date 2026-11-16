/**
 * A link whose value travels in the URL fragment (`#<key>=<value>`), so it
 * never reaches the server: taken off the address bar at once and kept for
 * this tab, so a sign-in or unlock in between does not lose it. Shared by
 * the encrypted invitation link and the device approval link, which the
 * entry chunk loads (no crypto here).
 */
import { projectLinkPath } from '../projectShareLink';

export interface FragmentLink {
  /** The value of a well-formed fragment, or null. */
  fromHash(hash: string): string | null;
  /** Whether the fragment is this kind of link, valid or not. */
  isHash(hash: string): boolean;
  /** Scrubs the fragment and keeps a valid value for this tab. */
  capture(
    location?: Pick<Location, 'hash' | 'pathname' | 'search'>,
    history?: Pick<History, 'replaceState' | 'state'>,
    storage?: Pick<Storage, 'setItem'>
  ): string | null;
  /** The captured value this tab has not used yet. */
  pending(storage?: Pick<Storage, 'getItem'>): string | null;
  clear(storage?: Pick<Storage, 'removeItem'>): void;
  /** Called when a value is captured or cleared. */
  subscribe(listener: () => void): () => void;
}

export function fragmentLink(
  key: string,
  sessionKey: string,
  valid: RegExp,
  normalize: (value: string) => string = (value) => value
): FragmentLink {
  const prefix = `#${key}=`;
  const listeners = new Set<() => void>();
  let memory: string | null = null;
  const notify = () => listeners.forEach((listener) => listener());
  const fromHash = (hash: string) => {
    if (!hash.startsWith(prefix)) return null;
    const parameters = new URLSearchParams(hash.slice(1));
    const values = parameters.getAll(key);
    if (values.length !== 1 || [...parameters.keys()].some((k) => k !== key))
      return null;
    const value = normalize(values[0] ?? '');
    return valid.test(value) ? value : null;
  };
  return {
    fromHash,
    isHash: (hash) => hash.startsWith(prefix),
    capture(
      location = globalThis.location,
      history = globalThis.history,
      storage = globalThis.sessionStorage
    ) {
      if (!location.hash.startsWith(prefix)) return null;
      const value = fromHash(location.hash);
      history.replaceState(history.state, '', projectLinkPath(location));
      if (!value) return null;
      memory = value;
      try {
        storage.setItem(sessionKey, value);
      } catch {
        // A blocked storage API keeps the value for this page only.
      }
      notify();
      return value;
    },
    pending(storage = globalThis.sessionStorage) {
      try {
        const stored = storage.getItem(sessionKey);
        if (stored && valid.test(stored)) return stored;
      } catch {
        // Fall back to this page's copy.
      }
      return memory;
    },
    clear(storage = globalThis.sessionStorage) {
      memory = null;
      try {
        storage.removeItem(sessionKey);
      } catch {
        // Nothing to clear.
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
