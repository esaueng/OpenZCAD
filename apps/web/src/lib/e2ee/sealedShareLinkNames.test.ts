import { describe, expect, it, vi } from 'vitest';
import {
  fromBase64Url,
  readSealedRecordHeader,
  sealRecord,
  SHARE_LINK_NAMES_RECORD,
  toBase64Url
} from '@openzcad/crypto';
import {
  changeShareLinkNames,
  EMPTY_SHARE_LINK_NAME_BOOK,
  encodeShareLinkNameBook,
  forgetShareLinkNames,
  localStorageShareLinkNameCopy,
  mergeShareLinkNameBooks,
  openShareLinkNames,
  parseShareLinkNameBook,
  pruneUnlistedShareLinkNames,
  readShareLinkNames,
  setShareLinkName,
  SHARE_LINK_NAME_TOMBSTONE_MS,
  ShareLinkNamesConflict,
  ShareLinkNamesKeptOnDevice,
  shareLinkNamesFor,
  type ShareLinkNameBook,
  type ShareLinkNameKeys,
  type ShareLinkNamesApi,
  type ShareLinkNamesSnapshot
} from './sealedShareLinkNames';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const ROTATED = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const USER = 'user_alice';
const DAY = 24 * 60 * 60 * 1000;

function memoryKeys(
  accountKey = KEY,
  overrides: Partial<ShareLinkNameKeys> = {}
): ShareLinkNameKeys & { pin(): number; copy(): ShareLinkNameBook } {
  let pin = 0;
  let copy: ShareLinkNameBook = EMPTY_SHARE_LINK_NAME_BOOK;
  return {
    accountKey,
    userId: USER,
    pins: { read: () => pin, write: (value) => (pin = Math.max(pin, value)) },
    device: { read: () => copy, write: (book) => (copy = book) },
    now: () => 1_000_000,
    pin: () => pin,
    copy: () => copy,
    ...overrides
  };
}

/** The Worker's rules: compare-and-set on the revision, rising sequence. */
function memoryApi(): ShareLinkNamesApi & {
  stored: ShareLinkNamesSnapshot;
  saves: number;
} {
  const api = {
    stored: {
      revision: 0,
      sequence: 0,
      record: null
    } as ShareLinkNamesSnapshot,
    saves: 0,
    load: async () => ({ ...api.stored }),
    async save(expectedRevision: number, record: string) {
      const { sequence } = readSealedRecordHeader(
        SHARE_LINK_NAMES_RECORD,
        fromBase64Url(record)
      );
      if (
        expectedRevision !== api.stored.revision ||
        sequence <= api.stored.sequence
      )
        throw new ShareLinkNamesConflict({ ...api.stored });
      api.saves++;
      api.stored = { revision: expectedRevision + 1, sequence, record };
      return { ...api.stored };
    }
  };
  return api;
}

async function sealedBook(
  book: ShareLinkNameBook,
  sequence: number,
  key = KEY
): Promise<string> {
  return toBase64Url(
    await sealRecord(
      SHARE_LINK_NAMES_RECORD,
      key,
      USER,
      sequence,
      encodeShareLinkNameBook(book, 1_000_000)
    )
  );
}

const named = (name: string, stamp: number, shareId = 'shr_a') =>
  setShareLinkName(EMPTY_SHARE_LINK_NAME_BOOK, 'proj_x', shareId, name, stamp);

const padded = (i: number) => `shr_${String(i).padStart(40, '0')}`;

