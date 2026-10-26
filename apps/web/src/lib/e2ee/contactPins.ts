/**
 * This browser's pins for contacts (ADR-024, Version integrity): per
 * account, the newest entry of the account's own identity-signed contacts
 * list it accepted (so an older or forked list is refused), and per contact
 * the newest identity and device-list head it has been shown. A seen pin is
 * only that: it is displayed with a warning and never used to wrap a key.
 * A verified pin comes from the signed contacts list; the seen pin of a
 * verified contact moves its accepted head forward between signatures.
 *
 * The list pin also records where this browser's trust in the list starts
 * (ADR-024, verified pins). It is confirmed when it descends from a trusted
 * start: this browser set up the identity (the list was empty), or another
 * of the user's devices handed it its newest contacts head inside the
 * authenticated approval exchange. A browser enrolled with only a passkey
 * or the recovery key starts from whatever list the server shows, so its
 * pin is unconfirmed, and it treats every verified pin as seen until
 * another device confirms the head or the user compares codes again here
 * (`verifiedHere`).
 *
 * Kept in their own small IndexedDB database, `openzcad-e2ee-contacts`, as
 * the version pins and the MLS session store keep theirs: upgrading
 * `openzcad-e2ee` (device keys and device-list pins) would block on every
 * tab still holding it at version 1.
 */

const HASH = /^[0-9a-f]{64}$/;
const MAX_U32 = 0xffffffff;

/** `ContactsListPinRecord.sequence` of a list this browser saw empty. */
export const EMPTY_CONTACTS_SEQUENCE = -1;
/** `ContactsListPinRecord.entryHash` of a list this browser saw empty. */
export const EMPTY_CONTACTS_HASH = '0'.repeat(64);

/** The newest own contacts entry this browser accepted. */
export interface ContactsListPinRecord {
  /** Lowercase hex identity key hash of the list's owner. */
  readonly identityKeyHash: string;
  /** `EMPTY_CONTACTS_SEQUENCE` while the list was empty when trusted. */
  readonly sequence: number;
  /** Lowercase hex `contactsEntryHash`; `EMPTY_CONTACTS_HASH` when empty. */
  readonly entryHash: string;
  /**
   * The pin descends from a trusted start (setup, or an approving device's
   * grant) rather than only from the server's word. Records written before
   * this existed read as confirmed.
   */
  readonly confirmed: boolean;
  /**
   * The newest approval head this browser received for an existing pin,
   * not yet checked against it. A grant never replaces a pin: the next
   * list this browser accepts must extend the pin and, once it reaches
   * this sequence, hold exactly this entry there. Only then does the
   * grant's `confirmed` count, and the pin still moves only with that list.
   */
  readonly pendingApproval?: ApprovalHeadRecord;
}

/** An approving device's signed contacts head, waiting to be checked. */
export interface ApprovalHeadRecord {
  readonly sequence: number;
  /** Lowercase hex `contactsEntryHash`. */
  readonly entryHash: string;
  /** The approver's own pin was confirmed. */
  readonly confirmed: boolean;
}

export interface ListPinAdvanceOptions {
  readonly fromApproval?: boolean;
  /** The main pin against which the caller checked ancestry; null if absent. */
  readonly checkedAnchor?: Omit<
    ContactsListPinRecord,
    'pendingApproval'
  > | null;
  /** The exact pending head verified against the accepted list. */
  readonly checkedApproval?: ApprovalHeadRecord;
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
  /**
   * The identity key hash the user verified on this browser by comparing
   * codes, or null. On a browser whose list pin is unconfirmed, only this
   * makes a verified contact count as verified.
   */
  readonly verifiedHere?: string | null;
}

export interface ContactPinStore {
  readList(userId: string): Promise<ContactsListPinRecord | null>;
  /**
   * Moves the list pin forward: never to a lower sequence, nor to the same
   * sequence with another hash, under the same identity. Another identity
   * replaces it (the caller already accepted the account's new identity).
   * False, writing nothing, when the stored pin is newer. A confirmed pin
   * stays confirmed as it moves forward; `confirmed: true` on a move is the
   * caller's claim that it checked the list against `pendingApproval`.
   * With `fromApproval` (a head an approving device signed) a browser with
   * no pin under this identity adopts the head; otherwise the pin never
   * moves: the head is recorded as `pendingApproval` (or, when it equals
   * the pin or is the empty list, its confirmation applies at once), and a
   * head at the pin's sequence with another hash is refused.
   */
  advanceList(
    userId: string,
    next: ContactsListPinRecord,
    options?: ListPinAdvanceOptions
  ): Promise<boolean>;
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
    options?: {
      readonly replaceIdentity?: boolean;
      /** Fence the write to the own-list authority checked by the caller. */
      readonly checkedList?: ContactsListPinRecord | null;
    }
  ): Promise<boolean>;
}

const isSequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_U32;

/**
 * A list pin as stored, or as a caller proposes it. A stored record from
 * before `confirmed` existed reads as confirmed (`legacyConfirmed`); a
 * proposed one is confirmed only when it says so.
 */
function readListPin(
  value: unknown,
  legacyConfirmed = true
): ContactsListPinRecord | null {
  const pin = value as Partial<ContactsListPinRecord> | null;
  if (
    typeof pin !== 'object' ||
    pin === null ||
    typeof pin.identityKeyHash !== 'string' ||
    !HASH.test(pin.identityKeyHash) ||
    typeof pin.entryHash !== 'string' ||
    !HASH.test(pin.entryHash)
  ) {
    return null;
  }
  const empty =
    pin.sequence === EMPTY_CONTACTS_SEQUENCE &&
    pin.entryHash === EMPTY_CONTACTS_HASH;
  if (!empty && !isSequence(pin.sequence)) return null;
  const at = pin.pendingApproval;
  const pendingApproval =
    typeof at === 'object' &&
    at !== null &&
    isSequence(at.sequence) &&
    at.sequence !== pin.sequence &&
    typeof at.entryHash === 'string' &&
    HASH.test(at.entryHash) &&
    typeof at.confirmed === 'boolean'
      ? {
          sequence: at.sequence,
          entryHash: at.entryHash,
          confirmed: at.confirmed
        }
      : null;
  const confirmed =
    pin.confirmed === undefined ? legacyConfirmed : pin.confirmed === true;
  return withPending(
    {
      identityKeyHash: pin.identityKeyHash,
      sequence: pin.sequence,
      entryHash: pin.entryHash,
      confirmed
    },
    confirmed,
    pendingApproval
  );
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
        seenAt: pin.seenAt!,
        verifiedHere:
          typeof pin.verifiedHere === 'string' && HASH.test(pin.verifiedHere)
            ? pin.verifiedHere
            : null
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
  next: ContactsListPinRecord,
  options: ListPinAdvanceOptions = {}
): ContactsListPinRecord | null {
  const valid = readListPin(next, false);
  if (!valid) return null;
  // A sequence comparison cannot prove descent from a pin installed by a
  // concurrent tab. Compare the main anchor before replacing an identity or
  // inheriting confirmation; pending approvals have their own check below.
  if (options.checkedAnchor !== undefined) {
    const checked = options.checkedAnchor;
    if (
      checked === null
        ? current !== null
        : current === null ||
          current.identityKeyHash !== checked.identityKeyHash ||
          current.sequence !== checked.sequence ||
          current.entryHash !== checked.entryHash ||
          current.confirmed !== checked.confirmed
    )
      return null;
  }
  // Nothing to protect under this identity: a fresh browser pins the head.
  if (!current || current.identityKeyHash !== valid.identityKeyHash) {
    return withPending(valid, valid.confirmed, null);
  }
  if (options.fromApproval) {
    // A grant never discards this browser's pin, whichever side is newer:
    // a server can show an unconfirmed approver a longer fork, or a stale
    // one an older head. It confirms at once only what needs no list: the
    // pin itself, or an approver that saw the list only empty.
    if (
      valid.sequence === EMPTY_CONTACTS_SEQUENCE ||
      (valid.sequence === current.sequence &&
        valid.entryHash === current.entryHash)
    ) {
      const confirmed = current.confirmed || valid.confirmed;
      return withPending(current, confirmed, current.pendingApproval ?? null);
    }
    if (valid.sequence === current.sequence) return null;
    const pending = current.pendingApproval;
    if (
      pending &&
      (pending.sequence !== valid.sequence ||
        pending.entryHash !== valid.entryHash)
    )
      return null;
    return withPending(current, current.confirmed, {
      sequence: valid.sequence,
      entryHash: valid.entryHash,
      confirmed: valid.confirmed || pending?.confirmed === true
    });
  }
  if (!follows(current, valid)) return null;
  const pendingHead = current.pendingApproval ?? null;
  if (pendingHead && valid.sequence < pendingHead.sequence) return null;
  // Another tab may have changed the pending head after the caller read it.
  // Consume only the exact head the caller checked, inside this transaction.
  const resolved =
    pendingHead !== null && valid.sequence >= pendingHead.sequence;
  if (
    resolved &&
    (options.checkedApproval?.sequence !== pendingHead.sequence ||
      options.checkedApproval.entryHash !== pendingHead.entryHash ||
      options.checkedApproval.confirmed !== pendingHead.confirmed)
  )
    return null;
  const confirmed = current.confirmed || valid.confirmed;
  return withPending(valid, confirmed, resolved ? null : pendingHead);
}

