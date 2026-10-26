/**
 * Fork-consistency pins for encrypted projects (ADR-024, Version integrity):
 * per account and project, the newest head this browser accepted (its
 * version hash, document version and key epoch), the newest project info it
 * accepted (its sequence and envelope hash), and the newest measurements
 * and view-state envelopes it accepted (slice 4-7). A current-head read must
 * descend from the pin and then moves it forward; a historical read never
 * moves it. A replaced envelope is never accepted below its pinned sequence,
 * nor at it with another hash.
 *
 * Kept in their own small IndexedDB database, `openzcad-e2ee-versions`, as
 * the MLS session store keeps its own: upgrading `openzcad-e2ee` (device
 * keys and device-list pins) would block on every tab still holding it at
 * version 1. Pins written before slice 4-7 read with no info hash and no
 * envelope pins.
 */

/** A replaced envelope's pin: its sequence and lowercase hex hash. */
export interface EnvelopePin {
  readonly sequence: number;
  readonly hash: string;
}

export interface ProjectVersionPin {
  /**
   * Lowercase hex version hash of the accepted head; null while this
   * browser has seen only the project's info (the shelf), never a head.
   */
  readonly headHash: string | null;
  readonly documentVersion: number;
  readonly keyEpoch: number;
  /** The newest project-info sequence accepted; 0 before any. */
  readonly infoSequence: number;
  /** That project info's envelope hash; null when not recorded. */
  readonly infoHash: string | null;
  /**
   * Measurements (`measurements`) and view states
   * (`view-state:<sessionId>`), by key.
   */
  readonly envelopes: Readonly<Record<string, EnvelopePin>>;
}

/** A head to pin: what `advance` swaps in. */
export interface PinnedHead {
  readonly headHash: string;
  readonly documentVersion: number;
  readonly keyEpoch: number;
}

export interface VersionPinStore {
  read(userId: string, projectId: string): Promise<ProjectVersionPin | null>;
  /**
   * Compare-and-swap: replaces the head only while the stored pin still
   * names `expectedHeadHash` (null: no head pinned yet), and never with a
   * lower document version or key epoch, or another head at the same
   * version. Resolves false, writing nothing, when another tab moved it
   * meanwhile.
   */
  advance(
    userId: string,
    projectId: string,
    expectedHeadHash: string | null,
    next: PinnedHead
  ): Promise<boolean>;
  /**
   * Raises the info sequence (and records its hash); false when the stored
   * one is newer, or the same sequence with another hash.
   */
  advanceInfo(
    userId: string,
    projectId: string,
    sequence: number,
    hash?: string
  ): Promise<boolean>;
  /** The same rule for a measurements or view-state envelope, by key. */
  advanceEnvelope(
    userId: string,
    projectId: string,
    key: string,
    next: EnvelopePin
  ): Promise<boolean>;
  /**
   * Forgets one project's pins: only for a migration's staged ciphertext
   * the account dropped (an abandon, slice 7-2), whose project is still
   * plaintext, so the next staging is not taken for a rollback.
   */
  forget?(userId: string, projectId: string): Promise<void>;
}

const HASH = /^[0-9a-f]{64}$/;
/** Envelope pins one project keeps (view states rotate; judgment). */
const MAX_ENVELOPE_PINS = 64;

function isEnvelopePin(value: unknown): value is EnvelopePin {
  const pin = value as Partial<EnvelopePin> | null;
  return (
    typeof pin === 'object' &&
    pin !== null &&
    Number.isSafeInteger(pin.sequence) &&
    typeof pin.hash === 'string' &&
    HASH.test(pin.hash)
  );
}

/** A stored pin, with the fields older pins lack filled in; null if invalid. */
function readPin(value: unknown): ProjectVersionPin | null {
  const pin = value as Partial<ProjectVersionPin> | null;
  if (
    typeof pin !== 'object' ||
    pin === null ||
    !(
      pin.headHash === null ||
      (typeof pin.headHash === 'string' && HASH.test(pin.headHash))
    ) ||
    !Number.isSafeInteger(pin.documentVersion) ||
    !Number.isSafeInteger(pin.keyEpoch) ||
    !Number.isSafeInteger(pin.infoSequence)
  ) {
    return null;
  }
  const envelopes: Record<string, EnvelopePin> = {};
  if (typeof pin.envelopes === 'object' && pin.envelopes !== null) {
    for (const [key, entry] of Object.entries(pin.envelopes)) {
      if (isEnvelopePin(entry)) envelopes[key] = entry;
    }
  }
  return {
    headHash: pin.headHash!,
    documentVersion: pin.documentVersion!,
    keyEpoch: pin.keyEpoch!,
    infoSequence: pin.infoSequence!,
    infoHash:
      typeof pin.infoHash === 'string' && HASH.test(pin.infoHash)
        ? pin.infoHash
        : null,
    envelopes
  };
}

const emptyPin = (): ProjectVersionPin => ({
  headHash: null,
  documentVersion: 0,
  keyEpoch: 0,
  infoSequence: 0,
  infoHash: null,
  envelopes: {}
});

/** The head swap both stores apply inside one transaction. */
export function swappedPin(
  current: ProjectVersionPin | null,
  expectedHeadHash: string | null,
  next: PinnedHead
): ProjectVersionPin | null {
  if (!HASH.test(next.headHash)) return null;
  const head = current?.headHash ?? null;
  if (head !== expectedHeadHash) return null;
  if (
    current &&
    head !== null &&
    (next.documentVersion < current.documentVersion ||
      next.keyEpoch < current.keyEpoch ||
      (next.documentVersion === current.documentVersion &&
        next.headHash !== head))
  ) {
    return null;
  }
  return {
    ...(current ?? emptyPin()),
    headHash: next.headHash,
    documentVersion: next.documentVersion,
    keyEpoch: next.keyEpoch
  };
}

