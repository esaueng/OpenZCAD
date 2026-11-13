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
 * naming many other encrypted projects). When storage cannot be read or
 * written, nothing here can say which projects were pinned, so the store is
 * `degraded` and holds every project as encrypted: writes then fail on the
 * encrypted routes instead of going out in plaintext.
 */

export interface EncryptedProjectPinStore {
  /**
   * Whether this device holds the project as encrypted; always true while
   * the store is degraded.
   */
  has(projectId: string): boolean;
  /** Pins the project as encrypted on this device. */
  pin(projectId: string): void;
  /**
   * Unpins the project: only after this device's own decrypt run cut it
   * over to plaintext.
   */
  forget(projectId: string): void;
  /**
   * Whether pins could not be read or saved on this page, so every project
   * is held as encrypted.
   */
  readonly degraded: boolean;
}

/** One key per pinned project: `<prefix><projectId>` = `"1"`. */
export const ENCRYPTED_PROJECT_PIN_PREFIX =
  'openzcad:e2ee-encrypted-project:v1:';

const PROBE_KEY = 'openzcad:e2ee-encrypted-project-probe';

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
  if (storage) {
    try {
      // Storage that refuses a write (blocked, or full) cannot keep a pin
      // made later on this page either.
      storage.setItem(PROBE_KEY, '1');
      storage.removeItem(PROBE_KEY);
    } catch {
      degraded = true;
    }
  }
  const stored = (projectId: string): boolean => {
    if (!storage) return false;
    try {
      // Any value at the key is a pin: only `forget` removes one.
      return storage.getItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId) !== null;
    } catch {
      degraded = true;
      return true;
    }
  };
  return {
    get degraded() {
      return degraded;
    },
    has(projectId) {
      if (degraded) return true;
      if (!PROJECT_ID.test(projectId)) return false;
      return own.has(projectId) || stored(projectId);
    },
    pin(projectId) {
      if (!PROJECT_ID.test(projectId)) return;
      own.add(projectId);
      if (!storage) return;
      try {
        storage.setItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId, '1');
      } catch {
        // Not saved, so a reload would not know it: hold everything as
        // encrypted on this page rather than lose track of this one.
        degraded = true;
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
