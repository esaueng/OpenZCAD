/**
 * This device's log of assistant consent (ADR-024 Phase 6), per account and
 * project: one append-only, de-duplicated record of every Allow and Stop
 * made or verified here. Free of any crypto import, so the send gate in
 * `api.ts` reads it synchronously immediately before every assistant
 * request leaves (`projectWriteGate.ts`).
 *
 * Every entry has a unique id, a kind, a local `order` (one past the
 * highest this device's log holds when it is written, so later entries
 * order after earlier ones whichever tab writes them) and the account
 * record `sequence` it is about. Entries live in localStorage, one key per
 * entry, so two tabs appending never overwrite each other, and every check
 * derives its answer from the stored log as it stands: re-reading the same
 * entry (from storage, a `storage` event or a broadcast) changes nothing.
 * The broadcast channel is only a hint to re-read, and carries an entry
 * itself only when storage refused it.
 *
 * - An Allow is registered when it is clicked, before anything is awaited,
 *   and gets its record sequence durably before that record is sent to the
 *   account. A Stop is registered when it is clicked, likewise, one
 *   sequence past every record the log knows. A Stop therefore revokes
 *   every Allow ordered before it (in flight or stored) and every record at
 *   or below its sequence, whenever it comes: before the save, during it,
 *   or while the answer is verified.
 * - A consent grant is current only if its record is the latest this device
 *   has seen, an Allow entry for exactly that record exists, and no Stop
 *   came after it or at or past its sequence.
 * - A log that cannot be written latches consent closed for the project on
 *   this device: a latch entry is kept wherever it can be (storage, else
 *   this tab's memory and its other tabs' through the channel), and only an
 *   Allow the user then clicks, recorded in working storage, lifts it. A
 *   log that cannot be read permits nothing.
 */

/** The consent a request was verified for, right before it was sent. */
export interface VerifiedAssistantConsent {
  readonly userId: string;
  readonly projectId: string;
  /** The verified record's sequence. */
  readonly sequence: number;
}

export type ConsentEntryKind = 'allow' | 'stop' | 'latch';

/** One entry of a project's consent log. */
export interface ConsentEntry {
  readonly id: string;
  readonly kind: ConsentEntryKind;
  /**
   * Local order: later entries order after earlier ones. Null for a Stop
   * verified from the account, which revokes by sequence only.
   */
  readonly order: number | null;
  /** The account record sequence; null for an Allow not yet assigned one. */
  readonly sequence: number | null;
  /** An Allow clicked here (`user`), or verified from the account. */
  readonly source?: 'user' | 'observed';
  /** A user Allow whose record the account has since confirmed. */
  readonly seen?: boolean;
  /** A user Allow given up (refused or failed): never used. */
  readonly withdrawn?: boolean;
}

/** An Allow registered before anything was awaited. */
export interface ConsentTicket {
  readonly userId: string;
  readonly projectId: string;
  readonly id: string;
  readonly order: number;
  /** Set once its record sequence is assigned (`assign`). */
  sequence: number | null;
}

/** What verifying an account record against the log decided. */
export type ConsentObservation =
  /** Recorded (or already known): the record stands. */
  | 'accepted'
  /** Older than a record this device has seen. */
  | 'rollback'
  /** An Allow a Stop on this device revoked, or consent is latched closed. */
  | 'stopped'
  /** The log could not be read or written: nothing is trusted. */
  | 'unrecorded';

/** What `assign` decided for an Allow about to be sent. */
export type ConsentAssignment =
  | { readonly kind: 'assigned'; readonly sequence: number }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unrecorded' };

