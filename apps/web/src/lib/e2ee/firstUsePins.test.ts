import { describe, expect, it } from 'vitest';
import {
  EMPTY_FIRST_USE_PIN_BOOK,
  FirstUsePinsConflict,
  FirstUsePinsUnavailable,
  encodeFirstUsePinBook,
  firstUseStanding,
  memoryFirstUsePinState,
  mergeFirstUsePinBooks,
  parseFirstUsePinBook,
  pinFirstUse,
  sealedFirstUsePins,
  trustFirstUse,
  type FirstUsePinBook,
  type FirstUsePinsApi,
  type FirstUsePinsSnapshot
} from './firstUsePins';

/**
 * The account's first-use pins (ADR-024 amendment 2026-11-25): an identity
 * one device of the account added is what every other device compares
 * against, and a superseded identity never counts again.
 */

const K1 = '11'.repeat(32);
const K2 = '22'.repeat(32);
const K3 = '33'.repeat(32);
const BOB = 'user_bob';

const pinned = (book: FirstUsePinBook, identity: string, at = 10) =>
  pinFirstUse(book, BOB, identity, at)!;

describe('first-use pins', () => {
  it('pins the first identity, and calls any other a key change, never a first use', () => {
    expect(firstUseStanding(EMPTY_FIRST_USE_PIN_BOOK, BOB, K1)).toBe('new');
    const book = pinned(EMPTY_FIRST_USE_PIN_BOOK, K1);
    expect(firstUseStanding(book, BOB, K1)).toBe('pinned');
    expect(firstUseStanding(book, BOB, K2)).toBe('changed');
    // Pinning again changes nothing; pinning another identity is refused.
    expect(pinFirstUse(book, BOB, K1, 20)).toBe(book);
    expect(pinFirstUse(book, BOB, K2, 20)).toBeNull();
    expect(firstUseStanding(book, 'user_carol', K2)).toBe('new');
  });

  it('treats two devices that first saw different identities as a key change for both', () => {
    const laptop = pinned(EMPTY_FIRST_USE_PIN_BOOK, K1);
    const desktop = pinned(EMPTY_FIRST_USE_PIN_BOOK, K2, 11);
    const merged = mergeFirstUsePinBooks(laptop, desktop);
    expect(firstUseStanding(merged, BOB, K1)).toBe('changed');
    expect(firstUseStanding(merged, BOB, K2)).toBe('changed');
    // Merging is order-independent and idempotent.
    expect(mergeFirstUsePinBooks(desktop, laptop)).toEqual(merged);
    expect(mergeFirstUsePinBooks(merged, merged)).toEqual(merged);
  });

  it('counts the trusted identity only, and never again one a trust superseded', () => {
    let book = pinned(EMPTY_FIRST_USE_PIN_BOOK, K1);
    // The signed contacts list verified K3 once: trusting K2 retires it too.
    book = trustFirstUse(book, BOB, K2, 30, [K3]);
    expect(firstUseStanding(book, BOB, K2)).toBe('trusted');
    expect(firstUseStanding(book, BOB, K1)).toBe('changed');
    expect(firstUseStanding(book, BOB, K3)).toBe('changed');
    expect(book.people[BOB]!.retired).toEqual([K1, K3]);
    // A rolled-back copy without the trust still knows K1 only: merged, the
    // trust stands.
    const stale = pinned(EMPTY_FIRST_USE_PIN_BOOK, K1);
    const merged = mergeFirstUsePinBooks(stale, book);
    expect(firstUseStanding(merged, BOB, K1)).toBe('changed');
    expect(firstUseStanding(merged, BOB, K2)).toBe('trusted');
    // The later trust wins, whichever device made it.
    const later = trustFirstUse(book, BOB, K1, 40);
    expect(firstUseStanding(mergeFirstUsePinBooks(book, later), BOB, K1)).toBe(
      'trusted'
    );
  });

  it('round-trips its canonical encoding and drops malformed entries', () => {
    const book = trustFirstUse(
      pinned(EMPTY_FIRST_USE_PIN_BOOK, K1),
      BOB,
      K2,
      5
    );
    const decoded = parseFirstUsePinBook(
      JSON.parse(new TextDecoder().decode(encodeFirstUsePinBook(book)))
    );
    expect(decoded).toEqual(book);
    expect(
      parseFirstUsePinBook({
        version: 1,
        people: { [BOB]: { seen: { nothex: 1, [K1]: -1 }, retired: ['x'] } }
      })
    ).toEqual({ version: 1, people: { [BOB]: { seen: {}, retired: [] } } });
    expect(parseFirstUsePinBook({ version: 2, people: {} })).toBeNull();
  });
});

