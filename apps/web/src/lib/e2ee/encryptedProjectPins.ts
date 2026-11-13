/**
 * This device's pins of which projects are end-to-end encrypted (ADR-024
 * Phase 4, format 2). Once this device has seen a project as encrypted (in
 * the account's listing, by creating, copying or encrypting it, or from a
 * route that answered that it is), every write, upload, thumbnail, room and
 * measurement of that project goes through the encrypted routes, also after
 * a reload, whatever a later listing says of its format.
 *
 * Only this device's own "Stop encrypting" run, once its cutover is done
 * (`projectDecryption.ts`), unpins a project: the account's listing alone
 * never does, since a listing that disagrees with the pin is the account's
 * word, not the owner's. Such a project stays encrypted here, and its
 * writes fail on the encrypted routes rather than go out in plaintext.
 *
 * Kept in localStorage, as the "Encrypt new projects" opt-in pins are
 * (`preferencePins.ts`), because the dispatch in `api.ts` and the rooms ask
 * synchronously, before anything is sent; free of any crypto import for the
 * same reason. Pins are per device, by project id (ids are unique across
 * accounts), and like the version pins (`versionPins.ts`) are not cleared at
 * sign-out.
 *
 * Each pin is its own storage key, so tabs never read-modify-write a shared
 * list (one tab's write cannot drop another's pin), and there is no limit
 * past which old pins are dropped (a listing cannot push a pin out by
 * naming many other encrypted projects).
 *
 * When storage cannot be read, or a pin could not be saved, nothing here
 * can say which projects were pinned, so the store is `degraded` and holds
 * every project as encrypted: writes then fail on the encrypted routes
 * instead of going out in plaintext. A pin that could not be saved sets a
 * failure key that nothing here ever clears or overwrites, so every tab
 * and every later load stays degraded. To make room for that key in full
 * storage, a reserve key larger than it is kept and removed first. Where
 * even the failure key cannot be saved, `api.ts` refuses to open, create,
 * copy or encrypt a project whose pin is not saved (`pinDurably`), so no
 * encrypted project's content reaches this device without a saved pin.
 */

export interface EncryptedProjectPinStore {
  /**
   * Whether this device holds the project as encrypted; always true while
   * the store is degraded.
   */
  has(projectId: string): boolean;
  /**
   * Pins the project as encrypted on this device; whether the pin is saved
   * (read back from storage) so a reload still knows it.
   */
  pin(projectId: string): boolean;
  /**
   * Whether the project's pin is saved, pinning it first if not. A degraded
   * store pins nothing new (it cannot tell an encrypted project from one
   * it only holds as encrypted), so only an already saved pin counts.
   */
  pinDurably(projectId: string): boolean;
  /**
   * Whether a pin can be saved right now (a pin-sized write is read back
   * and removed), and the store is not degraded: checked before a step that
   * cannot be undone needs one, such as an encrypt cutover.
   */
  writable(): boolean;
  /**
   * Unpins the project: only after this device's own decrypt run cut it
   * over to plaintext.
   */
  forget(projectId: string): void;
  /**
   * Whether pins cannot be read, or one could not be saved (on this page,
   * another tab or an earlier load), so every project is held as encrypted.
   */
  readonly degraded: boolean;
}

/** One key per pinned project: `<prefix><projectId>` = `"1"`. */
export const ENCRYPTED_PROJECT_PIN_PREFIX =
  'openzcad:e2ee-encrypted-project:v1:';

/** Set once a pin could not be saved; never cleared or overwritten here. */
export const ENCRYPTED_PROJECT_PIN_FAILED_KEY =
  'openzcad:e2ee-encrypted-project-pins:failed';

/**
 * Larger than the failure key and its value, and removed just before that
 * key is set, so full storage has room for it.
 */
export const ENCRYPTED_PROJECT_PIN_RESERVE_KEY =
  'openzcad:e2ee-encrypted-project-pins:reserve';
