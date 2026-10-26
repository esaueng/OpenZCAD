import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContactPin,
  ContactPinStore,
  ContactsListPinRecord
} from './contactPins';

const H = (digit: string) => digit.repeat(64);

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
});

async function stores(): Promise<[string, ContactPinStore][]> {
  const pins = await import('./contactPins');
  return [
    ['memory', pins.memoryContactPins()],
    ['IndexedDB', pins.indexedDbContactPins()]
  ];
}

const seen = (overrides: Partial<ContactPin> = {}): ContactPin => ({
  contactUserId: 'bob',
  identityKeyHash: H('a'),
  sequence: 2,
  entryHash: H('1'),
  keyChanged: false,
  seenAt: 100,
  verifiedHere: null,
  ...overrides
});

describe('contact pins', () => {
  it('does not confirm a nonempty pin from an empty approval', async () => {
    const { EMPTY_CONTACTS_SEQUENCE, EMPTY_CONTACTS_HASH } =
      await import('./contactPins');
    for (const [name, pins] of await stores()) {
      for (const sequence of [0, 3])
        for (const confirmed of [false, true]) {
          const user = `empty-${sequence}-${confirmed}`;
          const current = {
            identityKeyHash: H('a'),
            sequence,
            entryHash: H('3'),
            confirmed: false
          };
          await pins.advanceList(user, current);
          await pins.advanceList(
            user,
            { ...current, sequence: 5, entryHash: H('5'), confirmed: true },
            { fromApproval: true }
          );
          const before = await pins.readList(user);
          const empty = {
            ...current,
            sequence: EMPTY_CONTACTS_SEQUENCE,
            entryHash: EMPTY_CONTACTS_HASH,
            confirmed
          };
          expect(
            await pins.advanceList(user, empty, { fromApproval: true }),
            name
          ).toBe(false);
          expect(await pins.readList(user), name).toEqual(before);
        }
      const empty = {
        identityKeyHash: H('a'),
        sequence: EMPTY_CONTACTS_SEQUENCE,
        entryHash: EMPTY_CONTACTS_HASH,
        confirmed: true
      };
      expect(
        await pins.advanceList('fresh-empty', empty, { fromApproval: true }),
        name
      ).toBe(true);
      await pins.advanceList('matching-empty', { ...empty, confirmed: false });
      expect(
        await pins.advanceList('matching-empty', empty, { fromApproval: true }),
        name
      ).toBe(true);
      expect((await pins.readList('matching-empty'))?.confirmed, name).toBe(
        false
      );
      expect((await pins.readList('fresh-empty'))?.confirmed, name).toBe(false);
    }
  });

  it('fences contact identity replacements to the checked own-list snapshot', async () => {
    for (const [name, pins] of await stores()) {
      const anchor = {
        identityKeyHash: H('a'),
        sequence: 1,
        entryHash: H('1'),
        confirmed: true
      };
      const replacement = seen({
        identityKeyHash: H('c'),
        sequence: 0,
        entryHash: H('c'),
        keyChanged: true
      });
      const changes: ContactsListPinRecord[] = [
        { ...anchor, sequence: 2, entryHash: H('2') },
        {
          ...anchor,
          pendingApproval: { sequence: 2, entryHash: H('2'), confirmed: true }
        },
        { ...anchor, confirmed: false },
        { ...anchor, identityKeyHash: H('b') }
      ];
      for (const [index, changed] of changes.entries()) {
        const userId = `fence-${index}`;
        await pins.advanceList(userId, changed);
        if (changed.pendingApproval)
          await pins.advanceList(
            userId,
            { ...changed, ...changed.pendingApproval },
            { fromApproval: true }
          );
        await pins.advanceContact(userId, seen());
        expect(
          await pins.advanceContact(userId, replacement, {
            replaceIdentity: true,
            checkedList: anchor
          }),
          name
        ).toBe(false);
        expect(await pins.readContact(userId, 'bob'), name).toEqual(seen());
        expect(
          await pins.advanceContact(userId, replacement, {
            replaceIdentity: true,
            checkedList: changed
          }),
          name
        ).toBe(true);
      }
      await pins.advanceList('created', anchor);
      expect(
        await pins.advanceContact('created', seen(), { checkedList: null }),
        name
      ).toBe(false);
      expect(await pins.readContact('created', 'bob'), name).toBeNull();
      expect(
        await pins.advanceContact('absent', seen(), { checkedList: null }),
        name
      ).toBe(true);
    }
  });

  it('retains pending ancestry against prefixes, empty lists and incompatible later approvals', async () => {
    for (const [name, pins] of await stores()) {
      const pin = {
        identityKeyHash: H('a'),
        sequence: -1,
        entryHash: H('0'),
        confirmed: true
      };
      const head = { sequence: 2, entryHash: H('2'), confirmed: true };
      await pins.advanceList('me', pin);
      await pins.advanceList('me', { ...pin, ...head }, { fromApproval: true });
      const before = await pins.readList('me');
      for (const sequence of [-1, 0, 1]) {
        expect(
          await pins.advanceList(
            'me',
            { ...pin, sequence },
            {
              checkedAnchor: pin,
              checkedApproval: head
            }
          ),
          name
        ).toBe(false);
        expect(await pins.readList('me'), name).toEqual(before);
      }
      for (const other of [
        { sequence: 1, entryHash: H('1'), confirmed: false },
        { sequence: 2, entryHash: H('f'), confirmed: true },
        { sequence: 3, entryHash: H('3'), confirmed: true }
      ]) {
        expect(
          await pins.advanceList(
            'me',
            { ...pin, ...other },
            { fromApproval: true }
          ),
          name
        ).toBe(false);
        expect(await pins.readList('me'), name).toEqual(before);
      }
      expect(
        await pins.advanceList(
          'me',
          { ...pin, ...head, confirmed: false },
          { fromApproval: true }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('me'), name).toEqual(before);
      expect(
        await pins.advanceList(
          'me',
          { ...pin, ...head },
          { checkedAnchor: pin, checkedApproval: head }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('me'), name).toEqual({ ...pin, ...head });
    }
  });

  it('requires the checked main anchor before inheriting confirmation or replacing an identity', async () => {
    for (const [name, pins] of await stores()) {
      const anchor = {
        identityKeyHash: H('a'),
        sequence: 1,
        entryHash: H('1'),
        confirmed: false
      };
      const next = { ...anchor, sequence: 3, entryHash: H('3') };
      const changed = [
        { ...anchor, sequence: 2, entryHash: H('b'), confirmed: true },
        { ...anchor, identityKeyHash: H('b') },
        { ...anchor, sequence: 2 },
        { ...anchor, entryHash: H('b') },
        { ...anchor, confirmed: true }
      ];
      for (const [index, current] of changed.entries()) {
        const userId = `changed-${index}`;
        await pins.advanceList(userId, current);
        expect(
          await pins.advanceList(userId, next, { checkedAnchor: anchor }),
          name
        ).toBe(false);
        expect(await pins.readList(userId), name).toEqual(current);
      }
      await pins.advanceList('created', anchor);
      expect(
        await pins.advanceList('created', next, { checkedAnchor: null }),
        name
      ).toBe(false);
      expect(await pins.readList('created'), name).toEqual(anchor);
      expect(
        await pins.advanceList('absent', next, { checkedAnchor: anchor }),
        name
      ).toBe(false);
      expect(await pins.readList('absent'), name).toBeNull();
      expect(
        await pins.advanceList('fresh', anchor, { checkedAnchor: null }),
        name
      ).toBe(true);
      expect(
        await pins.advanceList('fresh', next, { checkedAnchor: anchor }),
        name
      ).toBe(true);
      expect(await pins.readList('fresh'), name).toEqual(next);
    }
  });

  it('refuses to consume an approval head the caller did not check', async () => {
    for (const [name, pins] of await stores()) {
      const pin = {
        identityKeyHash: H('a'),
        sequence: 1,
        entryHash: H('1'),
        confirmed: false
      };
      const approval = { sequence: 2, entryHash: H('2'), confirmed: true };
      await pins.advanceList('me', pin);
      await pins.advanceList(
        'me',
        { ...pin, ...approval },
        { fromApproval: true }
      );
      const before = await pins.readList('me');
      for (const sequence of [2, 3]) {
        expect(
          await pins.advanceList('me', { ...pin, sequence, entryHash: H('3') }),
          name
        ).toBe(false);
        expect(await pins.readList('me'), name).toEqual(before);
      }
    }
  });

  it('compares all checked approval fields before resolving and keeps future heads', async () => {
    for (const [name, pins] of await stores()) {
      const pin = {
        identityKeyHash: H('a'),
        sequence: 1,
        entryHash: H('1'),
        confirmed: false
      };
      const approval = { sequence: 2, entryHash: H('2'), confirmed: true };
      await pins.advanceList('me', pin);
      await pins.advanceList(
        'me',
        { ...pin, ...approval },
        { fromApproval: true }
      );
      const before = await pins.readList('me');
      const next = { ...pin, sequence: 3, entryHash: H('3'), confirmed: true };
      for (const checkedApproval of [
        { ...approval, sequence: 0 },
        { ...approval, entryHash: H('f') },
        { ...approval, confirmed: false }
      ]) {
        expect(
          await pins.advanceList('me', next, { checkedApproval }),
          name
        ).toBe(false);
        expect(await pins.readList('me'), name).toEqual(before);
      }
      expect(
        await pins.advanceList('me', next, { checkedApproval: approval }),
        name
      ).toBe(true);
      expect(await pins.readList('me'), name).toEqual(next);
      const future = { sequence: 5, entryHash: H('5'), confirmed: false };
      await pins.advanceList(
        'me',
        { ...next, ...future },
        { fromApproval: true }
      );
      expect(
        await pins.advanceList('me', {
          ...next,
          sequence: 4,
          entryHash: H('4')
        }),
        name
      ).toBe(false);
      expect((await pins.readList('me'))?.pendingApproval, name).toEqual(
        future
      );
    }
  });

  it('move the own list pin forward only, and restart for a new identity', async () => {
    for (const [name, pins] of await stores()) {
      const pin = {
        identityKeyHash: H('a'),
        sequence: 3,
        entryHash: H('3'),
        confirmed: false
      };
      expect(await pins.readList('me'), name).toBeNull();
      expect(await pins.advanceList('me', pin), name).toBe(true);
      // Older, or the same height with another entry: a rollback or fork.
      expect(await pins.advanceList('me', { ...pin, sequence: 2 }), name).toBe(
        false
      );
      expect(
        await pins.advanceList('me', { ...pin, entryHash: H('4') }),
        name
      ).toBe(false);
      expect(await pins.advanceList('me', pin), name).toBe(true);
      expect(
        await pins.advanceList('me', {
          ...pin,
          sequence: 4,
          entryHash: H('4')
        }),
        name
      ).toBe(true);
      // A replaced identity starts a fresh list.
      const fresh = {
        identityKeyHash: H('b'),
        sequence: 0,
        entryHash: H('0'),
        confirmed: false
      };
      expect(await pins.advanceList('me', fresh), name).toBe(true);
      expect(await pins.readList('me'), name).toEqual(fresh);
      expect(await pins.readList('someone-else'), name).toBeNull();
      expect(
        await pins.advanceList('me', { ...fresh, entryHash: 'not hex' }),
        name
      ).toBe(false);
    }
  });

  it('keep a contact pin from moving back, and replace an identity only when asked', async () => {
    for (const [name, pins] of await stores()) {
      expect(await pins.advanceContact('me', seen()), name).toBe(true);
      expect(await pins.advanceContact('me', seen({ sequence: 1 })), name).toBe(
        false
      );
      expect(
        await pins.advanceContact('me', seen({ entryHash: H('2') })),
        name
      ).toBe(false);
      expect(
        await pins.advanceContact(
          'me',
          seen({ sequence: 3, entryHash: H('3'), seenAt: 500 })
        ),
        name
      ).toBe(true);
      // The first sighting of an identity is kept.
      expect(await pins.readContact('me', 'bob'), name).toMatchObject({
        sequence: 3,
        seenAt: 100
      });
      const changed = seen({
        identityKeyHash: H('c'),
        sequence: 0,
        entryHash: H('0'),
        keyChanged: true,
        seenAt: 900
      });
      expect(await pins.advanceContact('me', changed), name).toBe(false);
      expect(
        await pins.advanceContact('me', changed, { replaceIdentity: true }),
        name
      ).toBe(true);
      expect(await pins.readContact('me', 'bob'), name).toEqual(changed);
      await pins.advanceContact('me', seen({ contactUserId: 'carol' }));
      await pins.advanceContact('other', seen({ contactUserId: 'dave' }));
      expect(
        (await pins.listContacts('me')).map((pin) => pin.contactUserId),
        name
      ).toEqual(['bob', 'carol']);
    }
  });

  it('keep a confirmed list pin confirmed, and let only an approval confirm one', async () => {
    for (const [name, pins] of await stores()) {
      const {
        EMPTY_CONTACTS_HASH: emptyHash,
        EMPTY_CONTACTS_SEQUENCE: emptySequence
      } = await import('./contactPins');
      // Setup: the list was empty when this browser created the identity.
      const empty = {
        identityKeyHash: H('a'),
        sequence: emptySequence,
        entryHash: emptyHash,
        confirmed: true
      };
      expect(await pins.advanceList('me', empty), name).toBe(true);
      expect(await pins.readList('me'), name).toEqual(empty);
      // What the server shows moves it forward and never unconfirms it.
      const shown = {
        identityKeyHash: H('a'),
        sequence: 0,
        entryHash: H('0'),
        confirmed: false
      };
      expect(await pins.advanceList('me', shown), name).toBe(true);
      expect(await pins.readList('me'), name).toEqual({
        ...shown,
        confirmed: true
      });
      // An empty list is not a valid move back.
      expect(await pins.advanceList('me', empty), name).toBe(false);

      // A passkey enrolment starts from the server's list, unconfirmed.
      const passkey = { ...shown, sequence: 5, entryHash: H('5') };
      expect(await pins.advanceList('pk', passkey), name).toBe(true);
      expect((await pins.readList('pk'))?.confirmed, name).toBe(false);
      // Claiming confirmation on the server's word does nothing special.
      const claimed = { ...passkey, sequence: 3, entryHash: H('3') };
      expect(
        await pins.advanceList('pk', { ...claimed, confirmed: true }),
        name
      ).toBe(false);
      // An approval head never moves the pin, older or newer: it waits
      // beside it until an accepted list shows it on the same chain.
      const approve = (head: object) =>
        pins.advanceList('pk', { ...passkey, ...head }, { fromApproval: true });
      expect(
        await approve({ sequence: 3, entryHash: H('3'), confirmed: true }),
        name
      ).toBe(true);
      expect(await pins.readList('pk'), name).toEqual({
        ...passkey,
        confirmed: false,
        pendingApproval: { sequence: 3, entryHash: H('3'), confirmed: true }
      });
      // A second approval cannot discard an unchecked ancestry obligation.
      expect(
        await approve({ sequence: 9, entryHash: H('9'), confirmed: true }),
        name
      ).toBe(false);
      expect(
        await pins.advanceList(
          'pk',
          { ...passkey, confirmed: true },
          {
            checkedApproval: { sequence: 3, entryHash: H('3'), confirmed: true }
          }
        ),
        name
      ).toBe(true);
      expect(
        await approve({ sequence: 9, entryHash: H('9'), confirmed: true }),
        name
      ).toBe(true);
      expect(await pins.readList('pk'), name).toEqual({
        ...passkey,
        confirmed: true,
        pendingApproval: { sequence: 9, entryHash: H('9'), confirmed: true }
      });
      // A list must reach the authenticated head before it is usable.
      const later = { ...passkey, sequence: 6, entryHash: H('6') };
      expect(await pins.advanceList('pk', later), name).toBe(false);
      expect((await pins.readList('pk'))?.pendingApproval?.sequence, name).toBe(
        9
      );
      const reached = { ...passkey, sequence: 9, entryHash: H('9') };
      expect(
        await pins.advanceList(
          'pk',
          { ...reached, confirmed: true },
          {
            checkedApproval: { sequence: 9, entryHash: H('9'), confirmed: true }
          }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('pk'), name).toEqual({
        ...reached,
        confirmed: true
      });
      // The pin's own height with another hash is a fork: refused.
      expect(
        await approve({ ...reached, entryHash: H('7'), confirmed: true }),
        name
      ).toBe(false);
      // A confirmed pin is never replaced by a newer unconfirmed head: it
      // stays confirmed at its own head, the head only pending.
      expect(
        await approve({ sequence: 12, entryHash: H('c'), confirmed: false }),
        name
      ).toBe(true);
      expect(await pins.readList('pk'), name).toEqual({
        ...reached,
        confirmed: true,
        pendingApproval: { sequence: 12, entryHash: H('c'), confirmed: false }
      });
      // An approval equal to the pin, or one that saw the list only empty,
      // confirms in place.
      await pins.advanceList('pk2', passkey);
      expect(
        await pins.advanceList(
          'pk2',
          { ...passkey, confirmed: true },
          { fromApproval: true }
        ),
        name
      ).toBe(true);
      expect((await pins.readList('pk2'))?.confirmed, name).toBe(true);
      await pins.advanceList('pk3', passkey);
      expect(
        await pins.advanceList(
          'pk3',
          { ...empty, confirmed: true },
          { fromApproval: true }
        ),
        name
      ).toBe(false);
      expect(await pins.readList('pk3'), name).toEqual({
        ...passkey,
        confirmed: false
      });
      // A browser with no pin adopts the head; an unconfirmed approver's
      // head stays unconfirmed.
      expect(
        await pins.advanceList(
          'other',
          { ...passkey, confirmed: false },
          { fromApproval: true }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('other'), name).toEqual({
        ...passkey,
        confirmed: false
      });
      // A malformed empty marker is refused.
      expect(
        await pins.advanceList('me', { ...empty, entryHash: H('1') }),
        name
      ).toBe(false);
    }
  });

  it('read a list pin stored before confirmation existed as confirmed', async () => {
    const legacy = { identityKeyHash: H('a'), sequence: 2, entryHash: H('2') };
    const { indexedDbContactPins, CONTACT_PIN_DATABASE } =
      await import('./contactPins');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(CONTACT_PIN_DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('lists');
        request.result.createObjectStore('contacts');
      };
      request.onsuccess = () => {
        const tx = request.result.transaction('lists', 'readwrite');
        tx.objectStore('lists').put(legacy, 'me');
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      };
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
    const pins = indexedDbContactPins();
    expect(await pins.readList('me')).toEqual({ ...legacy, confirmed: true });
  });

  it('keep a comparison made here until the contact’s identity changes', async () => {
    for (const [name, pins] of await stores()) {
      await pins.advanceContact('me', seen({ verifiedHere: H('a') }));
      // Inspecting again (no comparison) keeps it.
      await pins.advanceContact(
        'me',
        seen({ sequence: 3, entryHash: H('3'), verifiedHere: null })
      );
      expect((await pins.readContact('me', 'bob'))?.verifiedHere, name).toBe(
        H('a')
      );
      await pins.advanceContact(
        'me',
        seen({ identityKeyHash: H('c'), keyChanged: true }),
        { replaceIdentity: true }
      );
      expect(
        (await pins.readContact('me', 'bob'))?.verifiedHere,
        name
      ).toBeNull();
    }
  });
});
