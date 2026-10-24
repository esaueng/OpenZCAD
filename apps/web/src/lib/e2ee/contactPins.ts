/**
 * This browser's pins for contacts (ADR-024, Version integrity): per
 * account, the newest entry of the account's own identity-signed contacts
 * list it accepted (so an older or forked list is refused), and per contact
 * the newest identity and device-list head it has been shown. A seen pin is
 * only that: it is displayed with a warning and never used to wrap a key.
 * A verified pin comes from the signed contacts list; the seen pin of a
 * verified contact moves its accepted head forward between signatures.
 *
 * Kept in their own small IndexedDB database, `openzcad-e2ee-contacts`, as
 * the version pins and the MLS session store keep theirs: upgrading
 * `openzcad-e2ee` (device keys and device-list pins) would block on every
 * tab still holding it at version 1.
 */

const HASH = /^[0-9a-f]{64}$/;
const MAX_U32 = 0xffffffff;

/** The newest own contacts entry this browser accepted. */
export interface ContactsListPinRecord {
  /** Lowercase hex identity key hash of the list's owner. */
  readonly identityKeyHash: string;
  readonly sequence: number;
  /** Lowercase hex `contactsEntryHash`. */
  readonly entryHash: string;
}

/** What this browser has been shown of one contact's keys. */
export interface ContactPin {
  readonly contactUserId: string;
  /** Lowercase hex `publicKeyHash` of the identity key last accepted. */
  readonly identityKeyHash: string;
  /** The newest device-list entry accepted under that identity. */
  readonly sequence: number;
  /** Its lowercase hex `deviceListEntryHash`. */
  readonly entryHash: string;
  /**
   * A verified identity was replaced by this one. Kept until a key change
   * is signed into the contacts list and the contact is verified again.
   */
  readonly keyChanged: boolean;
  /** Unix milliseconds this identity was first seen. */
  readonly seenAt: number;
}

export interface ContactPinStore {
  readList(userId: string): Promise<ContactsListPinRecord | null>;
  /**
   * Moves the list pin forward: never to a lower sequence, nor to the same
   * sequence with another hash, under the same identity. Another identity
   * replaces it (the caller already accepted the account's new identity).
   * False, writing nothing, when the stored pin is newer.
   */
  advanceList(userId: string, next: ContactsListPinRecord): Promise<boolean>;
  readContact(
    userId: string,
    contactUserId: string
  ): Promise<ContactPin | null>;
  listContacts(userId: string): Promise<ContactPin[]>;
  /**
   * The same rule per contact. Another identity replaces the pin only with
   * `replaceIdentity`, which the caller sets after warning about it.
   */
  advanceContact(
    userId: string,
    next: ContactPin,
    options?: { readonly replaceIdentity?: boolean }
  ): Promise<boolean>;
}

const isSequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_U32;

function readListPin(value: unknown): ContactsListPinRecord | null {
  const pin = value as Partial<ContactsListPinRecord> | null;
  return typeof pin === 'object' &&
    pin !== null &&
    typeof pin.identityKeyHash === 'string' &&
    HASH.test(pin.identityKeyHash) &&
    typeof pin.entryHash === 'string' &&
    HASH.test(pin.entryHash) &&
    isSequence(pin.sequence)
    ? {
        identityKeyHash: pin.identityKeyHash,
        sequence: pin.sequence,
        entryHash: pin.entryHash
      }
    : null;
}

function readContactPin(value: unknown): ContactPin | null {
  const pin = value as Partial<ContactPin> | null;
  return typeof pin === 'object' &&
    pin !== null &&
    typeof pin.contactUserId === 'string' &&
    pin.contactUserId.length > 0 &&
    typeof pin.identityKeyHash === 'string' &&
    HASH.test(pin.identityKeyHash) &&
    typeof pin.entryHash === 'string' &&
    HASH.test(pin.entryHash) &&
    isSequence(pin.sequence) &&
    Number.isSafeInteger(pin.seenAt)
    ? {
        contactUserId: pin.contactUserId,
        identityKeyHash: pin.identityKeyHash,
        sequence: pin.sequence,
        entryHash: pin.entryHash,
        keyChanged: pin.keyChanged === true,
        seenAt: pin.seenAt!
      }
    : null;
}

/** Whether `next` may follow `current` under one identity. */
function follows(
  current: { sequence: number; entryHash: string },
  next: { sequence: number; entryHash: string }
): boolean {
  return (
    next.sequence > current.sequence ||
    (next.sequence === current.sequence && next.entryHash === current.entryHash)
  );
}