/** This device's consent log for every account and project. */
export interface ConsentPinStore {
  /** The highest record sequence this device has seen (rollback floor). */
  read(userId: string, projectId: string): Promise<number | null>;
  /** As `read`, synchronously; `undefined` when the log cannot be read. */
  seen(userId: string, projectId: string): number | null | undefined;
  /** Verifies an account record against the log, recording it if new. */
  observe(
    userId: string,
    projectId: string,
    sequence: number,
    allowed: boolean
  ): ConsentObservation;
  /** Registers an Allow the user clicked; null when it cannot be recorded. */
  beginAllow(userId: string, projectId: string): ConsentTicket | null;
  /** Gives the Allow its record sequence (past `floor`), durably. */
  assign(ticket: ConsentTicket, floor: number): ConsentAssignment;
  /** Whether no Stop (or latch) came since the Allow was registered. */
  ticketCurrent(ticket: ConsentTicket): boolean;
  /** Gives an Allow up: its record is never used on this device. */
  withdraw(ticket: ConsentTicket): void;
  /** Registers a Stop, synchronously; returns its entry. */
  stop(userId: string, projectId: string): ConsentEntry;
  /** Whether a verified consent is still this device's latest word. */
  current(consent: VerifiedAssistantConsent): boolean;
  /** Calls `listener` when the log may have changed (any tab). */
  subscribe(
    userId: string,
    projectId: string,
    listener: () => void
  ): () => void;
}

export const ASSISTANT_CONSENT_LOG_PREFIX =
  'openzcad:e2ee-assistant-consent-log:v2:';
/** The single-number pin earlier releases kept: still a rollback floor. */
export const ASSISTANT_CONSENT_PIN_PREFIX =
  'openzcad:e2ee-assistant-consent-pin:v1:';
export const ASSISTANT_CONSENT_CHANNEL = 'openzcad:e2ee-assistant-consent:v2';

export const assistantConsentLogPrefix = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_LOG_PREFIX}${userId}:${projectId}:`;
export const assistantConsentPinKey = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_PIN_PREFIX}${userId}:${projectId}`;

export type ConsentStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

function defaultStorage(): ConsentStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* Falls through to a non-cryptographic id: it only has to be unique. */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function parseEntry(
  id: string,
  raw: string | null,
  userId: string,
  projectId: string
): ConsentEntry | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (entry.userId !== userId || entry.projectId !== projectId) return null;
  if (
    entry.kind !== 'allow' &&
    entry.kind !== 'stop' &&
    entry.kind !== 'latch'
  ) {
    return null;
  }
  const order =
    entry.order === null
      ? null
      : positive(entry.order)
        ? entry.order
        : undefined;
  const sequence =
    entry.sequence === null
      ? null
      : positive(entry.sequence)
        ? entry.sequence
        : undefined;
  if (order === undefined || sequence === undefined) return null;
  return {
    id,
    kind: entry.kind,
    order,
    sequence,
    ...(entry.source === 'user' || entry.source === 'observed'
      ? { source: entry.source }
      : {}),
    ...(entry.seen === true ? { seen: true } : {}),
    ...(entry.withdrawn === true ? { withdrawn: true } : {})
  };
}

/** A project's log as this tab sees it, and what it derives. */
interface ConsentView {
  readonly entries: readonly ConsentEntry[];
  readonly maxOrder: number;
  /** Every sequence the log names, assigned or seen. */
  readonly maxSequence: number;
  /** The highest sequence the account has confirmed to this device. */
  readonly maxSeen: number;
  readonly latched: boolean;
}

function view(
  entries: readonly ConsentEntry[],
  legacyPin: number
): ConsentView {
  let maxOrder = 0;
  let maxSequence = legacyPin;
  let maxSeen = legacyPin;
  for (const entry of entries) {
    if (entry.order !== null) maxOrder = Math.max(maxOrder, entry.order);
    if (entry.sequence === null) continue;
    maxSequence = Math.max(maxSequence, entry.sequence);
    const confirmed =
      (entry.kind === 'allow' && (entry.source === 'observed' || entry.seen)) ||
      (entry.kind === 'stop' && entry.order === null);
    if (confirmed) maxSeen = Math.max(maxSeen, entry.sequence);
  }
  // Latched until an Allow the user clicked (and did not give up) comes
  // after the latch.
  const latched = entries.some(
    (latch) =>
      latch.kind === 'latch' &&
      !entries.some(
        (allow) =>
          allow.kind === 'allow' &&
          allow.source === 'user' &&
          !allow.withdrawn &&
          allow.order !== null &&
          latch.order !== null &&
          allow.order > latch.order
      )
  );
  return { entries, maxOrder, maxSequence, maxSeen, latched };
}

