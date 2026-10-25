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
  ...overrides
});

describe('contact pins', () => {
  it('move the own list pin forward only, and restart for a new identity', async () => {
    for (const [name, pins] of await stores()) {
      const pin = { identityKeyHash: H('a'), sequence: 3, entryHash: H('3') };
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
      const fresh = { identityKeyHash: H('b'), sequence: 0, entryHash: H('0') };
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
});
