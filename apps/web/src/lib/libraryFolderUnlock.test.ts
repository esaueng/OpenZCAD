import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeContext } from './e2ee/accountKeys';
import type {
  LibraryFolderSnapshot,
  SaveLibraryFolderRequest
} from './libraryFolderCloudSync';
import {
  createFolder,
  folderStorageKey,
  readLibraryFolders,
  writeLibraryFolders
} from './libraryFolders';
import { lockAccount, rememberUnlockedAccount } from './e2ee/unlockedKeys';
import { agreedShelfState, journalShelfEdit } from './sealedShelfState';
import { syncAccountLibraryFolders } from './libraryFolderCloudSync';

const USER = 'library-unlock-account';
const KEY = new Uint8Array(32).fill(42);
const ACTIVE = { status: 'active' as const, pinned: false, sortOrder: 0 };
const state = vi.hoisted(() => ({
  snapshot: null as LibraryFolderSnapshot | null,
  trusted: true,
  load: vi.fn(),
  save: vi.fn()
}));

vi.mock('./api', () => ({
  api: {
    getLibraryFolders: async () =>
      state.snapshot ?? {
        revision: 0,
        format: null,
        record: null,
        updatedAt: null
      },
    saveLibraryFolders: async (request: SaveLibraryFolderRequest) => {
      state.save(request);
      state.snapshot = {
        revision: (state.snapshot?.revision ?? 0) + 1,
        format: request.format,
        record: request.record,
        updatedAt: null
      };
      return state.snapshot;
    },
    resetProjectShelf: vi.fn()
  },
  encryptsAccountLibrary: async () => true
}));
vi.mock('./e2ee/accountKeys', () => ({ loadEncryption: state.load }));
vi.mock('./e2ee/keychainDeviceKeys', () => ({ deviceKeyStore: () => ({}) }));

beforeEach(() => {
  localStorage.clear();
  state.snapshot = null;
  state.trusted = true;
  vi.clearAllMocks();
  state.load.mockImplementation(async (ctx: E2eeContext) => {
    if (state.trusted && ctx.isCurrent?.() !== false)
      rememberUnlockedAccount(ctx.userId, {
        generation: 1,
        commitment: 'test',
        accountKey: KEY.slice(),
        encryptionPrivateKey: {} as CryptoKey
      });
    return { kind: 'ready', account: { unlocked: state.trusted } };
  });
});
afterEach(() => lockAccount(USER));

describe('library sync on a trusted device after reload', () => {
  it('uploads folders and pins, then opens them on another cold device without opening a project', async () => {
    const key = folderStorageKey(USER);
    writeLibraryFolders(
      key,
      createFolder(
        { folders: [] },
        { id: 'parts', name: 'Parts', projectIds: ['p1'], pinned: true }
      )
    );
    journalShelfEdit(USER, 'p1', ACTIVE, { ...ACTIVE, pinned: true });

    await syncAccountLibraryFolders(USER, () => false);
    expect(state.snapshot?.format).toBe(2);
    expect(state.load).toHaveBeenCalledTimes(1);

    // Another browser has the same trusted device key, but no page cache,
    // local folders, journal or previously decrypted project to unlock it.
    localStorage.clear();
    lockAccount(USER);
    await syncAccountLibraryFolders(USER, () => false);

    expect(readLibraryFolders(key).folders).toMatchObject([
      { id: 'parts', name: 'Parts', pinned: true, projectIds: ['p1'] }
    ]);
    expect(agreedShelfState(USER)?.p1?.pinned).toBe(true);
    expect(state.load).toHaveBeenCalledTimes(2);
    expect(state.save).toHaveBeenCalledTimes(1);
  });

  it('keeps an unapproved device locked and sends no folder or pin data', async () => {
    state.trusted = false;
    writeLibraryFolders(
      folderStorageKey(USER),
      createFolder({ folders: [] }, { id: 'private', name: 'Private parts' })
    );
    journalShelfEdit(USER, 'p1', ACTIVE, { ...ACTIVE, pinned: true });
    await syncAccountLibraryFolders(USER, () => false);
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(state.save).not.toHaveBeenCalled();
    expect(agreedShelfState(USER)).toBeNull();
  });

  it('does not publish a round whose account changes during the unlock', async () => {
    let cancelled = false;
    state.load.mockImplementation(async () => {
      cancelled = true;
      return { kind: 'ready', account: { unlocked: true } };
    });
    writeLibraryFolders(
      folderStorageKey(USER),
      createFolder({ folders: [] }, { id: 'parts', name: 'Parts' })
    );
    await syncAccountLibraryFolders(USER, () => cancelled);
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(state.save).not.toHaveBeenCalled();
  });
});