/** The list pin to store, or null to refuse. */
export function advancedListPin(
  current: ContactsListPinRecord | null,
  next: ContactsListPinRecord
): ContactsListPinRecord | null {
  const valid = readListPin(next);
  if (!valid) return null;
  if (
    current &&
    current.identityKeyHash === valid.identityKeyHash &&
    !follows(current, valid)
  ) {
    return null;
  }
  return valid;
}

/** The contact pin to store, or null to refuse. */
export function advancedContactPin(
  current: ContactPin | null,
  next: ContactPin,
  replaceIdentity = false
): ContactPin | null {
  const valid = readContactPin(next);
  if (!valid) return null;
  if (!current) return valid;
  if (current.identityKeyHash !== valid.identityKeyHash) {
    return replaceIdentity ? valid : null;
  }
  if (!follows(current, valid)) return null;
  // The first sighting of an identity stays its first sighting.
  return { ...valid, seenAt: Math.min(current.seenAt, valid.seenAt) };
}

export function memoryContactPins(): ContactPinStore {
  const lists = new Map<string, ContactsListPinRecord>();
  const contacts = new Map<string, ContactPin>();
  const id = (userId: string, contactUserId: string) =>
    JSON.stringify([userId, contactUserId]);
  return {
    readList: async (userId) => lists.get(userId) ?? null,
    advanceList: async (userId, next) => {
      const stored = advancedListPin(lists.get(userId) ?? null, next);
      if (stored) lists.set(userId, stored);
      return stored !== null;
    },
    readContact: async (userId, contactUserId) =>
      contacts.get(id(userId, contactUserId)) ?? null,
    listContacts: async (userId) =>
      [...contacts.entries()]
        .filter(([key]) => (JSON.parse(key) as string[])[0] === userId)
        .map(([, pin]) => pin)
        .sort((a, b) => (a.contactUserId < b.contactUserId ? -1 : 1)),
    advanceContact: async (userId, next, options = {}) => {
      const key = id(userId, next.contactUserId);
      const stored = advancedContactPin(
        contacts.get(key) ?? null,
        next,
        options.replaceIdentity
      );
      if (stored) contacts.set(key, stored);
      return stored !== null;
    }
  };
}

export const CONTACT_PIN_DATABASE = 'openzcad-e2ee-contacts';
const LISTS = 'lists';
const CONTACTS = 'contacts';

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(CONTACT_PIN_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LISTS)) db.createObjectStore(LISTS);
      if (!db.objectStoreNames.contains(CONTACTS)) {
        db.createObjectStore(CONTACTS);
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

/** Read and maybe write one record in one transaction, so tabs cannot race. */
async function transact<T>(
  store: string,
  key: IDBValidKey,
  read: (value: unknown) => T | null,
  change: ((current: T | null) => T | null) | null
): Promise<{ current: T | null; changed: boolean }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, change ? 'readwrite' : 'readonly');
    const objects = tx.objectStore(store);
    let result = { current: null as T | null, changed: false };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB contact pin transaction failed'));
    const request = objects.get(key);
    request.onsuccess = () => {
      const current = read(request.result);
      const next = change ? change(current) : null;
      if (next) objects.put(next, key);
      result = { current: next ?? current, changed: next !== null };
    };
  });
}

export function indexedDbContactPins(): ContactPinStore {
  return {
    readList: async (userId) =>
      (await transact(LISTS, userId, readListPin, null)).current,
    advanceList: async (userId, next) =>
      (
        await transact(LISTS, userId, readListPin, (current) =>
          advancedListPin(current, next)
        )
      ).changed,
    readContact: async (userId, contactUserId) =>
      (await transact(CONTACTS, [userId, contactUserId], readContactPin, null))
        .current,
    listContacts: async (userId) => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(CONTACTS, 'readonly');
        const request = tx.objectStore(CONTACTS).getAll(
          // Arrays sort after every string, so this spans every
          // contact id of `userId`.
          IDBKeyRange.bound([userId, ''], [userId, []])
        );
        request.onsuccess = () =>
          resolve(
            (request.result as unknown[])
              .map(readContactPin)
              .filter((pin): pin is ContactPin => pin !== null)
          );
        request.onerror = () =>
          reject(
            request.error ?? new Error('IndexedDB contact pin read failed')
          );
      });
    },
    advanceContact: async (userId, next, options = {}) =>
      (
        await transact(
          CONTACTS,
          [userId, next.contactUserId],
          readContactPin,
          (current) =>
            advancedContactPin(current, next, options.replaceIdentity)
        )
      ).changed
  };
}

let shared: ContactPinStore | null = null;

/** This browser's contact pins: IndexedDB, or memory where it is unavailable. */
export function contactPins(): ContactPinStore {
  shared ??=
    typeof indexedDB === 'undefined'
      ? memoryContactPins()
      : indexedDbContactPins();
  return shared;
}