/** The Worker's compare-and-set, in memory. */
function memoryApi(): FirstUsePinsApi & { snapshot: FirstUsePinsSnapshot } {
  const api = {
    snapshot: {
      revision: 0,
      sequence: 0,
      record: null
    } as FirstUsePinsSnapshot,
    async load() {
      return api.snapshot;
    },
    async save(expectedRevision: number, record: string) {
      if (expectedRevision !== api.snapshot.revision) {
        throw new FirstUsePinsConflict(api.snapshot);
      }
      const bytes = Uint8Array.from(
        atob(record.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0)
      );
      const sequence = new DataView(bytes.buffer, 33, 4).getUint32(0);
      api.snapshot = { revision: expectedRevision + 1, sequence, record };
      return api.snapshot;
    }
  };
  return api;
}

const KEY = new Uint8Array(32).fill(7);
const keysFor = (
  device = memoryFirstUsePinState(),
  key: Uint8Array | null = KEY
) => ({
  userId: 'user_alice',
  accountKey: async () => key && key.slice(),
  device,
  now: () => 1000
});

describe('the sealed account record', () => {
  it('shares one device’s pin with another, and merges concurrent writes', async () => {
    const api = memoryApi();
    const laptop = sealedFirstUsePins(keysFor(), api);
    const desktop = sealedFirstUsePins(keysFor(), api);
    await laptop.change((book, at) => pinFirstUse(book, BOB, K1, at));
    expect(firstUseStanding(await desktop.read(), BOB, K2)).toBe('changed');
    expect(firstUseStanding(await desktop.read(), BOB, K1)).toBe('pinned');
    // A pin that is already there writes nothing.
    const revision = api.snapshot.revision;
    await desktop.change((book, at) => pinFirstUse(book, BOB, K1, at));
    expect(api.snapshot.revision).toBe(revision);
    // A refused change stores nothing.
    expect(
      await desktop.change((book, at) => pinFirstUse(book, BOB, K2, at))
    ).toBeNull();
    expect(api.snapshot.revision).toBe(revision);
  });

  it('refuses a rolled-back or withdrawn record: nobody is a first use against it', async () => {
    const api = memoryApi();
    const device = memoryFirstUsePinState();
    const laptop = sealedFirstUsePins(keysFor(device), api);
    const before = api.snapshot;
    await laptop.change((book, at) => pinFirstUse(book, BOB, K1, at));
    const pinnedRecord = api.snapshot;
    await laptop.change((book, at) => pinFirstUse(book, 'user_carol', K2, at));
    // The server answers an older record, or none, for the same account.
    api.snapshot = pinnedRecord;
    await expect(laptop.read()).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
    api.snapshot = before;
    await expect(laptop.read()).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
    await expect(
      laptop.change((book, at) => pinFirstUse(book, BOB, K2, at))
    ).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
  });

  it('fails closed when the record cannot be fetched or opened', async () => {
    const api = memoryApi();
    await sealedFirstUsePins(keysFor(), api).change((book, at) =>
      pinFirstUse(book, BOB, K1, at)
    );
    // Locked, another account key, or no route: nothing is a first use.
    await expect(
      sealedFirstUsePins(keysFor(undefined, null), api).read()
    ).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
    await expect(
      sealedFirstUsePins(
        keysFor(undefined, new Uint8Array(32).fill(9)),
        api
      ).read()
    ).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
    await expect(
      sealedFirstUsePins(keysFor(), {
        load: async () => {
          throw new Error('offline');
        },
        save: api.save
      }).read()
    ).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
    // A record this device cannot open is never overwritten.
    const revision = api.snapshot.revision;
    await expect(
      sealedFirstUsePins(
        keysFor(undefined, new Uint8Array(32).fill(9)),
        api
      ).change((book, at) => pinFirstUse(book, BOB, K2, at))
    ).rejects.toBeInstanceOf(FirstUsePinsUnavailable);
    expect(api.snapshot.revision).toBe(revision);
  });
});
