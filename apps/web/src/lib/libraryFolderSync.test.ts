import { describe, expect, it } from 'vitest';
import {
  createFolder,
  deleteFolder,
  moveProjectsToFolder,
  renameFolder,
  reorderFolders,
  setFolderPinned,
  type LibraryFolders
} from './libraryFolders';
import {
  deviceFoldersFromSet,
  EMPTY_FOLDER_SET,
  FOLDER_TOMBSTONE_MS,
  folderSetFromDevice,
  mergeFolderSets,
  nextFolderStamp,
  parseFolderSet,
  pruneFolderSet,
  recordFolderChanges,
  type FolderSet
} from './libraryFolderSync';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const empty: LibraryFolders = { folders: [] };

/** A device that edits through the shelf's own operations. */
function device(set: FolderSet = EMPTY_FOLDER_SET) {
  let synced = set;
  let shown = deviceFoldersFromSet(set);
  return {
    edit(change: (state: LibraryFolders) => LibraryFolders, now: number) {
      const next = change(shown);
      synced = recordFolderChanges(synced, shown, next, now);
      shown = next;
    },
    receive(remote: FolderSet) {
      synced = mergeFolderSets(synced, remote);
      shown = deviceFoldersFromSet(synced);
    },
    get set() {
      return synced;
    },
    get shown() {
      return shown;
    }
  };
}

function seeded() {
  const state = createFolder(
    createFolder(empty, {
      id: 'f-a',
      name: 'Brackets',
      projectIds: ['p1', 'p2'],
      now: '2026-09-01T00:00:00.000Z'
    }),
    {
      id: 'f-b',
      name: 'Gears',
      projectIds: ['p3'],
      pinned: true,
      now: '2026-09-02T00:00:00.000Z'
    }
  );
  return folderSetFromDevice(state);
}

describe('folderSetFromDevice / deviceFoldersFromSet', () => {
  it('round-trips the device shape, order, pins and cover', () => {
    let state = createFolder(empty, {
      id: 'f-a',
      name: 'Brackets',
      projectIds: ['p2', 'p1'],
      now: '2026-09-01T00:00:00.000Z'
    });
    state = createFolder(state, {
      id: 'f-b',
      name: 'Gears',
      projectIds: ['p3'],
      pinned: true,
      now: '2026-09-02T00:00:00.000Z'
    });
    state = {
      folders: [
        { ...state.folders[0]!, coverProjectId: 'p1' },
        state.folders[1]!
      ]
    };
    state = reorderFolders(state, ['f-b', 'f-a']);

    expect(deviceFoldersFromSet(folderSetFromDevice(state))).toEqual(state);
  });

  it('stamps converted entries with the folder creation time, not now', () => {
    const set = seeded();
    expect(set.folders['f-a']!.stamps.name).toBe(
      Date.parse('2026-09-01T00:00:00.000Z')
    );
    expect(set.members.p3!.stamp).toBe(Date.parse('2026-09-02T00:00:00.000Z'));
  });
});

describe('recordFolderChanges', () => {
  it('stamps only what the edit touched', () => {
    const base = seeded();
    const before = deviceFoldersFromSet(base);
    const after = renameFolder(before, 'f-b', 'Spur gears');
    const next = recordFolderChanges(base, before, after, T0);

    const seededStamp = base.folders['f-b']!.stamps.pinned;
    expect(next.folders['f-b']).toMatchObject({
      name: 'Spur gears',
      stamps: {
        name: T0,
        pinned: seededStamp,
        cover: seededStamp,
        order: seededStamp
      }
    });
    expect(next.folders['f-a']).toBe(base.folders['f-a']);
    expect(next.members).toEqual(base.members);
  });

  it('records a deletion as a tombstone and clears its members', () => {
    const base = seeded();
    const before = deviceFoldersFromSet(base);
    const next = recordFolderChanges(
      base,
      before,
      deleteFolder(before, 'f-a'),
      T0
    );

    expect(next.folders['f-a']!.deletedAt).toBe(T0);
    expect(next.members.p1).toEqual({ folderId: null, order: 0, stamp: T0 });
    expect(deviceFoldersFromSet(next).folders.map((f) => f.id)).toEqual([
      'f-b'
    ]);
  });

  it('stamps after everything already seen when this clock is behind', () => {
    const ahead = recordFolderChanges(
      seeded(),
      deviceFoldersFromSet(seeded()),
      renameFolder(deviceFoldersFromSet(seeded()), 'f-a', 'Later'),
      T0 + 60_000
    );
    expect(nextFolderStamp(ahead, T0)).toBe(T0 + 60_001);
  });
});

