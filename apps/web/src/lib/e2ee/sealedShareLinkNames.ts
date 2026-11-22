import {
  accountKeyCommitment,
  fromBase64Url,
  isE2eeError,
  openRecord,
  readSealedRecordHeader,
  sealRecord,
  SHARE_LINK_NAMES_RECORD,
  toBase64Url,
  toHex
} from '@openzcad/crypto';
import { normalizeShareLinkLabel } from '@openzcad/shared';
import { realmStorageName } from '../deploymentRealm';

/**
 * The owner's names for the share links of end-to-end encrypted projects,
 * synced between the owner's devices in one account record sealed under the
 * account key (ADR-024 amendment 2026-11-22). Neither the server nor the
 * projects' members can read them.
 *
 * Every device keeps its own copy (the "book") and merges the account's
 * into it whenever it can open the record: each link's entry is
 * last-writer-wins by its stamp, and clearing a name or revoking its link
 * leaves a tombstone so an older copy cannot bring the name back. While the
 * record cannot be opened here (keys locked, another account key this
 * device cannot reach, altered bytes), this device keeps and shows its own
 * copy, and does not overwrite a record it could not read.
 */

/** A link's name, or a tombstone where it was cleared or the link revoked. */
export type ShareLinkNameEntry =
  | { readonly name: string; readonly stamp: number }
  | { readonly deleted: true; readonly stamp: number };

export interface ShareLinkNameBook {
  readonly version: 1;
  /** Project id → share id → entry. */
  readonly projects: Readonly<
    Record<string, Readonly<Record<string, ShareLinkNameEntry>>>
  >;
}

export const EMPTY_SHARE_LINK_NAME_BOOK: ShareLinkNameBook = {
  version: 1,
  projects: {}
};

/**
 * Tombstones older than this are dropped when the book is sealed: by then
 * every device that was online has merged them. A device offline for longer
 * could bring a cleared name back for a link that still exists; a revoked
 * link's name stays hidden because only listed links show one.
 */
export const SHARE_LINK_NAME_TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_ID_LENGTH = 128;
const MAX_STAMP = 8.64e15;

function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validStamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_STAMP
  );
}

function parseEntry(value: unknown): ShareLinkNameEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!validStamp(entry.stamp)) return null;
  if (entry.deleted === true) return { deleted: true, stamp: entry.stamp };
  if (typeof entry.name !== 'string') return null;
  let name: string | null;
  try {
    name = normalizeShareLinkLabel(entry.name);
  } catch {
    return null;
  }
  return name === null || name !== entry.name
    ? null
    : { name, stamp: entry.stamp };
}

/**
 * A name book, or null for anything that is not one. Malformed entries are
 * dropped, not the whole book: one bad name must not hide the rest.
 */
export function parseShareLinkNameBook(
  value: unknown
): ShareLinkNameBook | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const book = value as Record<string, unknown>;
  if (book.version !== 1) return null;
  const projects = book.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects))
    return null;
  const out: Record<string, Record<string, ShareLinkNameEntry>> = {};
  for (const [projectId, links] of Object.entries(projects)) {
    if (!validId(projectId) || !links || typeof links !== 'object') continue;
    if (Array.isArray(links)) continue;
    const entries: Record<string, ShareLinkNameEntry> = {};
    for (const [shareId, raw] of Object.entries(links as object)) {
      const entry = validId(shareId) ? parseEntry(raw) : null;
      if (entry) entries[shareId] = entry;
    }
    if (Object.keys(entries).length > 0) out[projectId] = entries;
  }
  return { version: 1, projects: out };
}

/**
 * Which of two entries for one link wins: the later stamp; on a tie a
 * tombstone, then the name that sorts last, so every device agrees.
 */
function newer(
  a: ShareLinkNameEntry,
  b: ShareLinkNameEntry
): ShareLinkNameEntry {
  if (a.stamp !== b.stamp) return a.stamp > b.stamp ? a : b;
  if ('deleted' in a) return a;
  if ('deleted' in b) return b;
  return a.name >= b.name ? a : b;
}

/** Both books, entry by entry. Commutative, associative and idempotent. */
export function mergeShareLinkNameBooks(
  a: ShareLinkNameBook,
  b: ShareLinkNameBook
): ShareLinkNameBook {
  const projects: Record<string, Record<string, ShareLinkNameEntry>> = {};
  for (const book of [a, b]) {
    for (const [projectId, links] of Object.entries(book.projects)) {
      const merged = (projects[projectId] ??= {});
      for (const [shareId, entry] of Object.entries(links)) {
        const existing = merged[shareId];
        merged[shareId] = existing ? newer(existing, entry) : entry;
      }
    }
  }
  return { version: 1, projects };
}