/** Whether an Allow ordered at `order` was revoked by a later Stop or latch. */
function stoppedSince(
  entries: readonly ConsentEntry[],
  order: number,
  id?: string
) {
  return entries.some(
    (entry) =>
      entry.id !== id &&
      (entry.kind === 'stop' || entry.kind === 'latch') &&
      entry.order !== null &&
      entry.order >= order
  );
}

/** Whether a Stop on this device covers record `sequence`. */
function stoppedAt(entries: readonly ConsentEntry[], sequence: number) {
  return entries.some(
    (entry) =>
      entry.kind === 'stop' &&
      entry.sequence !== null &&
      entry.sequence >= sequence
  );
}

/** Whether the Allow entries for `sequence` were revoked or given up. */
function allowRevoked(entries: readonly ConsentEntry[], allow: ConsentEntry) {
  return (
    allow.withdrawn === true ||
    (allow.order !== null && stoppedSince(entries, allow.order, allow.id)) ||
    (allow.sequence !== null && stoppedAt(entries, allow.sequence))
  );
}

/** Entries this tab holds whatever storage kept, per account and project. */
const held = new Map<string, Map<string, ConsentEntry>>();

function holdEntry(prefix: string, entry: ConsentEntry) {
  const entries = held.get(prefix) ?? new Map<string, ConsentEntry>();
  held.set(prefix, entries);
  const known = entries.get(entry.id);
  // Re-hearing an entry changes nothing; a later rewrite (same id) may
  // only add `seen` or `withdrawn`.
  entries.set(entry.id, known ? { ...known, ...entry } : entry);
}

/** Listeners per account and project, told when the log may have changed. */
const listeners = new Map<string, Set<() => void>>();

function notify(prefix: string) {
  for (const listener of listeners.get(prefix) ?? []) {
    try {
      listener();
    } catch {
      /* One listener's failure does not stop the others. */
    }
  }
}

interface ConsentHint {
  readonly userId: string;
  readonly projectId: string;
  /** Entries storage refused, for tabs that cannot read them from it. */
  readonly unsaved?: readonly ConsentEntry[];
}

function hear(data: unknown) {
  if (!data || typeof data !== 'object') return;
  const { userId, projectId, unsaved } = data as Partial<ConsentHint>;
  if (typeof userId !== 'string' || typeof projectId !== 'string') return;
  const prefix = assistantConsentLogPrefix(userId, projectId);
  if (Array.isArray(unsaved)) {
    for (const value of unsaved) {
      if (!value || typeof value !== 'object') continue;
      const id = (value as { id?: unknown }).id;
      if (typeof id !== 'string' || !id) continue;
      const entry = parseEntry(
        id,
        JSON.stringify({ ...(value as object), userId, projectId }),
        userId,
        projectId
      );
      if (entry) holdEntry(prefix, entry);
    }
  }
  notify(prefix);
}

/** Opened when the module loads; only a hint to re-read the log. */
const channel: BroadcastChannel | null = (() => {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const opened = new BroadcastChannel(ASSISTANT_CONSENT_CHANNEL);
    opened.onmessage = (event: MessageEvent) => hear(event.data);
    // Node's channel (tests) would otherwise hold the process open.
    (opened as { unref?: () => void }).unref?.();
    return opened;
  } catch {
    return null;
  }
})();

if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (event: StorageEvent) => {
      const key = event.key;
      if (key === null) {
        for (const prefix of listeners.keys()) notify(prefix);
        return;
      }
      if (!key.startsWith(ASSISTANT_CONSENT_LOG_PREFIX)) return;
      for (const prefix of listeners.keys()) {
        if (key.startsWith(prefix)) notify(prefix);
      }
    });
  } catch {
    /* Each check still reads the stored log. */
  }
}

function tell(hint: ConsentHint) {
  try {
    channel?.postMessage(hint);
  } catch {
    /* Other tabs read storage at each check; this is only a hint. */
  }
}

