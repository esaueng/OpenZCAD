import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactPin, ContactPinStore } from './contactPins';

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
      // An approving device's older head never moves the pin back: it
      // waits beside it until an accepted list shows it is an ancestor.
      expect(
        await pins.advanceList(
          'pk',
          { ...claimed, confirmed: true },
          { fromApproval: true }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('pk'), name).toEqual({
        ...passkey,
        confirmed: false,
        confirmAt: { sequence: 3, entryHash: H('3') }
      });
      // The server moving the pin forward keeps it pending.
      const later = { ...passkey, sequence: 6, entryHash: H('6') };
      expect(await pins.advanceList('pk', later), name).toBe(true);
      expect((await pins.readList('pk'))?.confirmAt, name).toEqual({
        sequence: 3,
        entryHash: H('3')
      });
      // The same height with another hash is a fork: refused.
      expect(
        await pins.advanceList(
          'pk',
          { ...later, entryHash: H('7'), confirmed: true },
          { fromApproval: true }
        ),
        name
      ).toBe(false);
      // An equal or newer approval head is adopted, confirmed.
      expect(
        await pins.advanceList(
          'pk',
          { ...later, confirmed: true },
          { fromApproval: true }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('pk'), name).toEqual({
        ...later,
        confirmed: true
      });
      // A confirmed pin is never rolled back, and an approver that saw the
      // list only empty confirms an unconfirmed one in place.
      expect(
        await pins.advanceList(
          'pk',
          { ...claimed, sequence: 2, entryHash: H('2'), confirmed: true },
          { fromApproval: true }
        ),
        name
      ).toBe(false);
      await pins.advanceList('pk2', passkey);
      expect(
        await pins.advanceList(
          'pk2',
          { ...empty, confirmed: true },
          {
            fromApproval: true
          }
        ),
        name
      ).toBe(true);
      expect(await pins.readList('pk2'), name).toEqual({
        ...passkey,
        confirmed: true
      });
      expect(
        await pins.advanceList(
          'other',
          { ...passkey, confirmed: false },
          { fromApproval: true }
        ),
        name
      ).toBe(true);
      expect((await pins.readList('other'))?.confirmed, name).toBe(false);
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
