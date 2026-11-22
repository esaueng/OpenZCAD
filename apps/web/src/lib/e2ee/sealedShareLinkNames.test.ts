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
  nameReissuedShareLinks,
  readShareLinkNames,
  setShareLinkName,
  SHARE_LINK_NAME_TOMBSTONE_MS,
  ShareLinkNamesConflict,
  ShareLinkNamesKeptOnDevice,
  ShareLinkNamesSessionEnded,
  shareLinkNamesFor,
  type ShareLinkNameBook,
  type ShareLinkNameKeys,
  type ShareLinkNamesApi,
  type ShareLinkNamesSnapshot
} from './sealedShareLinkNames';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const ROTATED = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const USER = 'user_alice';

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

/** Link shr_a reissued as shr_new. */
const reissue = [{ sourceId: 'shr_a', shareId: 'shr_new' }];

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
    const cleared = setShareLinkName(
      named('X', 10),
      'proj_x',
      'shr_a',
      null,
      0
    );
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

  it('names a reissued link after its source, once, and clears the source', () => {
    const book = named('Client review', 5);
    const named2 = nameReissuedShareLinks(book, 'proj_x', reissue, 10);
    expect(shareLinkNamesFor(named2, 'proj_x')).toEqual({
      shr_new: 'Client review'
    });
    // A rename's fresh stamp, not the source's.
    expect(named2.projects.proj_x!.shr_new).toEqual({
      name: 'Client review',
      stamp: 10
    });
    expect(named2.projects.proj_x!.shr_a).toMatchObject({ deleted: true });
    // Again: nothing changes.
    expect(nameReissuedShareLinks(named2, 'proj_x', reissue, 20)).toBe(named2);
  });

  it('lets a later edit of the new link, on any device, win over the carried name', () => {
    const carried = nameReissuedShareLinks(
      named('Old', 5),
      'proj_x',
      reissue,
      10
    );
    // Another device edits the new link after it appeared.
    for (const later of [
      setShareLinkName(carried, 'proj_x', 'shr_new', null, 12),
      setShareLinkName(carried, 'proj_x', 'shr_new', 'New', 12)
    ]) {
      const want = shareLinkNamesFor(later, 'proj_x').shr_new;
      expect(
        shareLinkNamesFor(mergeShareLinkNameBooks(carried, later), 'proj_x')
          .shr_new
      ).toBe(want);
      expect(
        shareLinkNamesFor(mergeShareLinkNameBooks(later, carried), 'proj_x')
          .shr_new
      ).toBe(want);
    }
  });

  it('carries the rest of a reissue that stopped halfway when it is retried', () => {
    const book = setShareLinkName(
      named('First', 1),
      'proj_x',
      'shr_b',
      'Second',
      2
    );
    const partial = nameReissuedShareLinks(book, 'proj_x', reissue, 10);
    // The unreplaced source keeps its name for the retry.
    expect(shareLinkNamesFor(partial, 'proj_x')).toEqual({
      shr_b: 'Second',
      shr_new: 'First'
    });
    const retried = nameReissuedShareLinks(
      partial,
      'proj_x',
      [...reissue, { sourceId: 'shr_b', shareId: 'shr_new_b' }],
      20
    );
    expect(shareLinkNamesFor(retried, 'proj_x')).toEqual({
      shr_new: 'First',
      shr_new_b: 'Second'
    });
  });

  it('keeps a new link’s own entry, and carries nothing from a source without a name', () => {
    const renamed = setShareLinkName(
      named('Old', 1),
      'proj_x',
      'shr_new',
      'Mine',
      2
    );
    const kept = nameReissuedShareLinks(renamed, 'proj_x', reissue, 3);
    expect(shareLinkNamesFor(kept, 'proj_x')).toEqual({ shr_new: 'Mine' });
    const sourceCleared = setShareLinkName(
      named('Old', 1),
      'proj_x',
      'shr_a',
      null,
      2
    );
    expect(
      nameReissuedShareLinks(
        sourceCleared,
        'proj_x',
        [...reissue, { sourceId: 'shr_unnamed', shareId: 'shr_other' }],
        3
      )
    ).toBe(sourceCleared);
  });

  it('seals old tombstones away and refuses, rather than drop a recent one, when over the cap', () => {
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

    // PR 1921 review: over the cap with recent tombstones, the save is
    // refused; dropping one would let a device that missed the clear bring
    // the name back.
    let big: ShareLinkNameBook = EMPTY_SHARE_LINK_NAME_BOOK;
    for (let i = 0; i < 4000; i++)
      big = setShareLinkName(big, 'proj_x', padded(i), null, 100 + i);
    expect(() => encodeShareLinkNameBook(big, 5000)).toThrow(
      /Too many link names/
    );
    // The same tombstones once past their age are sealed away.
    expect(
      decode(encodeShareLinkNameBook(big, SHARE_LINK_NAME_TOMBSTONE_MS + 5000))
        ?.projects
    ).toEqual({});

    let full: ShareLinkNameBook = EMPTY_SHARE_LINK_NAME_BOOK;
    for (let i = 0; i < 2000; i++)
      full = setShareLinkName(full, 'proj_x', padded(i), 'x'.repeat(60), 1);
    expect(() => encodeShareLinkNameBook(full, 1)).toThrow(
      /Too many link names/
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

    // PR 1921 review: without the key (history failed to load, or a newer
    // key this device has not caught up with) the record is left alone.
    for (const olderKey of [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('history unavailable');
      })
    ]) {
      const without = memoryKeys(KEY, { olderKey });
      without.device.write(named('Mine', 9, 'shr_b'));
      await expect(
        changeShareLinkNames(without, api, (book) => book)
      ).rejects.toBeInstanceOf(ShareLinkNamesKeptOnDevice);
    }
    expect(api.stored.sequence).toBe(4);
    expect(
      shareLinkNamesFor(
        await readShareLinkNames(memoryKeys(KEY, { olderKey: older }), api),
        'proj_x'
      )
    ).toEqual({ shr_a: 'Before rotation' });
  });

  it('names reissued links from the account’s latest source name, and saves it', async () => {
    const api = memoryApi();
    const phone = memoryKeys();
    await changeShareLinkNames(phone, api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_a', 'Client review', now)
    );
    // The laptop's own copy is behind: it still says "Old".
    const laptop = memoryKeys();
    laptop.device.write(named('Old', 1));
    await changeShareLinkNames(laptop, api, (book, now) =>
      nameReissuedShareLinks(book, 'proj_x', reissue, now + 5)
    );
    const synced = await readShareLinkNames(memoryKeys(), api);
    expect(shareLinkNamesFor(synced, 'proj_x')).toEqual({
      shr_new: 'Client review'
    });
  });

  it('neither saves nor keeps a change whose session ended while it waited', async () => {
    const api = memoryApi();
    let live = true;
    const keys = memoryKeys(KEY.slice(), { active: () => live });
    const load = api.load;
    api.load = async () => {
      const snapshot = await load();
      // Signed out while the record was being fetched.
      live = false;
      keys.accountKey.fill(0);
      return snapshot;
    };
    await expect(
      changeShareLinkNames(keys, api, (book, now) =>
        setShareLinkName(book, 'proj_x', 'shr_a', 'After sign-out', now)
      )
    ).rejects.toBeInstanceOf(ShareLinkNamesSessionEnded);
    expect(api.saves).toBe(0);
    expect(keys.copy()).toEqual(EMPTY_SHARE_LINK_NAME_BOOK);
  });

  it('seals with the live key when a second unlock of the same key replaced the buffer', async () => {
    const api = memoryApi();
    const first = KEY.slice();
    const second = KEY.slice();
    let current = first;
    const keys = memoryKeys(first, {
      active: () => true,
      liveKey: () => current
    });
    const load = api.load;
    api.load = async () => {
      const snapshot = await load();
      // Another load unlocked the same key into a new buffer and zeroed the
      // one this change captured: still the same session.
      current = second;
      first.fill(0);
      return snapshot;
    };
    await changeShareLinkNames(keys, api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_a', 'Still here', now)
    );
    expect(api.saves).toBe(1);
    expect(
      shareLinkNamesFor(await readShareLinkNames(memoryKeys(), api), 'proj_x')
    ).toEqual({ shr_a: 'Still here' });
  });

  it('never seals with a zeroed account key', async () => {
    const api = memoryApi();
    const keys = memoryKeys(new Uint8Array(32));
    await expect(
      changeShareLinkNames(keys, api, (book, now) =>
        setShareLinkName(book, 'proj_x', 'shr_a', 'Zero', now)
      )
    ).rejects.toBeInstanceOf(ShareLinkNamesSessionEnded);
    expect(api.saves).toBe(0);
  });

  it('does not write the device copy back for a read whose session ended', async () => {
    const api = memoryApi();
    await changeShareLinkNames(memoryKeys(), api, (book, now) =>
      setShareLinkName(book, 'proj_x', 'shr_a', 'Synced', now)
    );
    let live = true;
    const keys = memoryKeys(KEY, { active: () => live });
    const load = api.load;
    api.load = async () => {
      const snapshot = await load();
      live = false;
      return snapshot;
    };
    await expect(readShareLinkNames(keys, api)).rejects.toBeInstanceOf(
      ShareLinkNamesSessionEnded
    );
    expect(keys.copy()).toEqual(EMPTY_SHARE_LINK_NAME_BOOK);
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
