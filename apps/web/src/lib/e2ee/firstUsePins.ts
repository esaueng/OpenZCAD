import {
  accountKeyCommitment,
  FIRST_USE_PINS_RECORD,
  fromBase64Url,
  isE2eeError,
  openRecord,
  readSealedRecordHeader,
  sealRecord,
  toBase64Url,
  toHex
} from '@openzcad/crypto';
import { realmStorageName } from '../deploymentRealm';
import { callE2eeRoute, E2eeApiError, type E2eeFetch } from './e2eeApi';

/**
 * The identities an account pinned for other people on first use, shared
 * by every device of the account (ADR-024 amendment 2026-11-25, trust on
 * first use for invitations). One record, sealed under the account key
 * (`FIRST_USE_PINS_RECORD`): the server stores it opaque, and no identity
 * key signature is needed, so writing it asks for no passkey.
 *
 * Per person the record keeps every identity a device of the account
 * accepted on first use (`seen`), the identity the user last trusted
 * explicitly ("Trust new keys", `trusted`) and the identities that trust
 * superseded (`retired`). An identity counts (`standing`) when it is the
 * trusted one, or, with nothing trusted, the only one seen. Anything else is
 * a key change, never a first use: a retired identity coming back (a
 * rollback), or two devices that first saw different identities.
 *
 * The record is merged, never replaced: every set only grows, and the
 * trusted identity is the one trusted last. Each device keeps its merged
 * copy and the highest sequence it opened or wrote, and refuses a record
 * the server rolled back below that. Where the record cannot be fetched or
 * opened here, or was rolled back, nothing counts as a first use
 * (`FirstUsePinsUnavailable`): callers fall back to asking the user. A
 * server can still withhold a newer record from a device that never saw
 * it, the same fork-consistency limit as the contacts list.
 */

export interface FirstUsePinEntry {
  /** Hex identity key hash → when a device first accepted it (ms). */
  readonly seen: Readonly<Record<string, number>>;
  /**
   * The identity the user trusted explicitly, last: by "Trust new keys", or
   * by comparing codes (`verified`).
   */
  readonly trusted?: {
    readonly identity: string;
    readonly stamp: number;
    readonly verified?: true;
  };
  /** Identities a trust superseded: never a first use again. */
  readonly retired: readonly string[];
}

export interface FirstUsePinBook {
  readonly version: 1;
  /** User id → their pins. */
  readonly people: Readonly<Record<string, FirstUsePinEntry>>;
}

export const EMPTY_FIRST_USE_PIN_BOOK: FirstUsePinBook = {
  version: 1,
  people: {}
};

/**
 * Where an identity stands for a person: `new` (nothing pinned yet: a
 * first use), `pinned` (the one identity pinned on first use), `trusted`
 * (the one the user trusted explicitly) or `changed`.
 */
export type FirstUseStanding = 'new' | 'pinned' | 'trusted' | 'changed';

const HASH = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 128;
const MAX_STAMP = 8.64e15;

const validStamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_STAMP;

function parseEntry(value: unknown): FirstUsePinEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const seen: Record<string, number> = {};
  if (entry.seen && typeof entry.seen === 'object') {
    for (const [hash, at] of Object.entries(entry.seen)) {
      if (HASH.test(hash) && validStamp(at)) seen[hash] = at;
    }
  }
  const retired = Array.isArray(entry.retired)
    ? [
        ...new Set(
          entry.retired.filter(
            (hash): hash is string =>
              typeof hash === 'string' && HASH.test(hash)
          )
        )
      ].sort()
    : [];
  const trust = entry.trusted as Record<string, unknown> | undefined;
  const trusted =
    trust &&
    typeof trust === 'object' &&
    typeof trust.identity === 'string' &&
    HASH.test(trust.identity) &&
    validStamp(trust.stamp)
      ? {
          identity: trust.identity,
          stamp: trust.stamp,
          ...(trust.verified === true ? { verified: true as const } : {})
        }
      : undefined;
  return { seen, retired, ...(trusted ? { trusted } : {}) };
}