describe('mergeFolderSets', () => {
  it('keeps edits two devices made to the same folder and its parts', () => {
    const laptop = device(seeded());
    const phone = device(seeded());
    laptop.edit((state) => renameFolder(state, 'f-a', 'Mounts'), T0);
    phone.edit((state) => setFolderPinned(state, 'f-a', true), T0 + 1);
    phone.edit((state) => moveProjectsToFolder(state, ['p3'], 'f-a'), T0 + 2);

    laptop.receive(phone.set);
    phone.receive(laptop.set);

    expect(laptop.shown).toEqual(phone.shown);
    // The laptop's rename and the phone's pin touch different fields, so
    // both survive.
    expect(
      laptop.shown.folders.map((f) => [f.id, f.name, f.pinned, f.projectIds])
    ).toEqual([
      ['f-a', 'Mounts', true, ['p1', 'p2', 'p3']],
      ['f-b', 'Gears', true, []]
    ]);
  });

  it('keeps two same-named folders made on different devices apart', () => {
    const laptop = device();
    const phone = device();
    laptop.edit(
      (state) =>
        createFolder(state, {
          id: 'f-laptop',
          name: 'Jigs',
          projectIds: ['p1']
        }),
      T0
    );
    phone.edit(
      (state) =>
        createFolder(state, {
          id: 'f-phone',
          name: 'Jigs',
          projectIds: ['p2']
        }),
      T0
    );

    laptop.receive(phone.set);
    expect(
      laptop.shown.folders.map((f) => [f.id, f.name, f.projectIds])
    ).toEqual([
      ['f-laptop', 'Jigs', ['p1']],
      ['f-phone', 'Jigs', ['p2']]
    ]);
  });

  it('never leaves a part in two folders', () => {
    const laptop = device(seeded());
    const phone = device(seeded());
    laptop.edit((state) => moveProjectsToFolder(state, ['p1'], 'f-b'), T0);
    phone.edit((state) => moveProjectsToFolder(state, ['p1'], null), T0 + 5);

    laptop.receive(phone.set);
    const holders = laptop.shown.folders.filter((f) =>
      f.projectIds.includes('p1')
    );
    expect(holders).toEqual([]);
  });

  it('lets a deletion beat older edits and lose to newer ones', () => {
    const laptop = device(seeded());
    const phone = device(seeded());
    phone.edit((state) => renameFolder(state, 'f-a', 'Old idea'), T0);
    laptop.edit((state) => deleteFolder(state, 'f-a'), T0 + 10);
    laptop.receive(phone.set);
    expect(laptop.shown.folders.map((f) => f.id)).toEqual(['f-b']);

    const late = device(seeded());
    late.edit((state) => renameFolder(state, 'f-a', 'Kept'), T0 + 20);
    late.receive(laptop.set);
    expect(late.shown.folders.map((f) => f.name)).toContain('Kept');
  });

  it('syncs folder order and pins', () => {
    const laptop = device(seeded());
    const phone = device(seeded());
    laptop.edit((state) => reorderFolders(state, ['f-b', 'f-a']), T0);
    laptop.edit((state) => setFolderPinned(state, 'f-b', false), T0 + 1);

    phone.receive(laptop.set);
    expect(phone.shown.folders.map((f) => [f.id, f.pinned])).toEqual([
      ['f-b', false],
      ['f-a', false]
    ]);
  });

  it('is commutative, associative and idempotent', () => {
    const a = device(seeded());
    const b = device(seeded());
    const c = device(seeded());
    a.edit((state) => renameFolder(state, 'f-a', 'A'), T0);
    b.edit((state) => renameFolder(state, 'f-a', 'B'), T0);
    c.edit((state) => moveProjectsToFolder(state, ['p2'], 'f-b'), T0);

    expect(mergeFolderSets(a.set, b.set)).toEqual(
      mergeFolderSets(b.set, a.set)
    );
    expect(mergeFolderSets(mergeFolderSets(a.set, b.set), c.set)).toEqual(
      mergeFolderSets(a.set, mergeFolderSets(b.set, c.set))
    );
    expect(mergeFolderSets(a.set, a.set)).toEqual(a.set);
  });
});

