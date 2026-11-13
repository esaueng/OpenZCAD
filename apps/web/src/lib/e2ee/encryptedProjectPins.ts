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
 * sign-out. Storage that is blocked or cleared loses the pins; this page
 * still keeps the ones it learned until it is reloaded.
 */

export interface EncryptedProjectPinStore {
  /** Whether this device holds the project as encrypted. */
  has(projectId: string): boolean;
  /** Pins the project as encrypted on this device. */
  pin(projectId: string): void;
  /**
   * Unpins the project: only after this device's own decrypt run cut it
   * over to plaintext.
   */
  forget(projectId: string): void;
}

export const ENCRYPTED_PROJECT_PINS_KEY = 'openzcad:e2ee-encrypted-projects:v1';

/**
 * Most pins one device keeps; the oldest go first past it (judgment: tens
 * of thousands of project ids stay well within a localStorage quota).
 */
export const MAX_ENCRYPTED_PROJECT_PINS = 20_000;

const PROJECT_ID = /^[!-~]{1,128}$/;

type PinStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface StorageEvents {
  addEventListener(
    type: 'storage',
    listener: (event: { key: string | null }) => void
  ): void;
}

function defaultStorage(): PinStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Pins in `storage`, mirrored in memory so a check reads no storage. The
 * mirror learns the pins other tabs write (`storage` events); a pin another
 * tab forgets stays pinned here until this page reloads, which only keeps
 * the project on the encrypted routes meanwhile.
 */
export function localStorageEncryptedProjectPins(
  storage: PinStorage | null = defaultStorage(),
  events: StorageEvents | null = typeof window === 'undefined' ? null : window
): EncryptedProjectPinStore {
  const stored = (): string[] => {
    try {
      const value: unknown = JSON.parse(
        storage?.getItem(ENCRYPTED_PROJECT_PINS_KEY) ?? '[]'
      );
      return Array.isArray(value)
        ? value.filter(
            (id): id is string => typeof id === 'string' && PROJECT_ID.test(id)
          )
        : [];
    } catch {
      return [];
    }
  };
  const write = (ids: readonly string[]) => {
    try {
      storage?.setItem(
        ENCRYPTED_PROJECT_PINS_KEY,
        JSON.stringify(ids.slice(-MAX_ENCRYPTED_PROJECT_PINS))
      );
    } catch {
      // Blocked or full: this page's mirror still holds the pin.
    }
  };
  const mirror = new Set(stored());
  events?.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ENCRYPTED_PROJECT_PINS_KEY) return;
    for (const id of stored()) mirror.add(id);
  });
  return {
    has: (projectId) => mirror.has(projectId),
    pin(projectId) {
      // Every listing pins its encrypted projects again: once is enough.
      if (mirror.has(projectId) || !PROJECT_ID.test(projectId)) return;
      mirror.add(projectId);
      // Storage, not the mirror, is written back, so a pin another tab
      // forgot is not restored from this page's mirror.
      const ids = stored();
      if (!ids.includes(projectId)) write([...ids, projectId]);
    },
    forget(projectId) {
      mirror.delete(projectId);
      const ids = stored();
      if (ids.includes(projectId)) write(ids.filter((id) => id !== projectId));
    }
  };
}