/**
 * The book with one link's name set, or cleared with a tombstone (`name`
 * null). The stamp is the clock, but always past the entry it replaces, so
 * a device whose clock runs behind still wins with its own later edit.
 */
export function setShareLinkName(
  book: ShareLinkNameBook,
  projectId: string,
  shareId: string,
  name: string | null,
  now: number
): ShareLinkNameBook {
  if (!validId(projectId) || !validId(shareId)) {
    throw new RangeError('A link name needs a project and link id.');
  }
  const label = name === null ? null : normalizeShareLinkLabel(name);
  const links = book.projects[projectId] ?? {};
  const previous = links[shareId];
  const stamp = Math.min(
    MAX_STAMP,
    Math.max(Math.floor(now), (previous?.stamp ?? -1) + 1)
  );
  const entry: ShareLinkNameEntry =
    label === null ? { deleted: true, stamp } : { name: label, stamp };
  return {
    version: 1,
    projects: { ...book.projects, [projectId]: { ...links, [shareId]: entry } }
  };
}

/** The names of a project's links, by share id; tombstones left out. */
export function shareLinkNamesFor(
  book: ShareLinkNameBook,
  projectId: string
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [shareId, entry] of Object.entries(
    book.projects[projectId] ?? {}
  )) {
    if (!('deleted' in entry)) names[shareId] = entry.name;
  }
  return names;
}

/** A reissued link and the revoked link it replaces (`ShareWork.replacements`). */
export interface ShareLinkReplacement {
  readonly sourceId: string;
  readonly shareId: string;
}

/**
 * Gives each reissued link the name of the link it replaces, with that
 * name's own stamp: the replacement inherits an edit made before it existed,
 * so any rename or clear of the replacement, made after the reissue on any
 * device, outranks it when copies merge (PR 1938 review). A replacement that
 * already has an entry keeps it, and a source whose name was cleared or
 * whose link was revoked from the dialog gives nothing.
 *
 * Callers apply this to the account's copy merged with this device's
 * (`changeShareLinkNames`), never to a device copy alone, so the source's
 * name is the latest one any device saved.
 */
export function carryReissuedShareLinkNames(
  book: ShareLinkNameBook,
  projectId: string,
  replacements: readonly ShareLinkReplacement[]
): ShareLinkNameBook {
  const links = book.projects[projectId] ?? {};
  let carried: Record<string, ShareLinkNameEntry> | null = null;
  for (const { sourceId, shareId } of replacements) {
    const source = links[sourceId];
    if (!validId(shareId) || !source || 'deleted' in source) continue;
    if (links[shareId] || carried?.[shareId]) continue;
    (carried ??= {})[shareId] = { name: source.name, stamp: source.stamp };
  }
  if (!carried) return book;
  return {
    version: 1,
    projects: { ...book.projects, [projectId]: { ...links, ...carried } }
  };
}

/**
 * Clears the name of each reissued link's source once the replacement has
 * an entry in the same copy. Only a reissue's own sources are cleared, and
 * only by the device that holds the reissue's record of them: a link that
 * is merely revoked keeps its name in the record (it is never shown, since
 * only listed links show one). So a reissue that stops halfway, or links an
 * identity change turned off before the owner reissues them, lose no name
 * that a later replacement still needs (PR 1938 review).
 */
export function clearReissuedSourceNames(
  book: ShareLinkNameBook,
  projectId: string,
  revoked: ReadonlySet<string>,
  replacements: readonly ShareLinkReplacement[],
  now: number
): ShareLinkNameBook {
  let next = book;
  for (const { sourceId, shareId } of replacements) {
    const links = next.projects[projectId] ?? {};
    const source = links[sourceId];
    if (!revoked.has(sourceId) || !source || 'deleted' in source) continue;
    if (!links[shareId]) continue;
    next = setShareLinkName(next, projectId, sourceId, null, now);
  }
  return next;
}

/**
 * What a list does to the names: reissued links take their sources' names,
 * then those sources' names are cleared. In that order, in one change on the
 * merged copy, so a reissue never loses a name to its own clearing.
 */
