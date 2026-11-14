/**
 * This device's pins of which projects are end-to-end encrypted (ADR-024
 * Phase 4, format 2). Once this device has seen a project as encrypted (in
 * the account's listing, by creating, copying or encrypting it, or from a
 * route that answered that it is), every write, upload, thumbnail, room and
 * measurement of that project goes through the encrypted routes, also after
 * a reload, whatever a later listing says of its format.
 *
 * Only this device's own "Stop encrypting" run, once its cutover is done
 * (`projectDecryption.ts`), or the owner's own confirmed "Treat as not
 * encrypted on this device" (`resetProject`), unpins a project: the
 * account's listing alone never does, since a listing that disagrees with
 * the pin is the account's word, not the owner's. Such a project stays
 * encrypted here, and its writes fail on the encrypted routes rather than
 * go out in plaintext.
 *
 * An encrypt run pins the project before it asks for the cutover, and
 * records beside the pin that the cutover's outcome is unknown here
 * (`markCutoverUnresolved`). Only this device's own cutover call answering
 * success in the same run, or the owner's confirmed reset, clears that
 * record (`resolveCutover`, `resetProject`); until then the project is
 * read-only here, and work that must know its real format (a complete
 * backup) refuses.
 *
 * Tabs share the pins but not their memory of them. A pin this tab has
 * seen stays held here even if its key goes, and every unpin (a reset or
 * this device's decrypt run) and every reset of a degraded store saves a
 * new reset generation (`ENCRYPTED_PROJECT_RESET_PREFIX`,
 * `ENCRYPTED_PROJECT_PINS_RESET_KEY`). A tab compares the generation it
 * first saw on every check; once another tab has moved it, this tab holds
 * the project (or, for the store, every project) as encrypted, pins
 * nothing for it, and reports it reset elsewhere (`resetElsewhere`) so no
 * write goes out until the tab reloads.
 *
 * Kept in localStorage, as the "Encrypt new projects" opt-in pins are
 * (`preferencePins.ts`), because the dispatch in `api.ts` and the rooms ask
 * synchronously, before anything is sent; free of any crypto import for the
 * same reason. Pins are per device, by project id (ids are unique across
 * accounts), and like the version pins (`versionPins.ts`) are not cleared at
 * sign-out.
 *
 * Each pin and each unresolved record is kept under a key of its own for
 * the project's reset generation it was written under
 * (`<prefix><projectId>:<generation>`, `NO_RESET` before the first reset),
 * and only the record of the generation saved now counts. A tab that
 * checked an older generation and writes after another tab reset the
 * project writes a key nobody reads: it cannot undo that reset, nor
 * overwrite a pin or record another tab made under the newer generation,
 * however the tabs' storage operations interleave. A reset removes the
 * records of the generations it replaced, and those of any generation
 * saved before it that a stale tab left behind, never one of the
 * generation saved now or of a newer one another tab may have written
 * meanwhile. A record kept under
 * the bare `<prefix><projectId>` (written before records had generation
 * keys) still counts unless it names an older generation, as is safe.
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
 * and every later load stays degraded, until the owner confirms "Treat as
 * not encrypted on this device" for the store (`resetDegraded`), which
 * removes the failure key and keeps every saved pin. To make room for that
 * key in full storage, a reserve key larger than it is kept and removed
 * first. Where
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
   * Unpins the project: only after this device's own decrypt run cut it
   * over to plaintext. Other tabs see it reset elsewhere.
   */
  forget(projectId: string): void;
  /**
   * Records, beside the pin, that this device is about to ask for the
   * project's encrypt cutover and has not seen it complete; whether that
   * record is saved (read back). One that could not be saved degrades the
   * store, as a pin does.
   */
  markCutoverUnresolved(projectId: string): boolean;
  /**
   * Clears that record: this device's own cutover call answered success
   * in the same run. Never on a status or listing alone.
   */
  resolveCutover(projectId: string): void;
  /**
   * Whether this device asked for the project's encrypt cutover and has
   * not seen it complete; true when storage cannot be read.
   */
  cutoverUnresolved(projectId: string): boolean;
  /**
   * The owner's confirmed "Treat as not encrypted on this device" for one
   * project: drops its pin and its unresolved record. Never called on the
   * account's word.
   */
  resetProject(projectId: string): void;
  /**
   * The owner's confirmed reset of a degraded store: removes the failure
   * key and keeps every saved pin, then saves the reserve again. This
   * tab forgets what it held only in memory, as a reload would; other
   * tabs see the store reset elsewhere. Whether the store now works
   * normally (false while storage stays blocked or full, or the failure
   * key could not be removed).
   */
  resetDegraded(): boolean;
  /**
   * Whether another tab unpinned or reset this project, or reset the
   * store, since this tab first saw it: this tab holds it as encrypted,
   * pins nothing for it, and must reload before it writes it.
   */
  resetElsewhere(projectId: string): boolean;
  /** Whether this tab has seen any reset made elsewhere. */
  readonly staleTab: boolean;
  /**
   * Whether pins cannot be read, or one could not be saved (on this page,
   * another tab or an earlier load), so every project is held as encrypted.
   */
  readonly degraded: boolean;
}

