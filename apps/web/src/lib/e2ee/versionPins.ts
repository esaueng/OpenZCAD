/**
 * Fork-consistency pins for encrypted projects (ADR-024, Version integrity):
 * per account and project, the newest head this browser accepted (its
 * version hash, document version and key epoch) and the newest project-info
 * sequence it saw. A current-head read must descend from the pin and then
 * moves it forward; a historical read never moves it.
 *
 * Kept in their own small IndexedDB database, `openzcad-e2ee-versions`, as
 * the MLS session store keeps its own: upgrading `openzcad-e2ee` (device
 * keys and device-list pins) would block on every tab still holding it at
 * version 1.
 */

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
  /** Raises the info sequence only; false when the stored one is newer. */
  advanceInfo(
    userId: string,
    projectId: string,
    sequence: number
  ): Promise<boolean>;
}

const HASH = /^[0-9a-f]{64}$/;

function isPin(value: unknown): value is ProjectVersionPin {
  const pin = value as Partial<ProjectVersionPin> | null;
  return (
    typeof pin === 'object' &&
    pin !== null &&
    (pin.headHash === null ||
      (typeof pin.headHash === 'string' && HASH.test(pin.headHash))) &&
    Number.isSafeInteger(pin.documentVersion) &&
    Number.isSafeInteger(pin.keyEpoch) &&
    Number.isSafeInteger(pin.infoSequence)
  );
}

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
    headHash: next.headHash,
    documentVersion: next.documentVersion,
    keyEpoch: next.keyEpoch,
    infoSequence: current?.infoSequence ?? 0
  };
}

function raisedInfo(
  current: ProjectVersionPin | null,
  sequence: number
): ProjectVersionPin | null {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (current && sequence < current.infoSequence) return null;
  return current
    ? { ...current, infoSequence: sequence }
    : {
        headHash: null,
        documentVersion: 0,
        keyEpoch: 0,
        infoSequence: sequence
      };
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
    advanceInfo: async (userId, projectId, sequence) =>
      update(userId, projectId, (current) => raisedInfo(current, sequence))
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
      const current = isPin(read.result) ? read.result : null;
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
    advanceInfo: async (userId, projectId, sequence) =>
      (
        await transact(userId, projectId, (current) =>
          raisedInfo(current, sequence)
        )
      ).changed
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