interface LogOptions {
  /** Shares this tab's held entries and hints with its other tabs. */
  readonly shared: boolean;
}

/** The consent log over `storage` (null: storage unavailable). */
function consentLog(
  storage: ConsentStorage | null,
  { shared }: LogOptions
): ConsentPinStore {
  const heldFor = (prefix: string): readonly ConsentEntry[] =>
    shared ? [...(held.get(prefix)?.values() ?? [])] : [];

  /** The log as stored plus held; `undefined` when it cannot be read. */
  function readView(
    userId: string,
    projectId: string
  ): ConsentView | undefined {
    if (!storage) return undefined;
    const prefix = assistantConsentLogPrefix(userId, projectId);
    const entries = new Map<string, ConsentEntry>();
    let legacyPin = 0;
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key || !key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        const entry = parseEntry(id, storage.getItem(key), userId, projectId);
        if (entry) entries.set(id, entry);
      }
      const legacy = Number(
        storage.getItem(assistantConsentPinKey(userId, projectId))
      );
      if (positive(legacy)) legacyPin = legacy;
    } catch {
      return undefined;
    }
    for (const entry of heldFor(prefix)) {
      const stored = entries.get(entry.id);
      entries.set(entry.id, stored ? { ...stored, ...entry } : entry);
    }
    return view([...entries.values()], legacyPin);
  }

  /** Writes an entry; false (and held in memory) when storage refuses. */
  function write(
    userId: string,
    projectId: string,
    entry: ConsentEntry
  ): boolean {
    const prefix = assistantConsentLogPrefix(userId, projectId);
    try {
      if (!storage) throw new Error('No storage');
      storage.setItem(
        `${prefix}${entry.id}`,
        JSON.stringify({ ...entry, userId, projectId })
      );
      if (shared && held.get(prefix)?.has(entry.id)) holdEntry(prefix, entry);
      return true;
    } catch {
      if (shared) holdEntry(prefix, entry);
      return false;
    }
  }

  /**
   * When storage refuses a new key (it is full), the latch takes the place
   * of one of the project's stored Allows instead: a shorter value under a
   * key that already exists still fits, so a tab opened later sees it. The
   * Allow it replaces is one the latch would refuse anyway.
   */
  function latchInPlace(userId: string, projectId: string, order: number) {
    if (!storage) return false;
    const prefix = assistantConsentLogPrefix(userId, projectId);
    let ids: string[];
    try {
      ids = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key || !key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        const entry = parseEntry(id, storage.getItem(key), userId, projectId);
        if (entry?.kind === 'allow') ids.push(id);
      }
    } catch {
      return false;
    }
    for (const id of ids) {
      const entry: ConsentEntry = { id, kind: 'latch', order, sequence: null };
      try {
        storage.setItem(
          `${prefix}${id}`,
          JSON.stringify({ ...entry, userId, projectId })
        );
        if (shared) holdEntry(prefix, entry);
        return true;
      } catch {
        /* Try the next one. */
      }
    }
    return false;
  }

  /**
   * Latches consent closed for the project on this device: in storage if
   * any of it can be written, and in this tab's and its other tabs' memory
   * whatever storage does.
   */
  function latch(userId: string, projectId: string, unsaved: ConsentEntry[]) {
    const current = readView(userId, projectId);
    const maxOrder = Math.max(
      current?.maxOrder ?? 0,
      ...unsaved.map((entry) => entry.order ?? 0)
    );
    const entry: ConsentEntry = {
      id: newId(),
      kind: 'latch',
      order: maxOrder + 1,
      sequence: null
    };
    const prefix = assistantConsentLogPrefix(userId, projectId);
    if (shared) holdEntry(prefix, entry);
    const saved =
      write(userId, projectId, entry) ||
      latchInPlace(userId, projectId, entry.order!);
    if (shared) {
      tell({
        userId,
        projectId,
        unsaved: saved ? unsaved : [...unsaved, entry]
      });
    }
    notify(prefix);
  }

  /** Writes `entry`, latching when storage refuses it. */
  function record(
    userId: string,
    projectId: string,
    entry: ConsentEntry
  ): boolean {
    const prefix = assistantConsentLogPrefix(userId, projectId);
    if (write(userId, projectId, entry)) {
      if (shared) tell({ userId, projectId });
      notify(prefix);
      return true;
    }
    latch(userId, projectId, [entry]);
    return false;
  }

  /** Drops stored entries a Stop now outranks, so the log stays small. */
  function compact(userId: string, projectId: string, stopEntry: ConsentEntry) {
    if (!storage || stopEntry.order === null || stopEntry.sequence === null)
      return;
    const prefix = assistantConsentLogPrefix(userId, projectId);
    const current = readView(userId, projectId);
    if (!current) return;
    for (const entry of current.entries) {
      if (entry.id === stopEntry.id || entry.kind === 'latch') continue;
      const before = entry.order === null || entry.order < stopEntry.order;
      const below =
        entry.sequence === null || entry.sequence < stopEntry.sequence;
      // An unassigned Allow ordered before the Stop is refused by order
      // whether or not its entry is kept (`ticketCurrent`).
      if (before && below) {
        try {
          storage.removeItem(`${prefix}${entry.id}`);
        } catch {
          /* Kept: it is outranked either way. */
        }
      }
    }
  }

  const store: ConsentPinStore = {
    async read(userId, projectId) {
      const seen = store.seen(userId, projectId);
      return seen ?? null;
    },
    seen(userId, projectId) {
      const current = readView(userId, projectId);
      if (!current) return undefined;
      return current.maxSeen > 0 ? current.maxSeen : null;
    },
    observe(userId, projectId, sequence, allowed) {
      if (!positive(sequence)) return 'unrecorded';
      const current = readView(userId, projectId);
      if (!current) return 'unrecorded';
      const allows = current.entries.filter(
        (entry) => entry.kind === 'allow' && entry.sequence === sequence
      );
      if (allowed) {
        // Latched closed: only an Allow clicked here lifts it.
        if (current.latched) return 'unrecorded';
        if (stoppedAt(current.entries, sequence)) return 'stopped';
        if (allows.some((allow) => allowRevoked(current.entries, allow))) {
          return 'stopped';
        }
        if (sequence < current.maxSeen) return 'rollback';
        const mine = allows.find((allow) => allow.source === 'user');
        if (mine) {
          // The account confirmed this device's own Allow.
          if (!mine.seen) write(userId, projectId, { ...mine, seen: true });
          return 'accepted';
        }
        if (allows.length) return 'accepted';
        return record(userId, projectId, {
          id: newId(),
          kind: 'allow',
          source: 'observed',
          order: current.maxOrder + 1,
          sequence
        })
          ? 'accepted'
          : 'unrecorded';
      }
      if (sequence < current.maxSeen) return 'rollback';
      if (
        current.entries.some(
          (entry) =>
            entry.kind === 'stop' &&
            entry.order === null &&
            entry.sequence === sequence
        )
      ) {
        return 'accepted';
      }
      // A revocation the account holds: revokes every record up to it.
      record(userId, projectId, {
        id: newId(),
        kind: 'stop',
        order: null,
        sequence
      });
      return 'accepted';
    },
    beginAllow(userId, projectId) {
      const current = readView(userId, projectId);
      if (!current) {
        latch(userId, projectId, []);
        return null;
      }
      const entry: ConsentEntry = {
        id: newId(),
        kind: 'allow',
        source: 'user',
        order: current.maxOrder + 1,
        sequence: null
      };
      if (!record(userId, projectId, entry)) return null;
      return {
        userId,
        projectId,
        id: entry.id,
        order: entry.order!,
        sequence: null
      };
    },
    assign(ticket, floor) {
      if (!store.ticketCurrent(ticket)) return { kind: 'stopped' };
      const current = readView(ticket.userId, ticket.projectId);
      if (!current) return { kind: 'unrecorded' };
      const sequence =
        Math.max(current.maxSequence, Number.isSafeInteger(floor) ? floor : 0) +
        1;
      const entry: ConsentEntry = {
        id: ticket.id,
        kind: 'allow',
        source: 'user',
        order: ticket.order,
        sequence
      };
      if (!record(ticket.userId, ticket.projectId, entry)) {
        return { kind: 'unrecorded' };
      }
      ticket.sequence = sequence;
      return { kind: 'assigned', sequence };
    },
    ticketCurrent(ticket) {
      const current = readView(ticket.userId, ticket.projectId);
      if (!current) return false;
      const mine = current.entries.find((entry) => entry.id === ticket.id);
      if (mine?.withdrawn) return false;
      return !stoppedSince(current.entries, ticket.order, ticket.id);
    },
    withdraw(ticket) {
      const entry: ConsentEntry = {
        id: ticket.id,
        kind: 'allow',
        source: 'user',
        order: ticket.order,
        sequence: ticket.sequence,
        withdrawn: true
      };
      record(ticket.userId, ticket.projectId, entry);
    },
    stop(userId, projectId) {
      const current = readView(userId, projectId);
      const prefix = assistantConsentLogPrefix(userId, projectId);
      const heldEntries = heldFor(prefix);
      const maxOrder = Math.max(
        current?.maxOrder ?? 0,
        ...heldEntries.map((entry) => entry.order ?? 0)
      );
      const maxSequence = Math.max(
        current?.maxSequence ?? 0,
        ...heldEntries.map((entry) => entry.sequence ?? 0)
      );
      const entry: ConsentEntry = {
        id: newId(),
        kind: 'stop',
        order: maxOrder + 1,
        sequence: maxSequence + 1
      };
      if (!current) {
        // Unreadable: nothing is sent anyway; hold the Stop and latch.
        if (shared) holdEntry(prefix, entry);
        latch(userId, projectId, [entry]);
        return entry;
      }
      if (record(userId, projectId, entry)) compact(userId, projectId, entry);
      return entry;
    },
    current(consent) {
      if (!positive(consent.sequence)) return false;
      const current = readView(consent.userId, consent.projectId);
      if (!current || current.latched) return false;
      if (consent.sequence < current.maxSeen) return false;
      const allows = current.entries.filter(
        (entry) => entry.kind === 'allow' && entry.sequence === consent.sequence
      );
      return (
        allows.length > 0 &&
        !allows.some((allow) => allowRevoked(current.entries, allow))
      );
    },
    subscribe(userId, projectId, listener) {
      const prefix = assistantConsentLogPrefix(userId, projectId);
      const set = listeners.get(prefix) ?? new Set<() => void>();
      listeners.set(prefix, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(prefix);
      };
    }
  };
  return store;
}

