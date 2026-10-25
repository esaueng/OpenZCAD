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
  /**
   * The value pinned with the current sequence, or null when none was. A
   * record at the same sequence never replaces it: two at one sequence are
   * a fork, not an update.
   */
  pinnedValue(userId: string): Promise<boolean | null>;
}

const PIN_KEY = (userId: string) =>
  `openzcad:e2ee-project-preference-pin:v1:${userId}`;
const OPT_IN_KEY = (userId: string) =>
  `openzcad:e2ee-project-preference-opt-in:v1:${userId}`;

type Locks = Pick<LockManager, 'request'>;

/**
 * Pins in localStorage. Storage that is blocked or cleared loses the pin,
 * which only weakens rollback detection back to first use; it never makes a
 * forged record verify.
 *
 * A write reads and writes with no await in between, under a Web Lock per
 * account, so neither another call on this page nor another tab can slip
 * an older sequence or its value in after a newer one.
 */
export function localStoragePreferencePins(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof window ===
  'undefined'
    ? null
    : window.localStorage,
  locks: Locks | null = typeof navigator === 'undefined'
    ? null
    : (navigator.locks ?? null)
): PreferencePinStore {
  const readPin = (userId: string): number | null => {
    try {
      const value = Number(storage?.getItem(PIN_KEY(userId)) ?? NaN);
      return Number.isSafeInteger(value) && value >= 1 ? value : null;
    } catch {
      return null;
    }
  };
  /** The pinned value and the sequence it came with, stored as `seq:0|1`. */
  const readValue = (
    userId: string
  ): { sequence: number; value: boolean } | null => {
    try {
      const match = /^(\d+):([01])$/.exec(
        storage?.getItem(OPT_IN_KEY(userId)) ?? ''
      );
      return match
        ? { sequence: Number(match[1]), value: match[2] === '1' }
        : null;
    } catch {
      return null;
    }
  };
  const writePin = (
    userId: string,
    sequence: number,
    encryptNewProjects: boolean | undefined
  ) => {
    try {
      const current = readPin(userId);
      // A pin only moves forward, whichever tab writes it.
      if (current === null || sequence > current) {
        storage?.setItem(PIN_KEY(userId), String(sequence));
      }
      // The value follows the record that set it; another record at the
      // same sequence is a fork and leaves it.
      const stored = readValue(userId);
      if (
        encryptNewProjects !== undefined &&
        (current === null || sequence >= current) &&
        (stored === null || sequence > stored.sequence)
      ) {
        storage?.setItem(
          OPT_IN_KEY(userId),
          `${sequence}:${encryptNewProjects ? '1' : '0'}`
        );
      }
    } catch {
      /* Best effort: see above. */
    }
  };
  return {
    read: async (userId) => readPin(userId),
    async write(userId, sequence, encryptNewProjects) {
      if (!locks) return writePin(userId, sequence, encryptNewProjects);
      await locks.request(
        `openzcad-e2ee-preference-pin:${userId}`,
        { mode: 'exclusive' },
        async () => writePin(userId, sequence, encryptNewProjects)
      );
    },
    optedIn: async (userId) => readValue(userId)?.value === true,
    async pinnedValue(userId) {
      const stored = readValue(userId);
      return stored !== null && stored.sequence === readPin(userId)
        ? stored.value
        : null;
    }
  };
}

export function memoryPreferencePins(): PreferencePinStore {
  const pins = new Map<string, number>();
  const values = new Map<string, { sequence: number; value: boolean }>();
  return {
    read: async (userId) => pins.get(userId) ?? null,
    write: async (userId, sequence, encryptNewProjects) => {
      const current = pins.get(userId) ?? 0;
      if (sequence > current) pins.set(userId, sequence);
      const stored = values.get(userId);
      if (
        encryptNewProjects !== undefined &&
        sequence >= current &&
        (!stored || sequence > stored.sequence)
      ) {
        values.set(userId, { sequence, value: encryptNewProjects });
      }
    },
    optedIn: async (userId) => values.get(userId)?.value === true,
    pinnedValue: async (userId) => {
      const stored = values.get(userId);
      return stored && stored.sequence === pins.get(userId)
        ? stored.value
        : null;
    }
  };
}