export function refreshShareLinkNames(
  book: ShareLinkNameBook,
  projectId: string,
  revoked: ReadonlySet<string>,
  replacements: readonly ShareLinkReplacement[],
  now: number
): ShareLinkNameBook {
  return clearReissuedSourceNames(
    carryReissuedShareLinkNames(book, projectId, replacements),
    projectId,
    revoked,
    replacements,
    now
  );
}

/** Keys sorted at every level, so equal books seal equal bytes. */
function canonicalJson(book: ShareLinkNameBook): string {
  const projects: Record<string, Record<string, ShareLinkNameEntry>> = {};
  for (const projectId of Object.keys(book.projects).sort()) {
    const links = book.projects[projectId]!;
    const sorted: Record<string, ShareLinkNameEntry> = {};
    for (const shareId of Object.keys(links).sort()) {
      const entry = links[shareId]!;
      sorted[shareId] =
        'deleted' in entry
          ? { deleted: true, stamp: entry.stamp }
          : { name: entry.name, stamp: entry.stamp };
    }
    if (Object.keys(sorted).length > 0) projects[projectId] = sorted;
  }
  return JSON.stringify({ version: 1, projects });
}

/**
 * The book's sealed plaintext, with tombstones past their age dropped. No
 * other entry is dropped to fit the record's cap, not even a recent
 * tombstone: another device that missed the clear would bring the name back
 * (PR 1921 review). Over the cap, the save is refused instead.
 */
export function encodeShareLinkNameBook(
  book: ShareLinkNameBook,
  now: number
): Uint8Array {
  const projects: Record<string, Record<string, ShareLinkNameEntry>> = {};
  for (const [projectId, links] of Object.entries(book.projects)) {
    const kept: Record<string, ShareLinkNameEntry> = {};
    for (const [shareId, entry] of Object.entries(links)) {
      if (
        'deleted' in entry &&
        now - entry.stamp > SHARE_LINK_NAME_TOMBSTONE_MS
      )
        continue;
      kept[shareId] = entry;
    }
    projects[projectId] = kept;
  }
  const bytes = new TextEncoder().encode(
    canonicalJson({ version: 1, projects })
  );
  if (bytes.byteLength > SHARE_LINK_NAMES_RECORD.maxPlaintextBytes) {
    throw new RangeError(
      'Too many link names to save to your account. Cleared names count for 90 days, so clearing more may not help at once.'
    );
  }
  return bytes;
}

// --- Device storage ---------------------------------------------------------

export interface ShareLinkNameSequencePins {
  read(): number;
  write(sequence: number): void;
}

export interface ShareLinkNameDeviceCopy {
  read(): ShareLinkNameBook;
  write(book: ShareLinkNameBook): void;
}

const SEQUENCE_PREFIX = realmStorageName(
  'openzcad.shareLinkNames.sealed.sequence.v1'
);
const DEVICE_PREFIX = realmStorageName('openzcad.shareLinkNames.device.v1');
/** Shared across reads even when persistent storage refuses a pin. */
const sequenceFloors = new Map<string, number>();
/** This visit's copy, for a browser that refuses device storage. */
const deviceCopies = new Map<string, ShareLinkNameBook>();

/** The highest sealed-names sequence this device opened or wrote. */
export function localStorageShareLinkNamePins(
  userId: string
): ShareLinkNameSequencePins {
  const key = `${SEQUENCE_PREFIX}:${userId}`;
  const remember = (value: number) => {
    const floor = Math.max(
      sequenceFloors.get(userId) ?? 0,
      Number.isSafeInteger(value) && value > 0 ? value : 0
    );
    sequenceFloors.set(userId, floor);
    return floor;
  };
  const read = (): number => {
    try {
      return remember(Number(globalThis.localStorage?.getItem(key) ?? 0));
    } catch {
      return remember(0);
    }
  };
  return {
    read,
    write(sequence: number) {
      const floor = remember(Math.max(read(), sequence));
      try {
        globalThis.localStorage?.setItem(key, String(floor));
      } catch {
        // The memory floor still protects this visit.
      }
    }
  };
}

/** This device's copy of the account's link names. */
export function localStorageShareLinkNameCopy(
  userId: string
): ShareLinkNameDeviceCopy {
  const key = `${DEVICE_PREFIX}:${userId}`;
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        const book = raw ? parseShareLinkNameBook(JSON.parse(raw)) : null;
        if (book) return mergeWithVisit(userId, book);
      } catch {
        // Unreadable storage: this visit's copy below.
      }
      return deviceCopies.get(userId) ?? EMPTY_SHARE_LINK_NAME_BOOK;
    },
    write(book) {
      deviceCopies.set(userId, book);
      try {
        globalThis.localStorage?.setItem(key, canonicalJson(book));
      } catch {
        // This visit's copy still holds it.
      }
    }
  };
}