/** A pin book, or null for anything that is not one. */
export function parseFirstUsePinBook(value: unknown): FirstUsePinBook | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const book = value as Record<string, unknown>;
  if (book.version !== 1) return null;
  const people = book.people;
  if (!people || typeof people !== 'object' || Array.isArray(people))
    return null;
  const out: Record<string, FirstUsePinEntry> = {};
  for (const [userId, raw] of Object.entries(people)) {
    if (userId.length === 0 || userId.length > MAX_ID_LENGTH) continue;
    const entry = parseEntry(raw);
    if (entry) out[userId] = entry;
  }
  return { version: 1, people: out };
}

function mergeEntries(
  a: FirstUsePinEntry,
  b: FirstUsePinEntry
): FirstUsePinEntry {
  const seen: Record<string, number> = { ...a.seen };
  for (const [hash, at] of Object.entries(b.seen)) {
    seen[hash] = Math.min(seen[hash] ?? at, at);
  }
  const trusted =
    !a.trusted || !b.trusted
      ? (a.trusted ?? b.trusted)
      : a.trusted.stamp !== b.trusted.stamp
        ? a.trusted.stamp > b.trusted.stamp
          ? a.trusted
          : b.trusted
        : a.trusted.identity >= b.trusted.identity
          ? a.trusted
          : b.trusted;
  const retired = [...new Set([...a.retired, ...b.retired])].sort();
  return { seen, retired, ...(trusted ? { trusted } : {}) };
}

/** Both books, person by person. Commutative, associative and idempotent. */
export function mergeFirstUsePinBooks(
  a: FirstUsePinBook,
  b: FirstUsePinBook
): FirstUsePinBook {
  const people: Record<string, FirstUsePinEntry> = { ...a.people };
  for (const [userId, entry] of Object.entries(b.people)) {
    const existing = people[userId];
    people[userId] = existing ? mergeEntries(existing, entry) : entry;
  }
  return { version: 1, people };
}

/** Where `identity` (hex) stands for `userId` in `book`. */
export function firstUseStanding(
  book: FirstUsePinBook,
  userId: string,
  identity: string
): FirstUseStanding {
  const entry = book.people[userId];
  if (!entry) return 'new';
  if (entry.trusted) {
    // A later trust may name an identity an earlier one retired.
    return entry.trusted.identity === identity ? 'trusted' : 'changed';
  }
  if (entry.retired.includes(identity)) return 'changed';
  const live = Object.keys(entry.seen).filter(
    (hash) => !entry.retired.includes(hash)
  );
  if (live.length === 0) return 'new';
  return live.length === 1 && live[0] === identity ? 'pinned' : 'changed';
}

/**
 * The book with `identity` pinned for `userId` on first use. Unchanged when
 * it already counts; refused (null) when it is a key change, which only an
 * explicit trust may resolve.
 */
export function pinFirstUse(
  book: FirstUsePinBook,
  userId: string,
  identity: string,
  now: number
): FirstUsePinBook | null {
  const standing = firstUseStanding(book, userId, identity);
  if (standing === 'pinned' || standing === 'trusted') return book;
  if (standing === 'changed') return null;
  const entry = book.people[userId] ?? { seen: {}, retired: [] };
  return {
    version: 1,
    people: {
      ...book.people,
      [userId]: {
        ...entry,
        seen: { ...entry.seen, [identity]: Math.floor(now) }
      }
    }
  };
}

/**
 * The user's explicit trust of `identity` for `userId`: it becomes the one
 * that counts, and every other identity known for them (`also`: one the
 * signed contacts list verified, say) is retired, so it never counts again.
 * `verified` marks a trust made by comparing codes.
 */
export function trustFirstUse(
  book: FirstUsePinBook,
  userId: string,
  identity: string,
  now: number,
  also: readonly string[] = [],
  verified = false
): FirstUsePinBook {
  const entry = book.people[userId] ?? { seen: {}, retired: [] };
  const retired = [
    ...new Set([
      ...entry.retired,
      ...Object.keys(entry.seen),
      ...(entry.trusted ? [entry.trusted.identity] : []),
      ...also.filter((hash) => HASH.test(hash))
    ])
  ]
    .filter((hash) => hash !== identity)
    .sort();
  const stamp = Math.min(
    MAX_STAMP,
    Math.max(Math.floor(now), (entry.trusted?.stamp ?? -1) + 1)
  );
  return {
    version: 1,
    people: {
      ...book.people,
      [userId]: {
        seen: { ...entry.seen, [identity]: entry.seen[identity] ?? stamp },
        retired,
        trusted: { identity, stamp, ...(verified ? { verified: true } : {}) }
      }
    }
  };
}

