import { describe, expect, it } from 'vitest';
import { fromBase64Url, readLibraryFoldersHeader } from '@openzcad/crypto';
import {
  createFolder,
  renameFolder,
  type LibraryFolders
} from '../libraryFolders';
import {
  canonicalFolderJson,
  syncLibraryFolders,
  type FolderRecordCodec,
  type FolderSyncHost,
  type LibraryFolderSnapshot,
  type SaveLibraryFolderRequest
} from '../libraryFolderCloudSync';
import { folderSetFromDevice } from '../libraryFolderSync';
import { sealedFolderCodec } from './sealedLibraryFolders';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const CREATED = '2026-10-01T00:00:00.000Z';
const USER = 'user_owner';
const ACCOUNT_KEY = new Uint8Array(32).map((_, index) => index);
const ROTATED_KEY = new Uint8Array(32).map((_, index) => 0x80 + index);

function server() {
  let snapshot: LibraryFolderSnapshot = {
    revision: 0,
    format: null,
    record: null,
    updatedAt: null
  };
  const history: LibraryFolderSnapshot[] = [];
  return {
    get snapshot() {
      return snapshot;
    },
    history,
    load: () => Promise.resolve(snapshot),
    save(request: SaveLibraryFolderRequest) {
      if (request.expectedRevision !== snapshot.revision)
        return Promise.resolve({ conflict: snapshot });
      snapshot = {
        revision: snapshot.revision + 1,
        format: request.format,
        record: request.record,
        updatedAt: null
      };
      history.push(snapshot);
      return Promise.resolve({ saved: snapshot });
    },
    /** A hostile server serving an older record at a new revision. */
    replay(old: LibraryFolderSnapshot) {
      snapshot = { ...old, revision: snapshot.revision + 1 };
    },
    put(format: 1 | 2, record: string) {
      snapshot = {
        revision: snapshot.revision + 1,
        format,
        record,
        updatedAt: null
      };
    }
  };
}

function memoryPins() {
  let value = 0;
  return {
    read: () => value,
    write: (next: number) => {
      value = next;
    }
  };
}

function device(
  remote: ReturnType<typeof server>,
  accountKey = ACCOUNT_KEY,
  initial: LibraryFolders = { folders: [] }
) {
  let shelf = initial;
  let record: ReturnType<FolderSyncHost['readRecord']> = null;
  let clock = T0;
  const pins = memoryPins();
  let codec: FolderRecordCodec = sealedFolderCodec({
    accountKey,
    userId: USER,
    pins
  });
  const host: FolderSyncHost = {
    readDevice: () => shelf,
    writeDevice: (state) => {
      shelf = state;
    },
    readRecord: () => record,
    writeRecord: (next) => {
      record = next;
    },
    load: () => remote.load(),
    save: (request) => remote.save(request),
    codec: () => Promise.resolve(codec),
    now: () => clock
  };
  return {
    edit(change: (state: LibraryFolders) => LibraryFolders) {
      clock += 1000;
      shelf = change(shelf);
    },
    rotate(key: Uint8Array) {
      codec = sealedFolderCodec({ accountKey: key, userId: USER, pins });
    },
    sync: () => syncLibraryFolders(host),
    pins,
    get shelf() {
      return shelf;
    }
  };
}

const names = (state: LibraryFolders) =>
  state.folders.map((folder) => folder.name).sort();

describe('sealed library folders', () => {
  it('syncs between devices and never stores a folder name in plaintext', async () => {
    const remote = server();
    const laptop = device(remote);
    const phone = device(remote);
    laptop.edit((state) =>
      createFolder(state, {
        id: 'f-secret',
        name: 'Prototype gearbox',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    await laptop.sync();
    await phone.sync();

    expect(names(phone.shelf)).toEqual(['Prototype gearbox']);
    expect(remote.snapshot.format).toBe(2);
    for (const stored of remote.history) {
      expect(stored.record).not.toContain('Prototype');
      expect(
        atob(stored.record!.replace(/-/g, '+').replace(/_/g, '/'))
      ).not.toContain('Prototype');
    }
    expect(
      readLibraryFoldersHeader(fromBase64Url(remote.snapshot.record!)).sequence
    ).toBe(1);
  });

  it('reseals plaintext folders written before the account encrypted', async () => {
    const remote = server();
    const legacy = folderSetFromDevice(
      createFolder(
        { folders: [] },
        { id: 'f-old', name: 'Old', projectIds: ['p1'], now: CREATED }
      )
    );
    remote.put(1, canonicalFolderJson(legacy));
    const laptop = device(remote);
    await laptop.sync();

    expect(names(laptop.shelf)).toEqual(['Old']);
    expect(remote.snapshot.format).toBe(2);
    expect(remote.snapshot.record).not.toContain('Old');
  });

  it('refuses a rolled-back copy and rewrites its own newer folders', async () => {
    const remote = server();
    const laptop = device(remote);
    laptop.edit((state) =>
      createFolder(state, {
        id: 'f-a',
        name: 'Jigs',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    await laptop.sync();
    const first = remote.snapshot;
    laptop.edit((state) => renameFolder(state, 'f-a', 'Fixtures'));
    await laptop.sync();
    expect(laptop.pins.read()).toBe(2);

    remote.replay(first);
    expect(await laptop.sync()).toBe('synced');
    expect(names(laptop.shelf)).toEqual(['Fixtures']);
    const header = readLibraryFoldersHeader(
      fromBase64Url(remote.snapshot.record!)
    );
    expect(header.sequence).toBe(3);
  });

  it('replaces a copy sealed under a rotated-out account key', async () => {
    const remote = server();
    const removed = device(remote);
    removed.edit((state) =>
      createFolder(state, {
        id: 'f-a',
        name: 'Before',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    await removed.sync();

    // After a device removal the account key rotates; this device holds the
    // new key and its own folders.
    const laptop = device(remote, ROTATED_KEY);
    laptop.edit((state) =>
      createFolder(state, {
        id: 'f-b',
        name: 'After',
        projectIds: ['p2'],
        now: CREATED
      })
    );
    expect(await laptop.sync()).toBe('synced');
    expect(names(laptop.shelf)).toEqual(['After']);
    const phone = device(remote, ROTATED_KEY);
    await phone.sync();
    expect(names(phone.shelf)).toEqual(['After']);
  });

  it('leaves alone a copy that fails authentication', async () => {
    const remote = server();
    const laptop = device(remote);
    laptop.edit((state) =>
      createFolder(state, {
        id: 'f-a',
        name: 'A',
        projectIds: ['p1'],
        now: CREATED
      })
    );
    await laptop.sync();
    const sealed = fromBase64Url(remote.snapshot.record!);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    remote.put(
      2,
      btoa(String.fromCharCode(...sealed))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    );
    const tampered = remote.snapshot;

    const phone = device(remote);
    expect(await phone.sync()).toBe('unsupported');
    expect(remote.snapshot).toBe(tampered);
  });

  it('waits while the account keys are locked', async () => {
    const remote = server();
    const host: FolderSyncHost = {
      readDevice: () => ({ folders: [] }),
      writeDevice: () => {},
      readRecord: () => null,
      writeRecord: () => {},
      load: () => remote.load(),
      save: (request) => remote.save(request),
      codec: () => Promise.resolve(null),
      now: () => T0
    };
    expect(await syncLibraryFolders(host)).toBe('waiting');
    expect(remote.snapshot.revision).toBe(0);
  });
});