function mergeWithVisit(
  userId: string,
  book: ShareLinkNameBook
): ShareLinkNameBook {
  const visit = deviceCopies.get(userId);
  return visit ? mergeShareLinkNameBooks(visit, book) : book;
}

/**
 * Forgets this device's copy at sign-out, as the shelf forgets encrypted
 * project names; the account's sealed record keeps them.
 */
export function forgetShareLinkNames(userId: string): void {
  deviceCopies.delete(userId);
  try {
    globalThis.localStorage?.removeItem(`${DEVICE_PREFIX}:${userId}`);
  } catch {
    // Storage unavailable.
  }
}

// --- The account record ------------------------------------------------------

export interface ShareLinkNamesSnapshot {
  revision: number;
  sequence: number;
  record: string | null;
}

/** The Worker's `SHARE_LINK_NAMES_CONFLICT`, with the copy it holds now. */
export class ShareLinkNamesConflict extends Error {
  constructor(readonly current: ShareLinkNamesSnapshot) {
    super('Your link names changed on another device.');
    this.name = 'ShareLinkNamesConflict';
  }
}

export interface ShareLinkNamesApi {
  load(): Promise<ShareLinkNamesSnapshot>;
  /** Throws `ShareLinkNamesConflict` when the account copy moved on. */
  save(
    expectedRevision: number,
    record: string
  ): Promise<ShareLinkNamesSnapshot>;
}

export interface ShareLinkNameKeys {
  accountKey: Uint8Array;
  userId: string;
  pins: ShareLinkNameSequencePins;
  device: ShareLinkNameDeviceCopy;
  /** Another account key by its commitment (`accountKeyByCommitment`). */
  olderKey?: (commitment: Uint8Array) => Promise<Uint8Array | null>;
  /**
   * The session's account key as it is now, for sealing: an unlock of the
   * same key may have replaced the buffer `accountKey` names (and zeroed
   * it). Null once the session ended. Without it, `accountKey`.
   */
  liveKey?: () => Uint8Array | null;
  /**
   * Whether the session these keys came from is still the page's: false
   * once the account signed out or locked, when teardown zeroes the key.
   */
  active?: () => boolean;
  now?: () => number;
}

/** Thrown when the session ended while a read or change was under way. */
export class ShareLinkNamesSessionEnded extends Error {
  constructor() {
    super('The encryption session ended. Unlock again to name links.');
    this.name = 'ShareLinkNamesSessionEnded';
  }
}

function requireActive(keys: ShareLinkNameKeys): void {
  if (keys.active && !keys.active()) throw new ShareLinkNamesSessionEnded();
}

function isZeroed(key: Uint8Array): boolean {
  return key.every((byte) => byte === 0);
}

/**
 * What a stored record gives this device:
 * - `opened`: its book; the pin rose to its sequence.
 * - `replace`: older than a record this device already opened or wrote (a
 *   rollback, refused): everything in it is already merged here.
 * - `unreadable`: a record this device cannot open and must not overwrite:
 *   altered, another layout, content that is not a book, or sealed under an
 *   account key this device cannot reach now. That last one may be a newer
 *   key this device has not caught up with, or an older one whose history
 *   failed to load, so overwriting it could lose another device's names
 *   (PR 1921 review).
 */
export type OpenedShareLinkNames =
  | { readonly kind: 'opened'; readonly book: ShareLinkNameBook }
  | { readonly kind: 'replace' }
  | { readonly kind: 'unreadable' };