/** Keys sorted at every level, so equal books seal equal bytes. */
export function encodeFirstUsePinBook(book: FirstUsePinBook): Uint8Array {
  const people: Record<string, unknown> = {};
  for (const userId of Object.keys(book.people).sort()) {
    const entry = book.people[userId]!;
    const seen: Record<string, number> = {};
    for (const hash of Object.keys(entry.seen).sort())
      seen[hash] = entry.seen[hash]!;
    people[userId] = {
      seen,
      retired: [...entry.retired].sort(),
      ...(entry.trusted
        ? {
            trusted: {
              identity: entry.trusted.identity,
              stamp: entry.trusted.stamp,
              ...(entry.trusted.verified ? { verified: true } : {})
            }
          }
        : {})
    };
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, people })
  );
  if (bytes.byteLength > FIRST_USE_PINS_RECORD.maxPlaintextBytes) {
    throw new RangeError(
      'Too many people to keep their keys pinned in your account.'
    );
  }
  return bytes;
}

// --- The store ----------------------------------------------------------------

/** The account record cannot be fetched, opened or written here. */
export class FirstUsePinsUnavailable extends Error {
  constructor(
    message = 'The keys of the people you share with could not be checked on this device.'
  ) {
    super(message);
    this.name = 'FirstUsePinsUnavailable';
  }
}

/** The account's pins, as the invitations read and change them. */
export interface FirstUsePinStore {
  /** The account's pins merged with this device's; throws when unavailable. */
  read(): Promise<FirstUsePinBook>;
  /**
   * Applies `change` to the account's pins and stores the result; throws
   * `FirstUsePinsUnavailable` when the record cannot be read or written.
   * A change that returns null stores nothing and resolves null.
   */
  change(
    change: (book: FirstUsePinBook, now: number) => FirstUsePinBook | null
  ): Promise<FirstUsePinBook | null>;
}

/** An in-memory account record, for tests and a single page. */
export function memoryFirstUsePins(
  initial: FirstUsePinBook = EMPTY_FIRST_USE_PIN_BOOK,
  now: () => number = Date.now
): FirstUsePinStore & { book(): FirstUsePinBook } {
  let book = initial;
  return {
    book: () => book,
    read: async () => book,
    async change(change) {
      const next = change(book, now());
      if (next) book = mergeFirstUsePinBooks(book, next);
      return next ? book : null;
    }
  };
}

export interface FirstUsePinsSnapshot {
  revision: number;
  sequence: number;
  record: string | null;
}

/** The Worker's `E2EE_FIRST_USE_PINS_CONFLICT`, with the copy it holds now. */
export class FirstUsePinsConflict extends Error {
  constructor(readonly current: FirstUsePinsSnapshot) {
    super('The first-use pins changed on another device.');
    this.name = 'FirstUsePinsConflict';
  }
}

export interface FirstUsePinsApi {
  load(): Promise<FirstUsePinsSnapshot>;
  /** Throws `FirstUsePinsConflict` when the account copy moved on. */
  save(expectedRevision: number, record: string): Promise<FirstUsePinsSnapshot>;
}

/**
 * The highest sequence this device opened or wrote, with a hash of the
 * record it accepted there, and its merged copy. The sequence and hash
 * outlive sign-out (they name nobody); the copy does not.
 */
export interface FirstUsePinDeviceState {
  readSequence(): number;
  /** Hex SHA-256 of the record accepted at `readSequence()`, or null. */
  readRecordHash(): string | null;
  /** Raises the sequence, keeping the hash accepted at an equal one. */
  writeSequence(sequence: number, recordHash: string): void;
  readCopy(): FirstUsePinBook;
  writeCopy(book: FirstUsePinBook): void;
}