describe('pruneFolderSet', () => {
  it('forgets deletions after the window and keeps recent ones', () => {
    const laptop = device(seeded());
    laptop.edit((state) => deleteFolder(state, 'f-a'), T0);

    const recent = pruneFolderSet(laptop.set, T0 + FOLDER_TOMBSTONE_MS);
    expect(recent.folders['f-a']?.deletedAt).toBe(T0);
    expect(recent.members.p1).toBeDefined();

    const later = pruneFolderSet(laptop.set, T0 + FOLDER_TOMBSTONE_MS + 1);
    expect(later.folders['f-a']).toBeUndefined();
    expect(later.members.p1).toBeUndefined();
    expect(later.folders['f-b']).toBeDefined();
    expect(later.members.p3).toBeDefined();
  });
});

describe('parseFolderSet', () => {
  it('reads what it wrote', () => {
    const set = seeded();
    expect(parseFolderSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
  });

  it('drops malformed entries and refuses other versions', () => {
    expect(parseFolderSet({ version: 1, folders: {}, members: {} })).toBeNull();
    expect(parseFolderSet(null)).toBeNull();
    const parsed = parseFolderSet({
      version: 2,
      folders: {
        good: {
          stamps: { name: 1, pinned: 1, cover: 1, order: 1 },
          name: '  Tools  ',
          pinned: true,
          order: 0,
          createdAt: 'x'
        },
        bad: { name: 'No stamp', order: 0, createdAt: 'x' },
        '': { name: 'No id', order: 0, createdAt: 'x', stamp: 1 }
      },
      members: {
        p1: { folderId: 'good', order: 0, stamp: 1 },
        p2: { folderId: 5, order: 0, stamp: 1 },
        p3: { folderId: null, order: 0, stamp: Number.NaN }
      }
    });
    expect(Object.keys(parsed!.folders)).toEqual(['good']);
    expect(parsed!.folders.good!.name).toBe('Tools');
    expect(Object.keys(parsed!.members)).toEqual(['p1']);
  });
});

describe('convergence', () => {
  // Deterministic: a fixed-seed generator, so a failure replays exactly.
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it('reaches one shelf from random edits merged in any order', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      const pick = <T>(list: readonly T[]) =>
        list[Math.floor(next() * list.length)]!;
      const devices = [device(seeded()), device(seeded()), device(seeded())];
      const parts = ['p1', 'p2', 'p3', 'p4', 'p5'];
      let clock = T0;
      for (let step = 0; step < 30; step += 1) {
        const actor = pick(devices);
        const ids = actor.shown.folders.map((folder) => folder.id);
        clock += Math.floor(next() * 3); // Equal stamps happen on purpose.
        const action = Math.floor(next() * 7);
        actor.edit((state) => {
          switch (action) {
            case 0:
              return createFolder(state, {
                id: `f-${seed}-${step}`,
                name: pick(['Jigs', 'Mounts', 'Gears']),
                projectIds: [pick(parts)]
              });
            case 1:
              return ids.length
                ? renameFolder(state, pick(ids), `N${step}`)
                : state;
            case 2:
              return ids.length
                ? setFolderPinned(state, pick(ids), next() < 0.5)
                : state;
            case 3:
              return ids.length ? deleteFolder(state, pick(ids)) : state;
            case 4:
              return ids.length
                ? reorderFolders(
                    state,
                    [...ids].sort(() => next() - 0.5)
                  )
                : state;
            case 5:
              return moveProjectsToFolder(
                state,
                [pick(parts)],
                ids.length && next() < 0.8 ? pick(ids) : null
              );
            default:
              return state;
          }
        }, clock);
        if (next() < 0.3) pick(devices).receive(actor.set);
      }
      for (const from of devices)
        for (const to of devices) to.receive(from.set);

      const [first, ...rest] = devices;
      for (const other of rest) expect(other.shown).toEqual(first!.shown);
      const filed = first!.shown.folders.flatMap((folder) => folder.projectIds);
      expect(new Set(filed).size).toBe(filed.length);
    }
  });
});