export async function openShareLinkNames(
  keys: ShareLinkNameKeys,
  record: string
): Promise<OpenedShareLinkNames> {
  let older: Uint8Array | null = null;
  try {
    let sealed: Uint8Array;
    let header: ReturnType<typeof readSealedRecordHeader>;
    try {
      sealed = fromBase64Url(record);
      header = readSealedRecordHeader(SHARE_LINK_NAMES_RECORD, sealed);
    } catch {
      return { kind: 'unreadable' };
    }
    if (header.sequence < keys.pins.read()) return { kind: 'replace' };
    let accountKey = (keys.liveKey ? keys.liveKey() : null) ?? keys.accountKey;
    if (
      toHex(header.commitment) !== toHex(await accountKeyCommitment(accountKey))
    ) {
      // Sealed under another account key: open it with that key through the
      // account-key history, or leave it alone.
      try {
        older = (await keys.olderKey?.(header.commitment)) ?? null;
      } catch {
        older = null;
      }
      if (!older) return { kind: 'unreadable' };
      accountKey = older;
    }
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await openRecord(
        SHARE_LINK_NAMES_RECORD,
        accountKey,
        keys.userId,
        sealed
      ));
    } catch (error) {
      if (isE2eeError(error)) return { kind: 'unreadable' };
      throw error;
    }
    let book: ShareLinkNameBook | null;
    try {
      book = parseShareLinkNameBook(
        JSON.parse(new TextDecoder().decode(plaintext))
      );
    } catch {
      book = null;
    }
    if (!book) return { kind: 'unreadable' };
    keys.pins.write(header.sequence);
    return { kind: 'opened', book };
  } finally {
    older?.fill(0);
  }
}

/**
 * The account's names merged into this device's copy, which keeps the
 * result. Where the record cannot be read or fetched, this device's copy.
 */
export async function readShareLinkNames(
  keys: ShareLinkNameKeys,
  api: ShareLinkNamesApi
): Promise<ShareLinkNameBook> {
  const device = keys.device.read();
  let snapshot: ShareLinkNamesSnapshot;
  try {
    snapshot = await api.load();
  } catch {
    return device;
  }
  if (snapshot.record === null) return device;
  const opened = await openShareLinkNames(keys, snapshot.record);
  if (opened.kind !== 'opened') return device;
  // A session that ended meanwhile must not put names back on the device.
  requireActive(keys);
  const merged = mergeShareLinkNameBooks(device, opened.book);
  keys.device.write(merged);
  return merged;
}

/** A name change kept on this device only: the account's record could not be read here. */
export class ShareLinkNamesKeptOnDevice extends Error {
  constructor() {
    super(
      'Saved on this device only: your account’s link names could not be opened here.'
    );
    this.name = 'ShareLinkNamesKeptOnDevice';
  }
}

const SAVE_ATTEMPTS = 4;

/**
 * Applies `change` to the account's names merged with this device's copy,
 * seals the result past both this device's pin and the stored sequence,
 * and stores it against the revision it read; a concurrent write from
 * another device is merged and the change applied again. This device's
 * copy takes the change first, so it shows even when the save fails.
 */
export async function changeShareLinkNames(
  keys: ShareLinkNameKeys,
  api: ShareLinkNamesApi,
  change: (book: ShareLinkNameBook, now: number) => ShareLinkNameBook
): Promise<ShareLinkNameBook> {
  const now = keys.now ?? Date.now;
  requireActive(keys);
  let snapshot = await api.load();
  for (let attempt = 0; ; attempt++) {
    const opened =
      snapshot.record === null
        ? null
        : await openShareLinkNames(keys, snapshot.record);
    // Every await may have ended the session: its teardown zeroes the key
    // and forgets the device copy, which nothing here may bring back.
    requireActive(keys);
    const device = keys.device.read();
    const base =
      opened?.kind === 'opened'
        ? mergeShareLinkNameBooks(device, opened.book)
        : device;
    const at = now();
    const next = change(base, at);
    keys.device.write(next);
    if (opened?.kind === 'unreadable') throw new ShareLinkNamesKeptOnDevice();
    const sequence = Math.max(keys.pins.read(), snapshot.sequence) + 1;
    // Sealed with a copy taken now, while the session is known to be live:
    // a teardown zeroing the shared key mid-seal cannot reach it.
    const live = keys.liveKey ? keys.liveKey() : keys.accountKey;
    if (!live) throw new ShareLinkNamesSessionEnded();
    const accountKey = live.slice();
    let sealed: Uint8Array;
    try {
      if (isZeroed(accountKey)) throw new ShareLinkNamesSessionEnded();
      sealed = await sealRecord(
        SHARE_LINK_NAMES_RECORD,
        accountKey,
        keys.userId,
        sequence,
        encodeShareLinkNameBook(next, at)
      );
    } finally {
      accountKey.fill(0);
    }
    requireActive(keys);
    try {
      await api.save(snapshot.revision, toBase64Url(sealed));
    } catch (error) {
      if (error instanceof ShareLinkNamesConflict && attempt < SAVE_ATTEMPTS) {
        snapshot = error.current;
        continue;
      }
      throw error;
    }
    keys.pins.write(sequence);
    return next;
  }
}

// --- The page ----------------------------------------------------------------