/**
 * One key per pinned project and reset generation:
 * `<prefix><projectId>:<generation>` (`encryptedProjectPinKey`).
 */
export const ENCRYPTED_PROJECT_PIN_PREFIX =
  'openzcad:e2ee-encrypted-project:v1:';

/**
 * One key per project whose encrypt cutover this device asked for and has
 * not seen complete, and reset generation:
 * `<prefix><projectId>:<generation>` (`encryptCutoverUnresolvedKey`).
 */
export const ENCRYPTED_PROJECT_UNRESOLVED_PREFIX =
  'openzcad:e2ee-encrypt-cutover-unresolved:v1:';

/**
 * One key per project unpinned on this device (a reset or a decrypt run):
 * `<prefix><projectId>` = a new token each time. Other tabs compare it
 * with the token they first saw.
 */
export const ENCRYPTED_PROJECT_RESET_PREFIX =
  'openzcad:e2ee-encrypted-project-reset:v1:';

/** A new token on each confirmed reset of a degraded store. */
export const ENCRYPTED_PROJECT_PINS_RESET_KEY =
  'openzcad:e2ee-encrypted-project-pins:reset';

/**
 * Set once a pin could not be saved; cleared only by the owner's confirmed
 * reset (`resetDegraded`), never overwritten.
 */
export const ENCRYPTED_PROJECT_PIN_FAILED_KEY =
  'openzcad:e2ee-encrypted-project-pins:failed';

/**
 * Larger than the failure key and its value, and removed just before that
 * key is set, so full storage has room for it.
 */
export const ENCRYPTED_PROJECT_PIN_RESERVE_KEY =
  'openzcad:e2ee-encrypted-project-pins:reserve';
const RESERVE_VALUE = '.'.repeat(256);

/**
 * The generation a pin or unresolved record carries while the project has
 * never been reset here. Reset tokens always contain a `.`, so never this.
 */
export const NO_RESET = '1';
/** `NO_RESET` or a reset token (`resetToken`). */
const GENERATION = /^(?:1|[0-9a-z]+\.[0-9A-Za-z-]+)$/;

/** Printable, without `:`, so a generation key names one project. */
const PROJECT_ID = /^[!-9;-~]{1,128}$/;

/** The pin of `projectId` written under `generation`. */
export function encryptedProjectPinKey(
  projectId: string,
  generation: string = NO_RESET
): string {
  return `${ENCRYPTED_PROJECT_PIN_PREFIX}${projectId}:${generation}`;
}

/** The unresolved-cutover record of `projectId` under `generation`. */
export function encryptCutoverUnresolvedKey(
  projectId: string,
  generation: string = NO_RESET
): string {
  return `${ENCRYPTED_PROJECT_UNRESOLVED_PREFIX}${projectId}:${generation}`;
}

type PinStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
  Partial<Pick<Storage, 'key' | 'length'>>;

/**
 * When a reset generation was saved: 0 for `NO_RESET`, which precedes
 * every reset; null for a value that is not a generation, whose age
 * nothing here can tell.
 */
function generationTime(generation: string): number | null {
  if (generation === NO_RESET) return 0;
  if (!GENERATION.test(generation)) return null;
  const time = parseInt(generation.slice(0, generation.indexOf('.')), 36);
  return Number.isSafeInteger(time) ? time : null;
}

