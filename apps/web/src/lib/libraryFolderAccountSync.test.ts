import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveLibraryFolderRequest } from './libraryFolderCloudSync';

/**
 * The shelf's sync round for the signed-in account: which codec it picks
 * and what it does when the Worker requires sealed folders.
 */
const state = vi.hoisted(() => ({
  encrypts: false,
  saves: [] as SaveLibraryFolderRequest[]
}));

vi.mock('./api', () => ({
  api: {
    getLibraryFolders: vi.fn(async () => ({
      revision: 0,
      format: null,
      record: null,
      updatedAt: null
    })),
    saveLibraryFolders: vi.fn(async (request: SaveLibraryFolderRequest) => {
      state.saves.push(request);
      if (request.format === 1) {
        throw Object.assign(new Error('sealed only'), {
          code: 'LIBRARY_FOLDERS_ENCRYPTION_REQUIRED'
        });
      }
      return {
        revision: 1,
        format: request.format,
        record: request.record,
        updatedAt: null
      };
    })
  },
  encryptsAccountLibrary: vi.fn(async () => state.encrypts)
}));

// Locked keys: a sealed round waits rather than sending anything.
vi.mock('./e2ee/unlockedKeys', () => ({ unlockedAccount: () => undefined }));

afterEach(() => {
  state.saves = [];
  localStorage.clear();
});

describe('syncAccountLibraryFolders', () => {
  it('seals from the next round once the Worker requires it, instead of stopping', async () => {
    const { createFolder, folderStorageKey, writeLibraryFolders } =
      await import('./libraryFolders');
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    const accountId = 'user_member_only';
    writeLibraryFolders(
      folderStorageKey(accountId),
      createFolder(
        { folders: [] },
        {
          id: 'f-shared',
          name: 'Client work',
          projectIds: ['proj_encrypted'],
          now: '2026-10-01T00:00:00.000Z'
        }
      )
    );

    // This visit started before the account held an encrypted project.
    expect(await syncAccountLibraryFolders(accountId, () => false)).toBe(false);
    expect(state.saves.map((save) => save.format)).toEqual([1]);

    // The refusal switched this account to sealing: with its keys locked,
    // the next round sends nothing at all, and certainly not plaintext.
    expect(await syncAccountLibraryFolders(accountId, () => false)).toBe(false);
    expect(state.saves.map((save) => save.format)).toEqual([1]);
  });
});
