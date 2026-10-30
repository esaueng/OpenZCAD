import { describe, expect, it } from 'vitest';
import {
  createFolder,
  deleteFolder,
  moveProjectsToFolder,
  renameFolder,
  setFolderPinned,
  type LibraryFolders
} from './libraryFolders';
import {
  browserFolderSyncHost,
  syncLibraryFolders,
  type FolderSyncHost,
  type LibraryFolderSnapshot,
  type SaveLibraryFolderRequest
} from './libraryFolderCloudSync';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
/** Before every test clock: folders made before the device first synced. */
const CREATED = '2026-10-01T00:00:00.000Z';

/** The Worker's compare-and-set, in memory. */
function server() {
  let snapshot: LibraryFolderSnapshot = {
    revision: 0,
    format: null,
    record: null,
    updatedAt: null
  };
  let writes = 0;
  return {
    get snapshot() {
      return snapshot;
    },
    get writes() {
      return writes;
    },
    load: () => Promise.resolve(snapshot),
    save(request: SaveLibraryFolderRequest) {
      if (request.expectedRevision !== snapshot.revision) {
        return Promise.resolve({ conflict: snapshot });
      }
      writes += 1;
      snapshot = {
        revision: snapshot.revision + 1,
        format: request.format,
        record: request.record,
        updatedAt: new Date(T0).toISOString()
      };
      return Promise.resolve({ saved: snapshot });
    },
    seal(record: string) {
      snapshot = {
        revision: snapshot.revision + 1,
        format: 2,
        record,
        updatedAt: null
      };
    }
  };
}

/** One browser: its shelf, its sync record and a clock. */
function device(
  remote: ReturnType<typeof server>,
  initial: LibraryFolders = { folders: [] }
) {
  let shelf = initial;
  let record: ReturnType<FolderSyncHost['readRecord']> = null;
  let clock = T0;
  let duringLoad: (() => void) | null = null;
  const host: FolderSyncHost = {
    readDevice: () => shelf,
    writeDevice: (state) => {
      shelf = state;
    },
    readRecord: () => record,
    writeRecord: (next) => {
      record = next;
    },
    load: async () => {
      const snapshot = await remote.load();
      duringLoad?.();
      duringLoad = null;
      return snapshot;
    },
    save: (request) => remote.save(request),
    now: () => clock
  };
  return {
    edit(change: (state: LibraryFolders) => LibraryFolders) {
      clock += 1000;
      shelf = change(shelf);
    },
    editWhileLoading(change: (state: LibraryFolders) => LibraryFolders) {
      duringLoad = () => this.edit(change);
    },
    sync: () => syncLibraryFolders(host),
    get shelf() {
      return shelf;
    },
    get record() {
      return record;
    }
  };
}

const names = (state: LibraryFolders) =>
  state.folders.map((folder) => [folder.name, folder.projectIds]);