function resetToken(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}.${random}`;
}

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
  const reserve = () => {
    if (!storage || degraded) return;
    try {
      // Without the reserve, a later failed pin might find no room to be
      // recorded; storage that refuses it now cannot keep pins either.
      if (storage.getItem(ENCRYPTED_PROJECT_PIN_RESERVE_KEY) === null) {
        storage.setItem(ENCRYPTED_PROJECT_PIN_RESERVE_KEY, RESERVE_VALUE);
      }
    } catch {
      degraded = true;
    }
  };
  if (storage && failed()) degraded = true;
  reserve();
  const isDegraded = (): boolean => {
    // Another tab's failed pin degrades this page too.
    if (!degraded && failed()) degraded = true;
    return degraded;
  };
  /** A key's value; `undefined` when storage cannot be read. */
  const read = (key: string): string | null | undefined => {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch {
      return undefined;
    }
  };
  /** The store's reset generation this tab started with. */
  let storeReset = read(ENCRYPTED_PROJECT_PINS_RESET_KEY);
  let storeStale = false;
  /** Each project's reset generation as this tab first saw it. */
  const seenResets = new Map<string, string | null>();
  const staleProjects = new Set<string>();
  const storeResetElsewhere = (): boolean => {
    if (storeStale) return true;
    const current = read(ENCRYPTED_PROJECT_PINS_RESET_KEY);
    if (current === undefined || storeReset === undefined) return false;
    storeStale = current !== storeReset;
    return storeStale;
  };
  const resetElsewhere = (projectId: string): boolean => {
    if (storeResetElsewhere()) return true;
    if (staleProjects.has(projectId)) return true;
    const current = read(ENCRYPTED_PROJECT_RESET_PREFIX + projectId);
    if (current === undefined) return false;
    if (!seenResets.has(projectId)) {
      // First seen now: what this tab holds of it starts here.
      seenResets.set(projectId, current);
      return false;
    }
    if (seenResets.get(projectId) === current) return false;
    // Until a reload: this tab's memory of it is out of date.
    staleProjects.add(projectId);
    return true;
  };
  /** Saves a new reset generation for the project, as this tab's own. */
  const markReset = (projectId: string) => {
    staleProjects.delete(projectId);
    if (storage) {
      try {
        storage.setItem(
          ENCRYPTED_PROJECT_RESET_PREFIX + projectId,
          resetToken()
        );
      } catch {
        // Not saved: another tab keeps the pin it saw (held in its
        // memory), so it stays encrypted there, which is safe.
      }
    }
    seenResets.set(
      projectId,
      read(ENCRYPTED_PROJECT_RESET_PREFIX + projectId) ?? null
    );
  };
  /**
   * The generation this tab writes the project's records under: the one
   * it first saw, never one re-read just before the write, so a reset made
   * in between leaves the write tagged older and so absent. `undefined`
   * when storage could not say.
   */
  const writeTag = (projectId: string): string | undefined =>
    seenResets.has(projectId)
      ? (seenResets.get(projectId) ?? NO_RESET)
      : undefined;
  /**
   * Whether the project has a record under `prefix` for the generation
   * saved now; `undefined` when storage cannot be read. Records of older
   * generations are not read at all: a tab that had not seen a reset may
   * still write one, and it changes nothing.
   */
  const current = (prefix: string, projectId: string): boolean | undefined => {
    const saved = read(ENCRYPTED_PROJECT_RESET_PREFIX + projectId);
    if (saved === undefined) return undefined;
    const generation = saved ?? NO_RESET;
    const keyed = read(`${prefix}${projectId}:${generation}`);
    if (keyed === undefined) return undefined;
    if (keyed !== null) return true;
    const legacy = read(prefix + projectId);
    if (legacy === undefined) return undefined;
    if (legacy === null) return false;
    // A bare record that names no generation is held as there, as is
    // safe; one that names an older generation was removed by its reset.
    return !GENERATION.test(legacy) || legacy === generation;
  };
  /**
   * Removes the project's bare records and its records of `generations`,
   * each one a generation this tab's reset replaced. Never a newer
   * generation's: another tab may have pinned the project again since.
   */
  const removeRecords = (projectId: string, generations: Iterable<string>) => {
    if (!storage) return;
    const keys = new Set<string>();
    for (const prefix of [
      ENCRYPTED_PROJECT_PIN_PREFIX,
      ENCRYPTED_PROJECT_UNRESOLVED_PREFIX
    ]) {
      keys.add(prefix + projectId);
      for (const generation of generations) {
        keys.add(`${prefix}${projectId}:${generation}`);
      }
    }
    for (const key of keys) {
      try {
        storage.removeItem(key);
      } catch {
        // Not removed: it names a replaced generation, so nothing reads it.
      }
    }
  };
  /**
   * Removes the project's records of generations saved before `saved`,
   * the one a reset just saved, wherever they came from: a tab that wrote
   * under a generation it had seen before an earlier reset leaves keys no
   * reset of its own knew. Conservative: never the generation saved now,
   * nor one saved at the same moment or later (another tab may have reset
   * and pinned the project again since), nor a key whose generation it
   * cannot date. Only where storage lists its keys.
   */
  const sweepOlderRecords = (projectId: string, saved: string) => {
    if (!storage || typeof storage.key !== 'function') return;
    const savedTime = generationTime(saved);
    if (savedTime === null) return;
    const prefixes = [
      `${ENCRYPTED_PROJECT_PIN_PREFIX}${projectId}:`,
      `${ENCRYPTED_PROJECT_UNRESOLVED_PREFIX}${projectId}:`
    ];
    const older: string[] = [];
    try {
      const count = storage.length ?? 0;
      for (let index = 0; index < count; index += 1) {
        const key = storage.key(index);
        const prefix = key && prefixes.find((p) => key.startsWith(p));
        if (!key || !prefix) continue;
        const generation = key.slice(prefix.length);
        if (generation === saved) continue;
        const time = generationTime(generation);
        if (time !== null && time < savedTime) older.push(key);
      }
    } catch {
      return;
    }
    for (const key of older) {
      try {
        storage.removeItem(key);
      } catch {
        // Not removed: it names a replaced generation, so nothing reads it.
      }
    }
  };
  const stored = (projectId: string): boolean => {
    if (!storage) return false;
    const saved = current(ENCRYPTED_PROJECT_PIN_PREFIX, projectId);
    if (saved === undefined) {
      degraded = true;
      return false;
    }
    return saved;
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
    // Reset in another tab: no pin is made for it here until a reload.
    if (resetElsewhere(projectId)) return false;
    own.add(projectId);
    if (!storage) return false;
    const tag = writeTag(projectId);
    if (tag !== undefined) {
      try {
        storage.setItem(encryptedProjectPinKey(projectId, tag), tag);
      } catch {
        // Fall through to the read-back.
      }
      // Reset in another tab meanwhile: this pin was written under the
      // replaced generation, so nobody reads it; not lost, so this tab
      // only goes stale (whatever was pinned since stays as it is).
      if (resetElsewhere(projectId)) return false;
      if (stored(projectId)) return true;
    }
    // Not saved, so a reload would not know it: hold everything as
    // encrypted, here, in other tabs and after a reload.
    recordFailure();
    return false;
  };
  /** This page's own unresolved records, as `own` holds its pins. */
  const ownUnresolved = new Set<string>();
  /** The generation this page wrote each of its unresolved records under. */
  const unresolvedTags = new Map<string, string>();
  /**
   * Unpins the project and drops its unresolved record. A new generation
   * is saved first, which alone retires every record of the older ones;
   * then the records of the generations it replaced (the one saved just
   * before, and those this tab wrote under) are removed, never a newer
   * one's.
   */
  const forget = (projectId: string) => {
    if (!PROJECT_ID.test(projectId)) return;
    own.delete(projectId);
    ownUnresolved.delete(projectId);
    const older = new Set<string>();
    const written = writeTag(projectId);
    if (written !== undefined) older.add(written);
    const ownTag = unresolvedTags.get(projectId);
    if (ownTag !== undefined) older.add(ownTag);
    unresolvedTags.delete(projectId);
    const replaced = read(ENCRYPTED_PROJECT_RESET_PREFIX + projectId);
    if (replaced !== undefined) older.add(replaced ?? NO_RESET);
    markReset(projectId);
    // The generation saved now is never removed.
    const saved = read(ENCRYPTED_PROJECT_RESET_PREFIX + projectId);
    if (saved === undefined) return;
    older.delete(saved ?? NO_RESET);
    removeRecords(projectId, older);
    if (saved !== null) sweepOlderRecords(projectId, saved);
  };
  /**
   * Removes the unresolved record this page wrote, under the generation it
   * wrote it under: never a record another tab made under a newer one.
   */
  const resolveCutover = (projectId: string) => {
    ownUnresolved.delete(projectId);
    if (!storage) return;
    const tag = unresolvedTags.get(projectId) ?? writeTag(projectId);
    unresolvedTags.delete(projectId);
    const keys = [ENCRYPTED_PROJECT_UNRESOLVED_PREFIX + projectId];
    if (tag !== undefined)
      keys.push(encryptCutoverUnresolvedKey(projectId, tag));
    for (const key of keys) {
      try {
        storage.removeItem(key);
      } catch {
        // Still recorded: the project keeps reading as unfinished, and a
        // complete backup of it refuses, which is safe.
      }
    }
  };
  return {
    get degraded() {
      return isDegraded();
    },
    get staleTab() {
      if (storeResetElsewhere()) return true;
      for (const projectId of seenResets.keys()) resetElsewhere(projectId);
      return staleProjects.size > 0;
    },
    resetElsewhere(projectId) {
      return PROJECT_ID.test(projectId) && resetElsewhere(projectId);
    },
    has(projectId) {
      if (isDegraded()) return true;
      if (!PROJECT_ID.test(projectId)) return false;
      // Reset in another tab: still held as encrypted here until a reload.
      if (resetElsewhere(projectId)) return true;
      if (own.has(projectId)) return true;
      if (stored(projectId)) {
        // Seen pinned: held here even if another tab drops its key.
        own.add(projectId);
        return true;
      }
      // A read that throws degrades the store, so ask again after it.
      return degraded;
    },
    pin,
    pinDurably(projectId) {
      if (!PROJECT_ID.test(projectId)) return false;
      // Reset in another tab: neither counted nor made again until a reload.
      if (resetElsewhere(projectId)) return false;
      if (stored(projectId)) {
        own.add(projectId);
        return true;
      }
      if (isDegraded()) return false;
      return pin(projectId);
    },
    forget,
    markCutoverUnresolved(projectId) {
      if (!PROJECT_ID.test(projectId)) return false;
      if (resetElsewhere(projectId)) return false;
      ownUnresolved.add(projectId);
      if (!storage) return false;
      const tag = writeTag(projectId);
      if (tag !== undefined) {
        unresolvedTags.set(projectId, tag);
        try {
          storage.setItem(encryptCutoverUnresolvedKey(projectId, tag), tag);
        } catch {
          // Fall through to the read-back.
        }
        if (resetElsewhere(projectId)) return false;
        if (current(ENCRYPTED_PROJECT_UNRESOLVED_PREFIX, projectId)) {
          return true;
        }
      }
      recordFailure();
      return false;
    },
    resolveCutover,
    cutoverUnresolved(projectId) {
      if (!PROJECT_ID.test(projectId)) return false;
      // Notes the project's reset generation the first time it is asked.
      resetElsewhere(projectId);
      if (ownUnresolved.has(projectId)) return true;
      if (!storage) return false;
      // Unreadable reads as unresolved.
      return current(ENCRYPTED_PROJECT_UNRESOLVED_PREFIX, projectId) ?? true;
    },
    resetProject(projectId) {
      forget(projectId);
    },
    resetDegraded() {
      if (!storage) return false;
      // Other tabs held every project as encrypted from their own memory:
      // they see the reset and stop writing until they reload.
      try {
        storage.setItem(ENCRYPTED_PROJECT_PINS_RESET_KEY, resetToken());
      } catch {
        // Not saved: other tabs stay degraded until they reload, which is
        // safe.
      }
      storeReset = read(ENCRYPTED_PROJECT_PINS_RESET_KEY);
      storeStale = false;
      try {
        storage.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
      } catch {
        // Checked below.
      }
      // Saved pins are kept: only what could not be saved is forgotten,
      // and the next listing pins those projects again. This tab forgets
      // its unsaved pins and records too, so it holds what a reload would.
      for (const projectId of [...own]) {
        if (!stored(projectId)) own.delete(projectId);
      }
      for (const projectId of [...ownUnresolved]) {
        if (!current(ENCRYPTED_PROJECT_UNRESOLVED_PREFIX, projectId)) {
          ownUnresolved.delete(projectId);
        }
      }
      degraded = failed();
      reserve();
      return !degraded;
    }
  };
}