describe('share link name books', () => {
  it('merges entry by entry, the later stamp winning', () => {
    const a = setShareLinkName(named('Old', 10), 'proj_x', 'shr_b', 'B', 30);
    const b = setShareLinkName(named('New', 20), 'proj_y', 'shr_c', 'C', 5);
    const merged = mergeShareLinkNameBooks(a, b);
    expect(shareLinkNamesFor(merged, 'proj_x')).toEqual({
      shr_a: 'New',
      shr_b: 'B'
    });
    expect(shareLinkNamesFor(merged, 'proj_y')).toEqual({ shr_c: 'C' });
    expect(mergeShareLinkNameBooks(b, a)).toEqual(merged);
    expect(mergeShareLinkNameBooks(merged, merged)).toEqual(merged);
  });

  it('lets a tombstone win a tie and stop an older name coming back', () => {
    const cleared = setShareLinkName(named('X', 10), 'proj_x', 'shr_a', null, 0);
    // Stamped past the name it clears, even with a clock behind it.
    expect(cleared.projects.proj_x!.shr_a).toEqual({
      deleted: true,
      stamp: 11
    });
    expect(
      shareLinkNamesFor(
        mergeShareLinkNameBooks(named('X', 10), cleared),
        'proj_x'
      )
    ).toEqual({});
    const tie = setShareLinkName(
      EMPTY_SHARE_LINK_NAME_BOOK,
      'proj_x',
      'shr_a',
      null,
      10
    );
    expect(
      shareLinkNamesFor(mergeShareLinkNameBooks(named('X', 10), tie), 'proj_x')
    ).toEqual({});
    // Two names on a tie: the same one on every device.
    expect(mergeShareLinkNameBooks(named('A', 5), named('B', 5))).toEqual(
      mergeShareLinkNameBooks(named('B', 5), named('A', 5))
    );
  });

  it('normalizes names and refuses what a plaintext link name refuses', () => {
    expect(
      shareLinkNamesFor(named('  Client   review ', 1), 'proj_x').shr_a
    ).toBe('Client review');
    expect(() => named('Bad\u0007', 1)).toThrow(/control characters/);
    expect(() => named('x'.repeat(61), 1)).toThrow(/at most 60/);
    expect(shareLinkNamesFor(named('   ', 1), 'proj_x')).toEqual({});
  });

  it('drops malformed entries, not the whole book', () => {
    expect(
      parseShareLinkNameBook({
        version: 1,
        projects: {
          proj_x: {
            shr_a: { name: 'Fine', stamp: 3 },
            shr_b: { name: 'Bad\u0007', stamp: 3 },
            shr_c: { name: 'No stamp' },
            shr_d: { deleted: true, stamp: 4 },
            shr_e: 'nonsense'
          },
          proj_y: []
        }
      })
    ).toEqual({
      version: 1,
      projects: {
        proj_x: {
          shr_a: { name: 'Fine', stamp: 3 },
          shr_d: { deleted: true, stamp: 4 }
        }
      }
    });
    expect(parseShareLinkNameBook({ version: 2, projects: {} })).toBeNull();
    expect(parseShareLinkNameBook([])).toBeNull();
  });

  it('prunes names of links no longer listed, after a grace period', () => {
    const book = setShareLinkName(
      named('Gone', 0),
      'proj_x',
      'shr_new',
      'New',
      3 * DAY
    );
    const pruned = pruneUnlistedShareLinkNames(
      book,
      'proj_x',
      new Set(['shr_other']),
      3 * DAY + 1
    );
    // The fresh name of a link the list has not caught up with stays.
    expect(shareLinkNamesFor(pruned, 'proj_x')).toEqual({ shr_new: 'New' });
    expect(pruned.projects.proj_x!.shr_a).toMatchObject({ deleted: true });
    // Nothing to prune: the same book back.
    expect(
      pruneUnlistedShareLinkNames(
        book,
        'proj_x',
        new Set(['shr_a', 'shr_new']),
        0
      )
    ).toBe(book);
  });

  it('seals old tombstones away, and the oldest first when over the cap', () => {
    const old = setShareLinkName(named('X', 0), 'proj_x', 'shr_a', null, 1);
    const fresh = setShareLinkName(
      old,
      'proj_x',
      'shr_b',
      null,
      SHARE_LINK_NAME_TOMBSTONE_MS
    );
    const decode = (bytes: Uint8Array) =>
      parseShareLinkNameBook(JSON.parse(new TextDecoder().decode(bytes)));
    expect(
      decode(encodeShareLinkNameBook(fresh, SHARE_LINK_NAME_TOMBSTONE_MS + 10))
        ?.projects.proj_x
    ).toEqual({
      shr_b: { deleted: true, stamp: SHARE_LINK_NAME_TOMBSTONE_MS }
    });

    let big: ShareLinkNameBook = EMPTY_SHARE_LINK_NAME_BOOK;
    for (let i = 0; i < 2000; i++)
      big = setShareLinkName(big, 'proj_x', padded(i), null, 100 + i);
    big = setShareLinkName(big, 'proj_x', 'shr_live', 'Keep me', 50);
    const sealed = decode(encodeShareLinkNameBook(big, 5000))!;
    const entries = sealed.projects.proj_x!;
    expect(entries.shr_live).toEqual({ name: 'Keep me', stamp: 50 });
    expect(entries[padded(0)]).toBeUndefined();
    expect(entries[padded(1999)]).toBeDefined();

    let full: ShareLinkNameBook = EMPTY_SHARE_LINK_NAME_BOOK;
    for (let i = 0; i < 2000; i++)
      full = setShareLinkName(full, 'proj_x', padded(i), 'x'.repeat(60), 1);
    expect(() => encodeShareLinkNameBook(full, 1)).toThrow(
      /Too many named links/
    );
  });
});