function conflictSnapshot(error: unknown): ShareLinkNamesSnapshot | null {
  const failure = error as {
    code?: unknown;
    details?: { current?: unknown };
  } | null;
  const current = failure?.details?.current as
    Partial<ShareLinkNamesSnapshot> | undefined;
  return failure?.code === 'SHARE_LINK_NAMES_CONFLICT' &&
    current &&
    typeof current.revision === 'number' &&
    typeof current.sequence === 'number'
    ? {
        revision: current.revision,
        sequence: current.sequence,
        record: typeof current.record === 'string' ? current.record : null
      }
    : null;
}

/** The Worker's route (`worker/shareLinkNames.ts`) through the page's API. */
async function pageApi(): Promise<ShareLinkNamesApi> {
  const { api } = await import('../api');
  const snapshot = (value: ShareLinkNamesSnapshot): ShareLinkNamesSnapshot => ({
    revision: value.revision,
    sequence: value.sequence,
    record: value.record
  });
  return {
    load: async () => snapshot(await api.getShareLinkNames()),
    async save(expectedRevision, record) {
      try {
        return snapshot(
          await api.saveShareLinkNames({ expectedRevision, record })
        );
      } catch (error) {
        const current = conflictSnapshot(error);
        if (current) throw new ShareLinkNamesConflict(current);
        throw error;
      }
    }
  };
}

/** This page's keys for the account's names, or null while they are locked. */
async function pageKeys(userId: string): Promise<ShareLinkNameKeys | null> {
  const [{ unlockedAccount }, { accountKeyByCommitment }] = await Promise.all([
    import('./unlockedKeys'),
    import('./sealedSettings')
  ]);
  const account = unlockedAccount(userId);
  if (!account) return null;
  const unlocked = account;
  return {
    accountKey: account.accountKey,
    userId,
    pins: localStorageShareLinkNamePins(userId),
    device: localStorageShareLinkNameCopy(userId),
    // Across identity generations: a recovery-key replacement keeps the
    // old account key only in the history (PR 1921 review).
    olderKey: (commitment) => accountKeyByCommitment(userId, commitment),
    // The same key still unlocked: a sign-out ends it; a second unlock of
    // the same key (its own buffer) does not.
    active: () => sameUnlock(unlockedAccount(userId)) !== null,
    liveKey: () => sameUnlock(unlockedAccount(userId))?.accountKey ?? null
  };

  function sameUnlock(current: typeof account | undefined) {
    return current &&
      current.generation === unlocked.generation &&
      current.commitment === unlocked.commitment &&
      !isZeroed(current.accountKey)
      ? current
      : null;
  }
}

/**
 * The names of a project's listed links, for its share dialog. Reissued
 * links take the names of the links they replace, whose names are then
 * cleared (`refreshShareLinkNames`): shown at once, and saved to the
 * account record in the background, merged with it first.
 */
export async function pageShareLinkNames(
  userId: string,
  projectId: string,
  listed: ReadonlySet<string>,
  revoked: ReadonlySet<string>,
  replacements: readonly ShareLinkReplacement[] = []
): Promise<Record<string, string>> {
  const refresh = (book: ShareLinkNameBook, at: number) =>
    refreshShareLinkNames(book, projectId, revoked, replacements, at);
  const keys = await pageKeys(userId);
  if (!keys) {
    // Shown, not kept: this device cannot seal the change while locked.
    const device = localStorageShareLinkNameCopy(userId).read();
    return pickListed(
      shareLinkNamesFor(refresh(device, Date.now()), projectId)
    );
  }
  const api = await pageApi();
  const book = await readShareLinkNames(keys, api);
  const shown = refresh(book, Date.now());
  if (shown !== book) {
    void changeShareLinkNames(keys, api, refresh).catch(() => {
      // Done again on the next list.
    });
  }
  return pickListed(shareLinkNamesFor(shown, projectId));

  function pickListed(names: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(names).filter(([shareId]) => listed.has(shareId))
    );
  }
}

/** Names a link (or clears its name, `name` null) in the account record. */
export async function renamePageShareLink(
  userId: string,
  projectId: string,
  shareId: string,
  name: string | null
): Promise<void> {
  const keys = await pageKeys(userId);
  if (!keys) {
    throw new Error('Unlock encryption on this device to name links.');
  }
  await changeShareLinkNames(keys, await pageApi(), (book, now) =>
    setShareLinkName(book, projectId, shareId, name, now)
  );
}
