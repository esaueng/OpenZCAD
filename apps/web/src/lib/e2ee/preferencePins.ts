/**
 * This device's pins of the "Encrypt new projects" opt-in (ADR-024 Phase 4,
 * decision D2): the highest record sequence it accepted and that record's
 * value, per account. Free of any crypto import so `api.ts` can consult the
 * pinned value before sending a plaintext project, without pulling the key
 * code into the entry chunk.
 */

/** The highest preference sequence this device has accepted, per account. */
export interface PreferencePinStore {
  read(userId: string): Promise<number | null>;
  /**
   * Pins `sequence` and, when given, the value of the verified record that
   * carries it. A pin only moves forward.
   */
  write(
    userId: string,
    sequence: number,
    encryptNewProjects?: boolean
  ): Promise<void>;
  /** Whether the newest record this device verified opts the account in. */
  optedIn(userId: string): Promise<boolean>;
}

const PIN_KEY = (userId: string) =>
  `openzcad:e2ee-project-preference-pin:v1:${userId}`;
const OPT_IN_KEY = (userId: string) =>
  `openzcad:e2ee-project-preference-opt-in:v1:${userId}`;

/**
 * Pins in localStorage. Storage that is blocked or cleared loses the pin,
 * which only weakens rollback detection back to first use; it never makes a
 * forged record verify.
 */
export function localStoragePreferencePins(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof window ===
  'undefined'
    ? null
    : window.localStorage
): PreferencePinStore {
  return {
    async read(userId) {
      try {
        const value = Number(storage?.getItem(PIN_KEY(userId)) ?? NaN);
        return Number.isSafeInteger(value) && value >= 1 ? value : null;
      } catch {
        return null;
      }
    },
    async write(userId, sequence, encryptNewProjects) {
      try {
        const current = await this.read(userId);
        // A pin only moves forward, whichever tab writes it; the value
        // follows the record that set it.
        if (current === null || sequence > current) {
          storage?.setItem(PIN_KEY(userId), String(sequence));
        }
        if (
          encryptNewProjects !== undefined &&
          (current === null || sequence >= current)
        ) {
          storage?.setItem(OPT_IN_KEY(userId), encryptNewProjects ? '1' : '0');
        }
      } catch {
        /* Best effort: see above. */
      }
    },
    async optedIn(userId) {
      try {
        return storage?.getItem(OPT_IN_KEY(userId)) === '1';
      } catch {
        return false;
      }
    }
  };
}

export function memoryPreferencePins(): PreferencePinStore {
  const pins = new Map<string, number>();
  const optIns = new Map<string, boolean>();
  return {
    read: async (userId) => pins.get(userId) ?? null,
    write: async (userId, sequence, encryptNewProjects) => {
      const current = pins.get(userId) ?? 0;
      if (sequence > current) pins.set(userId, sequence);
      if (encryptNewProjects !== undefined && sequence >= current) {
        optIns.set(userId, encryptNewProjects);
      }
    },
    optedIn: async (userId) => optIns.get(userId) === true
  };
}