const RESERVE_VALUE = '.'.repeat(256);

const PROJECT_ID = /^[!-~]{1,128}$/;

type PinStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Pins that last as long as the page, where there is no browser storage. */
function memoryStorage(): PinStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
}

/**
 * The page's localStorage; `null` (degraded) when a browser blocks it. Off
 * the browser (tests, tooling) there is no reload to remember pins across,
 * so memory is enough.
 */
function defaultStorage(): PinStorage | null {
  if (typeof window === 'undefined') return memoryStorage();
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Pins in `storage`, one key each. This page's own pins are also kept in
 * memory, so a pin made while storage refuses writes still holds here.
 */
export function localStorageEncryptedProjectPins(
  storage: PinStorage | null = defaultStorage()
): EncryptedProjectPinStore {
  const own = new Set<string>();
  let degraded = storage === null;
  const failed = (): boolean => {
    if (!storage) return false;
    try {
      return storage.getItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY) !== null;
    } catch {
      return true;
    }
  };
  if (storage && failed()) degraded = true;
  if (storage && !degraded) {
    try {
      // Without the reserve, a later failed pin might find no room to be
      // recorded; storage that refuses it now cannot keep pins either.
      if (storage.getItem(ENCRYPTED_PROJECT_PIN_RESERVE_KEY) === null) {
        storage.setItem(ENCRYPTED_PROJECT_PIN_RESERVE_KEY, RESERVE_VALUE);
      }
    } catch {
      degraded = true;
    }
  }
  const isDegraded = (): boolean => {
    // Another tab's failed pin degrades this page too.
    if (!degraded && failed()) degraded = true;
    return degraded;
  };
  const stored = (projectId: string): boolean => {
    if (!storage) return false;
    try {
      // Any value at the key is a pin: only `forget` removes one.
      return storage.getItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId) !== null;
    } catch {
      degraded = true;
      return false;
    }
  };
  const recordFailure = () => {
    degraded = true;
    if (!storage) return;
    try {
      storage.removeItem(ENCRYPTED_PROJECT_PIN_RESERVE_KEY);
    } catch {
      // The failure key may still fit.
    }
    try {
      storage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
    } catch {
      // Not recorded: this page stays degraded, and `pinDurably` keeps
      // the project's content off this device.
    }
  };
  const pin = (projectId: string): boolean => {
    if (!PROJECT_ID.test(projectId)) return false;
    own.add(projectId);
    if (!storage) return false;
    try {
      storage.setItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId, '1');
    } catch {
      // Fall through to the read-back.
    }
    if (stored(projectId)) return true;
    // Not saved, so a reload would not know it: hold everything as
    // encrypted, here, in other tabs and after a reload.
    recordFailure();
    return false;
  };
  return {
    get degraded() {
      return isDegraded();
    },
    has(projectId) {
      if (isDegraded()) return true;
      if (!PROJECT_ID.test(projectId)) return false;
      // A read that throws degrades the store, so ask again after it.
      return own.has(projectId) || stored(projectId) || degraded;
    },
    pin,
    pinDurably(projectId) {
      if (!PROJECT_ID.test(projectId)) return false;
      if (stored(projectId)) return true;
      if (isDegraded()) return false;
      return pin(projectId);
    },
    writable() {
      if (!storage || isDegraded()) return false;
      const probe = `${ENCRYPTED_PROJECT_PIN_PREFIX}${'~'.repeat(128)}`;
      try {
        storage.setItem(probe, '1');
        const saved = storage.getItem(probe) === '1';
        storage.removeItem(probe);
        return saved;
      } catch {
        return false;
      }
    },
    forget(projectId) {
      own.delete(projectId);
      if (!storage) return;
      try {
        storage.removeItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId);
      } catch {
        // Still pinned in storage: it stays encrypted, which is safe.
      }
    }
  };
}