/**
 * Whether a replaced envelope at `sequence` with `hash` may follow the one
 * pinned: never an older sequence, never the pinned sequence with another
 * hash (a fork), and a hash the pin did not record is taken as it comes.
 */
export function envelopeMayFollow(
  pinned: { sequence: number; hash: string | null } | null,
  sequence: number,
  hash: string | null
): boolean {
  if (!pinned) return true;
  if (sequence < pinned.sequence) return false;
  return !(
    sequence === pinned.sequence &&
    hash !== null &&
    pinned.hash !== null &&
    hash !== pinned.hash
  );
}

function raisedInfo(
  current: ProjectVersionPin | null,
  sequence: number,
  hash: string | null
): ProjectVersionPin | null {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (hash !== null && !HASH.test(hash)) return null;
  if (
    current &&
    !envelopeMayFollow(
      { sequence: current.infoSequence, hash: current.infoHash },
      sequence,
      hash
    )
  ) {
    return null;
  }
  const base = current ?? emptyPin();
  return {
    ...base,
    infoSequence: sequence,
    infoHash: hash ?? (sequence === base.infoSequence ? base.infoHash : null)
  };
}

function raisedEnvelope(
  current: ProjectVersionPin | null,
  key: string,
  next: EnvelopePin
): ProjectVersionPin | null {
  if (!isEnvelopePin(next) || next.sequence < 0 || key.length > 256) {
    return null;
  }
  const base = current ?? emptyPin();
  if (
    !envelopeMayFollow(base.envelopes[key] ?? null, next.sequence, next.hash)
  ) {
    return null;
  }
  const envelopes = { ...base.envelopes };
  delete envelopes[key];
  envelopes[key] = { sequence: next.sequence, hash: next.hash };
  // The oldest-written pins go first (insertion order).
  const keys = Object.keys(envelopes);
  for (const stale of keys.slice(
    0,
    Math.max(0, keys.length - MAX_ENVELOPE_PINS)
  )) {
    delete envelopes[stale];
  }
  return { ...base, envelopes };
}

export function memoryVersionPins(): VersionPinStore {
  const pins = new Map<string, ProjectVersionPin>();
  const id = (userId: string, projectId: string) =>
    JSON.stringify([userId, projectId]);
  const update = (
    userId: string,
    projectId: string,
    change: (current: ProjectVersionPin | null) => ProjectVersionPin | null
  ) => {
    const next = change(pins.get(id(userId, projectId)) ?? null);
    if (next) pins.set(id(userId, projectId), next);
    return next !== null;
  };
  return {
    read: async (userId, projectId) => pins.get(id(userId, projectId)) ?? null,
    advance: async (userId, projectId, expected, next) =>
      update(userId, projectId, (current) =>
        swappedPin(current, expected, next)
      ),
    advanceInfo: async (userId, projectId, sequence, hash) =>
      update(userId, projectId, (current) =>
        raisedInfo(current, sequence, hash ?? null)
      ),
    advanceEnvelope: async (userId, projectId, key, next) =>
      update(userId, projectId, (current) =>
        raisedEnvelope(current, key, next)
      ),
    forget: async (userId, projectId) => {
      pins.delete(id(userId, projectId));
    }
  };
}

export const VERSION_PIN_DATABASE = 'openzcad-e2ee-versions';
const PINS = 'pins';

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(VERSION_PIN_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PINS)) {
        db.createObjectStore(PINS);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB did not open'));
    };
  });
  return opening;
}

/** Read and write in one transaction, so two tabs cannot both swap. */
async function transact(
  userId: string,
  projectId: string,
  change:
    ((current: ProjectVersionPin | null) => ProjectVersionPin | null) | null
): Promise<{ current: ProjectVersionPin | null; changed: boolean }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PINS, change ? 'readwrite' : 'readonly');
    const objects = tx.objectStore(PINS);
    let result = { current: null as ProjectVersionPin | null, changed: false };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB version pin transaction failed'));
    const read = objects.get([userId, projectId]);
    read.onsuccess = () => {
      const current = readPin(read.result);
      const next = change ? change(current) : null;
      if (next) objects.put(next, [userId, projectId]);
      result = { current: next ?? current, changed: next !== null };
    };
  });
}

export function indexedDbVersionPins(): VersionPinStore {
  return {
    read: async (userId, projectId) =>
      (await transact(userId, projectId, null)).current,
    advance: async (userId, projectId, expected, next) =>
      (
        await transact(userId, projectId, (current) =>
          swappedPin(current, expected, next)
        )
      ).changed,
    advanceInfo: async (userId, projectId, sequence, hash) =>
      (
        await transact(userId, projectId, (current) =>
          raisedInfo(current, sequence, hash ?? null)
        )
      ).changed,
    advanceEnvelope: async (userId, projectId, key, next) =>
      (
        await transact(userId, projectId, (current) =>
          raisedEnvelope(current, key, next)
        )
      ).changed,
    forget: async (userId, projectId) => {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PINS, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB version pin delete failed'));
        tx.objectStore(PINS).delete([userId, projectId]);
      });
    }
  };
}

let shared: VersionPinStore | null = null;

/** This browser's pins: IndexedDB, or memory where it is unavailable. */
export function versionPins(): VersionPinStore {
  shared ??=
    typeof indexedDB === 'undefined'
      ? memoryVersionPins()
      : indexedDbVersionPins();
  return shared;
}