describe('syncLibraryFolders', () => {
  // Regression: folders lived only in each browser's storage, so a folder
  // made in one browser never appeared in another on the same account.
  it('shows a folder made on one device on another', async () => {
    const remote = server();
    const firefox = device(remote);
    const chrome = device(remote);
    firefox.edit((state) =>
      createFolder(state, {
        id: 'f-test',
        name: 'Test folder',
        projectIds: ['p1', 'p2'],
        now: CREATED
      })
    );

    expect(await firefox.sync()).toBe('synced');
    expect(await chrome.sync()).toBe('synced');

    expect(names(chrome.shelf)).toEqual([['Test folder', ['p1', 'p2']]]);
    expect(remote.snapshot.revision).toBe(1);
  });

  it('merges folders both devices already had when they first sync', async () => {
    const remote = server();
    const firefox = device(
      remote,
      createFolder(
        { folders: [] },
        {
          id: 'f-a',
          name: 'Test folder',
          projectIds: ['p1'],
          now: '2026-10-01T00:00:00.000Z'
        }
      )
    );
    const chrome = device(
      remote,
      createFolder(
        { folders: [] },
        {
          id: 'f-b',
          name: 'Gear thing',
          projectIds: ['p2'],
          now: '2026-10-02T00:00:00.000Z'
        }
      )
    );
    await firefox.sync();
    await chrome.sync();
    await firefox.sync();

    expect(names(firefox.shelf)).toEqual(names(chrome.shelf));
    expect(names(firefox.shelf)).toEqual([
      ['Test folder', ['p1']],
      ['Gear thing', ['p2']]
    ]);
  });

  it('carries renames, pins, moves and deletions both ways', async () => {
    const remote = server();
    const firefox = device(remote);
    const chrome = device(remote);
    firefox.edit((state) =>
      createFolder(
        createFolder(state, {
          id: 'f-a',
          name: 'Brackets',
          projectIds: ['p1'],
          now: CREATED
        }),
        { id: 'f-b', name: 'Gears', projectIds: ['p2'], now: CREATED }
      )
    );
    await firefox.sync();
    await chrome.sync();

    chrome.edit((state) => renameFolder(state, 'f-a', 'Mounts'));
    firefox.edit((state) => setFolderPinned(state, 'f-a', true));
    firefox.edit((state) => moveProjectsToFolder(state, ['p2'], 'f-a'));
    chrome.edit((state) => deleteFolder(state, 'f-b'));
    await chrome.sync();
    await firefox.sync();
    await chrome.sync();

    expect(firefox.shelf).toEqual(chrome.shelf);
    expect(
      firefox.shelf.folders.map((f) => [f.id, f.name, f.pinned, f.projectIds])
    ).toEqual([['f-a', 'Mounts', true, ['p1', 'p2']]]);
  });

  it('retries a write another device beat, merging its work', async () => {
    const remote = server();
    const firefox = device(remote);
    const chrome = device(remote);
    await firefox.sync();
    await chrome.sync();
    firefox.edit((state) =>
      createFolder(state, {
        id: 'f-a',
        name: 'A',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    chrome.edit((state) =>
      createFolder(state, {
        id: 'f-b',
        name: 'B',
        projectIds: ['p2'],
        now: CREATED
      })
    );
    // Firefox reads, then Chrome writes before Firefox does.
    firefox.editWhileLoading((state) => state);
    const racing = firefox.sync();
    await chrome.sync();
    expect(await racing).toBe('synced');
    await chrome.sync();
    await firefox.sync();

    expect(names(chrome.shelf)).toEqual(names(firefox.shelf));
    expect(
      names(chrome.shelf)
        .map(([name]) => name)
        .sort()
    ).toEqual(['A', 'B']);
  });

  it('keeps a shelf edit made while the account answered', async () => {
    const remote = server();
    const firefox = device(remote);
    const chrome = device(remote);
    chrome.edit((state) =>
      createFolder(state, {
        id: 'f-a',
        name: 'A',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    await chrome.sync();
    firefox.editWhileLoading((state) =>
      createFolder(state, {
        id: 'f-b',
        name: 'Local',
        projectIds: ['p2'],
        now: CREATED
      })
    );
    await firefox.sync();

    expect(
      names(firefox.shelf)
        .map(([name]) => name)
        .sort()
    ).toEqual(['A', 'Local']);
    await firefox.sync();
    await chrome.sync();
    expect(
      names(chrome.shelf)
        .map(([name]) => name)
        .sort()
    ).toEqual(['A', 'Local']);
  });

  it('writes nothing when nothing changed, or when there is nothing to store', async () => {
    const remote = server();
    const firefox = device(remote);
    await firefox.sync();
    expect(remote.writes).toBe(0);
    firefox.edit((state) =>
      createFolder(state, { id: 'f-a', name: 'A', now: CREATED })
    );
    await firefox.sync();
    await firefox.sync();
    expect(remote.writes).toBe(1);
  });

  it('never overwrites an account copy it cannot read', async () => {
    const remote = server();
    remote.seal('c2VhbGVk');
    const firefox = device(remote);
    firefox.edit((state) =>
      createFolder(state, {
        id: 'f-a',
        name: 'A',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    expect(await firefox.sync()).toBe('unsupported');
    expect(remote.snapshot).toMatchObject({ format: 2, record: 'c2VhbGVk' });
    expect(names(firefox.shelf)).toEqual([['A', ['p1']]]);
  });
});

describe('browserFolderSyncHost', () => {
  it('turns a revision conflict into the current copy and rethrows the rest', async () => {
    const current: LibraryFolderSnapshot = {
      revision: 4,
      format: 1,
      record: '{"version":2,"folders":{},"members":{}}',
      updatedAt: null
    };
    const refusal = (code: string, details?: Record<string, unknown>) =>
      Object.assign(new Error(code), { code, details });
    let next: Error = refusal('LIBRARY_FOLDERS_REVISION_CONFLICT', {
      current
    });
    const host = browserFolderSyncHost('account', {
      getLibraryFolders: () => Promise.resolve(current),
      saveLibraryFolders: () => Promise.reject(next)
    });
    const request = { expectedRevision: 1, format: 1 as const, record: '{}' };
    expect(await host.save(request)).toEqual({ conflict: current });
    next = refusal('LIBRARY_FOLDERS_DISABLED');
    await expect(host.save(request)).rejects.toMatchObject({
      code: 'LIBRARY_FOLDERS_DISABLED'
    });
  });
});