/**
 * The log in localStorage, shared by every tab of this device. Storage that
 * is cleared loses it, which only weakens rollback detection back to first
 * use; storage that cannot be read refuses every consent send.
 */
export function localStorageConsentPins(
  storage: ConsentStorage | null = defaultStorage()
): ConsentPinStore {
  return consentLog(storage, { shared: true });
}

/** An in-memory storage, for tests and pages without localStorage. */
export function memoryConsentStorage(): ConsentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, String(value));
    },
    removeItem: (key) => {
      values.delete(key);
    },
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    }
  };
}

/** A log of its own, in memory (tests). */
export function memoryConsentPins(): ConsentPinStore {
  return consentLog(memoryConsentStorage(), { shared: false });
}

let pagePins: ConsentPinStore | null = null;

/** This page's log (localStorage), as the send gate reads it. */
export function pageConsentPins(): ConsentPinStore {
  return (pagePins ??= localStorageConsentPins());
}

/**
 * Synchronously, immediately before an assistant request is sent: whether
 * the consent it was verified for is still this device's latest word for
 * the project in the stored log. Unknown is not allowed.
 */
export function assistantConsentCurrent(
  consent: VerifiedAssistantConsent,
  storage?: ConsentStorage | null
): boolean {
  return (
    storage === undefined ? pageConsentPins() : localStorageConsentPins(storage)
  ).current(consent);
}