describe('the sealed account record', () => {
  it('saves a change, and another device reads it', async () => {
    const api = memoryApi();
    const laptop = memoryKeys();
    await changeShareLinkNames(laptop, api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_a', 'Client review', now)
    );
    expect(api.stored).toMatchObject({ revision: 1, sequence: 1 });
    expect(laptop.pin()).toBe(1);
    // Nothing readable on the server.
    expect(
      new TextDecoder().decode(fromBase64Url(api.stored.record!))
    ).not.toContain('Client');

    const phone = memoryKeys();
    const book = await readShareLinkNames(phone, api);
    expect(shareLinkNamesFor(book, 'proj_x')).toEqual({
      shr_a: 'Client review'
    });
    expect(phone.copy()).toEqual(book);
    expect(phone.pin()).toBe(1);
  });

  it('merges a concurrent write from another device and seals past it', async () => {
    const api = memoryApi();
    const laptop = memoryKeys();
    const phone = memoryKeys();
    await changeShareLinkNames(phone, api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_b', 'Phone', now)
    );
    // The laptop read before the phone wrote.
    const load = vi
      .spyOn(api, 'load')
      .mockResolvedValueOnce({ revision: 0, sequence: 0, record: null });
    await changeShareLinkNames(laptop, api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_a', 'Laptop', now)
    );
    load.mockRestore();
    expect(api.stored).toMatchObject({ revision: 2, sequence: 2 });
    const book = await readShareLinkNames(memoryKeys(), api);
    expect(shareLinkNamesFor(book, 'proj_x')).toEqual({
      shr_a: 'Laptop',
      shr_b: 'Phone'
    });
  });

  it('refuses a record older than one this device opened, and replaces it', async () => {
    const api = memoryApi();
    const keys = memoryKeys();
    api.stored = {
      revision: 3,
      sequence: 2,
      record: await sealedBook(named('Rolled back', 1), 2)
    };
    keys.pins.write(5);
    keys.device.write(named('Mine', 9));
    expect(await openShareLinkNames(keys, api.stored.record!)).toEqual({
      kind: 'replace'
    });
    expect(
      shareLinkNamesFor(await readShareLinkNames(keys, api), 'proj_x')
    ).toEqual({ shr_a: 'Mine' });
    await changeShareLinkNames(keys, api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_b', 'Two', now)
    );
    // Sealed past both the pin and the stored sequence.
    expect(api.stored.sequence).toBe(6);
    expect(
      shareLinkNamesFor(await readShareLinkNames(memoryKeys(), api), 'proj_x')
    ).toEqual({ shr_a: 'Mine', shr_b: 'Two' });
  });

  it('opens a record sealed before an account-key rotation through the older key', async () => {
    const api = memoryApi();
    api.stored = {
      revision: 1,
      sequence: 4,
      record: await sealedBook(named('Before rotation', 1), 4, ROTATED)
    };
    const older = vi.fn(async () => ROTATED.slice());
    const keys = memoryKeys(KEY, { olderKey: older });
    expect(
      shareLinkNamesFor(await readShareLinkNames(keys, api), 'proj_x')
    ).toEqual({ shr_a: 'Before rotation' });
    expect(older).toHaveBeenCalledOnce();

    // Without the older key the record is replaced by this device's copy,
    // sealed under the current key.
    const without = memoryKeys();
    without.device.write(named('Mine', 9, 'shr_b'));
    await changeShareLinkNames(without, api, (book) => book);
    expect(api.stored.sequence).toBe(5);
    expect(
      shareLinkNamesFor(await readShareLinkNames(memoryKeys(), api), 'proj_x')
    ).toEqual({ shr_b: 'Mine' });
  });

  it('keeps the change on this device and never overwrites a record it cannot open', async () => {
    const api = memoryApi();
    const altered = fromBase64Url(await sealedBook(named('Theirs', 1), 3));
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    api.stored = { revision: 1, sequence: 3, record: toBase64Url(altered) };
    const keys = memoryKeys();
    keys.device.write(named('Mine', 2, 'shr_b'));
    expect(
      shareLinkNamesFor(await readShareLinkNames(keys, api), 'proj_x')
    ).toEqual({ shr_b: 'Mine' });
    await expect(
      changeShareLinkNames(keys, api, (book, now) =>
        setShareLinkName(book, 'proj_x', 'shr_c', 'New', now)
      )
    ).rejects.toBeInstanceOf(ShareLinkNamesKeptOnDevice);
    expect(api.saves).toBe(0);
    expect(shareLinkNamesFor(keys.copy(), 'proj_x')).toEqual({
      shr_b: 'Mine',
      shr_c: 'New'
    });
  });

  it('keeps this device’s copy when the account cannot be reached', async () => {
    const keys = memoryKeys();
    keys.device.write(named('Mine', 2));
    const api = memoryApi();
    api.load = async () => {
      throw new Error('offline');
    };
    expect(
      shareLinkNamesFor(await readShareLinkNames(keys, api), 'proj_x')
    ).toEqual({ shr_a: 'Mine' });
  });
});

describe('the device copy', () => {
  it('persists per account and is forgotten at sign-out', () => {
    localStorageShareLinkNameCopy('user_dev').write(named('Kept', 1));
    expect(
      shareLinkNamesFor(
        localStorageShareLinkNameCopy('user_dev').read(),
        'proj_x'
      )
    ).toEqual({ shr_a: 'Kept' });
    expect(localStorageShareLinkNameCopy('user_other').read()).toEqual(
      EMPTY_SHARE_LINK_NAME_BOOK
    );
    forgetShareLinkNames('user_dev');
    expect(localStorageShareLinkNameCopy('user_dev').read()).toEqual(
      EMPTY_SHARE_LINK_NAME_BOOK
    );
  });
});