/** `record` as `confirmed`, with `pending` only while it may still confirm. */
function withPending(
  record: ContactsListPinRecord,
  confirmed: boolean,
  pending: ApprovalHeadRecord | null
): ContactsListPinRecord {
  const base = {
    identityKeyHash: record.identityKeyHash,
    sequence: record.sequence,
    entryHash: record.entryHash,
    confirmed
  };
  return pending && pending.sequence !== record.sequence
    ? { ...base, pendingApproval: pending }
    : base;
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
  // The first sighting of an identity stays its first sighting, and a
  // comparison made here stays until the identity changes.
  return {
    ...valid,
    seenAt: Math.min(current.seenAt, valid.seenAt),
    verifiedHere: valid.verifiedHere ?? current.verifiedHere ?? null
  };
}

function sameListPin(
  a: ContactsListPinRecord | null,
  b: ContactsListPinRecord | null
): boolean {
  if (!a || !b) return a === b;
  return (
    a.identityKeyHash === b.identityKeyHash &&
    a.sequence === b.sequence &&
    a.entryHash === b.entryHash &&
    a.confirmed === b.confirmed &&
    a.pendingApproval?.sequence === b.pendingApproval?.sequence &&
    a.pendingApproval?.entryHash === b.pendingApproval?.entryHash &&
    a.pendingApproval?.confirmed === b.pendingApproval?.confirmed
  );
}

export function memoryContactPins(): ContactPinStore {
  const lists = new Map<string, ContactsListPinRecord>();
  const contacts = new Map<string, ContactPin>();
  const id = (userId: string, contactUserId: string) =>
    JSON.stringify([userId, contactUserId]);
  return {
    readList: async (userId) => lists.get(userId) ?? null,
    advanceList: async (userId, next, options) => {
      const stored = advancedListPin(lists.get(userId) ?? null, next, options);
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
      if (
        options.checkedList !== undefined &&
        !sameListPin(lists.get(userId) ?? null, options.checkedList)
      )
        return false;
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
  change: ((current: T | null) => T | null) | null,
  fence?: { userId: string; expected: ContactsListPinRecord | null }
): Promise<{ current: T | null; changed: boolean }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      fence ? [store, LISTS] : store,
      change ? 'readwrite' : 'readonly'
    );
    const objects = tx.objectStore(store);
    let result = { current: null as T | null, changed: false };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB contact pin transaction failed'));
    const request = objects.get(key);
    request.onsuccess = () => {
      const current = read(request.result);
      const apply = () => {
        const next = change ? change(current) : null;
        if (next) objects.put(next, key);
        result = { current: next ?? current, changed: next !== null };
      };
      if (!fence) apply();
      else {
        const anchor = tx.objectStore(LISTS).get(fence.userId);
        anchor.onsuccess = () => {
          if (sameListPin(readListPin(anchor.result), fence.expected)) apply();
        };
      }
    };
  });
}

export function indexedDbContactPins(): ContactPinStore {
  return {
    readList: async (userId) =>
      (await transact(LISTS, userId, (value) => readListPin(value), null))
        .current,
    advanceList: async (userId, next, options) =>
      (
        await transact(
          LISTS,
          userId,
          (value) => readListPin(value),
          (current) => advancedListPin(current, next, options)
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
            advancedContactPin(current, next, options.replaceIdentity),
          options.checkedList === undefined
            ? undefined
            : { userId, expected: options.checkedList }
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