export interface FirstUsePinKeys {
  readonly userId: string;
  /**
   * A copy of the account key now, for opening and sealing, which the
   * caller zeroes; null (or a throw) once locked.
   */
  accountKey(): Promise<Uint8Array | null>;
  /** Another account key by its commitment (`accountKeyByCommitment`). */
  olderKey?(commitment: Uint8Array): Promise<Uint8Array | null>;
  readonly device: FirstUsePinDeviceState;
  readonly now?: () => number;
}

const SAVE_ATTEMPTS = 4;

/** Hex SHA-256 of a stored record as the Worker returns it. */
async function recordHash(record: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record))
    )
  );
}

/**
 * The record's book: null when none is stored and this device never opened
 * one. Throws when it cannot be opened, when it is missing or older than
 * what this device already opened or wrote (a rollback), and when it has
 * that very sequence but other content (a fork: the server cannot store two
 * records at one sequence, so another one there was never the account's).
 */
async function openPins(
  keys: FirstUsePinKeys,
  record: string | null
): Promise<FirstUsePinBook | null> {
  // A record this device opened or wrote before, now missing or older: a
  // rollback. Nothing counts as a first use against it (fail closed).
  if (record === null) {
    if (keys.device.readSequence() > 0) throw new FirstUsePinsUnavailable();
    return null;
  }
  let sealed: Uint8Array;
  let header: ReturnType<typeof readSealedRecordHeader>;
  try {
    sealed = fromBase64Url(record);
    header = readSealedRecordHeader(FIRST_USE_PINS_RECORD, sealed);
  } catch {
    throw new FirstUsePinsUnavailable();
  }
  const pinned = keys.device.readSequence();
  if (header.sequence < pinned) throw new FirstUsePinsUnavailable();
  const hash = await recordHash(record);
  if (header.sequence === pinned && keys.device.readRecordHash() !== hash) {
    throw new FirstUsePinsUnavailable();
  }
  const current = await keys.accountKey().catch(() => null);
  if (!current) throw new FirstUsePinsUnavailable();
  let key = current;
  try {
    if (toHex(header.commitment) !== toHex(await accountKeyCommitment(key))) {
      key.fill(0);
      const older = await keys.olderKey?.(header.commitment).catch(() => null);
      if (!older) throw new FirstUsePinsUnavailable();
      key = older;
    }
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await openRecord(
        FIRST_USE_PINS_RECORD,
        key,
        keys.userId,
        sealed
      ));
    } catch (error) {
      if (isE2eeError(error)) throw new FirstUsePinsUnavailable();
      throw error;
    }
    let book: FirstUsePinBook | null = null;
    try {
      book = parseFirstUsePinBook(
        JSON.parse(new TextDecoder().decode(plaintext))
      );
    } catch {
      book = null;
    }
    if (!book) throw new FirstUsePinsUnavailable();
    keys.device.writeSequence(header.sequence, hash);
    return book;
  } finally {
    key.fill(0);
  }
}

/** `FirstUsePinStore` over the Worker's sealed record. */
export function sealedFirstUsePins(
  keys: FirstUsePinKeys,
  api: FirstUsePinsApi
): FirstUsePinStore {
  const now = keys.now ?? Date.now;
  const merged = (book: FirstUsePinBook | null) => {
    const next = book
      ? mergeFirstUsePinBooks(keys.device.readCopy(), book)
      : keys.device.readCopy();
    keys.device.writeCopy(next);
    return next;
  };
  return {
    async read() {
      let snapshot: FirstUsePinsSnapshot;
      try {
        snapshot = await api.load();
      } catch {
        throw new FirstUsePinsUnavailable();
      }
      return merged(await openPins(keys, snapshot.record));
    },
    async change(change) {
      let snapshot: FirstUsePinsSnapshot;
      try {
        snapshot = await api.load();
      } catch {
        throw new FirstUsePinsUnavailable();
      }
      for (let attempt = 0; ; attempt++) {
        const base = merged(await openPins(keys, snapshot.record));
        const next = change(base, now());
        if (!next) return null;
        // Nothing new: the account's record already says it.
        if (next === base && snapshot.record !== null) return base;
        const book = mergeFirstUsePinBooks(base, next);
        const sequence =
          Math.max(keys.device.readSequence(), snapshot.sequence) + 1;
        const key = await keys.accountKey().catch(() => null);
        if (!key) throw new FirstUsePinsUnavailable();
        let sealed: Uint8Array;
        try {
          sealed = await sealRecord(
            FIRST_USE_PINS_RECORD,
            key,
            keys.userId,
            sequence,
            encodeFirstUsePinBook(book)
          );
        } finally {
          key.fill(0);
        }
        const stored = toBase64Url(sealed);
        try {
          await api.save(snapshot.revision, stored);
        } catch (error) {
          if (
            error instanceof FirstUsePinsConflict &&
            attempt < SAVE_ATTEMPTS
          ) {
            snapshot = error.current;
            continue;
          }
          throw new FirstUsePinsUnavailable(
            'The keys of the people you share with could not be saved to your account. Nothing was shared.'
          );
        }
        keys.device.writeSequence(sequence, await recordHash(stored));
        keys.device.writeCopy(book);
        return book;
      }
    }
  };
}

/** The Worker's route (`worker/e2eeFirstUsePins.ts`). */
export function createFirstUsePinsApi(fetcher: E2eeFetch): FirstUsePinsApi {
  const route = '/api/e2ee/first-use-pins';
  const load = async (): Promise<FirstUsePinsSnapshot> => {
    const value = await callE2eeRoute<FirstUsePinsSnapshot>(fetcher, route);
    return {
      revision: value.revision,
      sequence: value.sequence,
      record: value.record
    };
  };
  return {
    load,
    async save(expectedRevision, record) {
      try {
        const value = await callE2eeRoute<FirstUsePinsSnapshot>(
          fetcher,
          route,
          'PUT',
          { expectedRevision, record }
        );
        return {
          revision: value.revision,
          sequence: value.sequence,
          record: value.record
        };
      } catch (error) {
        if (
          error instanceof E2eeApiError &&
          error.code === 'E2EE_FIRST_USE_PINS_CONFLICT'
        ) {
          throw new FirstUsePinsConflict(await load());
        }
        throw error;
      }
    }
  };
}

// --- Device storage -------------------------------------------------------------

const SEQUENCE_PREFIX = realmStorageName('openzcad.firstUsePins.sequence.v1');
const COPY_PREFIX = realmStorageName('openzcad.firstUsePins.copy.v1');
/** Kept across reads even when persistent storage refuses a write. */
const floors = new Map<string, { sequence: number; hash: string | null }>();

const HEX_HASH = /^[0-9a-f]{64}$/;

/** The later of two heads; at one sequence, the hash accepted first. */
function laterHead(
  a: { sequence: number; hash: string | null },
  b: { sequence: number; hash: string | null }
): { sequence: number; hash: string | null } {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? a : b;
  return a.hash ? a : b;
}

function parseHead(raw: string | null): {
  sequence: number;
  hash: string | null;
} {
  if (!raw) return { sequence: 0, hash: null };
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0
        ? { sequence: value, hash: null }
        : { sequence: 0, hash: null };
    }
    const head = value as { sequence?: unknown; hash?: unknown };
    return typeof head.sequence === 'number' &&
      Number.isSafeInteger(head.sequence) &&
      head.sequence > 0
      ? {
          sequence: head.sequence,
          hash:
            typeof head.hash === 'string' && HEX_HASH.test(head.hash)
              ? head.hash
              : null
        }
      : { sequence: 0, hash: null };
  } catch {
    return { sequence: 0, hash: null };
  }
}
const copies = new Map<string, FirstUsePinBook>();

/** This device's sequence pin and merged copy, in local storage. */
export function localStorageFirstUsePinState(
  userId: string
): FirstUsePinDeviceState {
  const sequenceKey = `${SEQUENCE_PREFIX}:${userId}`;
  const copyKey = `${COPY_PREFIX}:${userId}`;
  const remember = (head: { sequence: number; hash: string | null }) => {
    const floor = laterHead(
      floors.get(userId) ?? { sequence: 0, hash: null },
      head
    );
    floors.set(userId, floor);
    return floor;
  };
  const readHead = () => {
    try {
      return remember(
        parseHead(globalThis.localStorage?.getItem(sequenceKey) ?? null)
      );
    } catch {
      return remember({ sequence: 0, hash: null });
    }
  };
  const readCopy = (): FirstUsePinBook => {
    let stored: FirstUsePinBook | null;
    try {
      const raw = globalThis.localStorage?.getItem(copyKey);
      stored = raw ? parseFirstUsePinBook(JSON.parse(raw)) : null;
    } catch {
      stored = null;
    }
    const visit = copies.get(userId);
    return stored && visit
      ? mergeFirstUsePinBooks(stored, visit)
      : (stored ?? visit ?? EMPTY_FIRST_USE_PIN_BOOK);
  };
  return {
    readSequence: () => readHead().sequence,
    readRecordHash: () => readHead().hash,
    writeSequence(sequence, hash) {
      const floor = remember(laterHead(readHead(), { sequence, hash }));
      try {
        globalThis.localStorage?.setItem(sequenceKey, JSON.stringify(floor));
      } catch {
        // The memory floor still protects this visit.
      }
    },
    readCopy,
    writeCopy(book) {
      const next = mergeFirstUsePinBooks(readCopy(), book);
      copies.set(userId, next);
      try {
        globalThis.localStorage?.setItem(
          copyKey,
          new TextDecoder().decode(encodeFirstUsePinBook(next))
        );
      } catch {
        // This visit's copy still holds it.
      }
    }
  };
}

/** An in-memory device state, for tests and browsers without storage. */
export function memoryFirstUsePinState(): FirstUsePinDeviceState {
  let head: { sequence: number; hash: string | null } = {
    sequence: 0,
    hash: null
  };
  let copy = EMPTY_FIRST_USE_PIN_BOOK;
  return {
    readSequence: () => head.sequence,
    readRecordHash: () => head.hash,
    writeSequence: (sequence, hash) => {
      head = laterHead(head, { sequence, hash });
    },
    readCopy: () => copy,
    writeCopy: (book) => {
      copy = mergeFirstUsePinBooks(copy, book);
    }
  };
}

/**
 * Forgets this device's copy at sign-out or erasure: it names the people
 * the account shares with. The sequence and the hash of the record accepted
 * there stay, so a rolled-back record, or another record at that sequence
 * (a fork that leaves out pins this device wrote), is still refused here.
 */
export function forgetFirstUsePins(userId: string): void {
  copies.delete(userId);
  try {
    globalThis.localStorage?.removeItem(`${COPY_PREFIX}:${userId}`);
  } catch {
    // Storage unavailable.
  }
}

/**
 * The identities the account's pins retired for `userId` (a trust or a
 * verification superseded them): never shown as verified, nor wrapped to,
 * on any device. Empty when the record cannot be read here.
 */
export async function retiredIdentities(
  store: FirstUsePinStore | undefined,
  userId: string
): Promise<ReadonlySet<string>> {
  if (!store) return new Set();
  const book = await store.read().catch(() => null);
  return new Set(book?.people[userId]?.retired ?? []);
}

/**
 * The page's account pins for `userId`, over the Worker route, with the
 * page's unlocked account key (locked: unavailable).
 */
export function pageFirstUsePins(
  userId: string,
  fetcher?: E2eeFetch
): FirstUsePinStore {
  return sealedFirstUsePins(
    {
      userId,
      accountKey: async () => {
        const { unlockedAccount } = await import('./unlockedKeys');
        return unlockedAccount(userId)?.accountKey.slice() ?? null;
      },
      olderKey: async (commitment) =>
        (await import('./sealedSettings')).accountKeyByCommitment(
          userId,
          commitment
        ),
      device: localStorageFirstUsePinState(userId)
    },
    createFirstUsePinsApi(
      fetcher ??
        (async (path, init) =>
          (await import('../desktopBridge')).desktopFetch(path, init))
    )
  );
}
