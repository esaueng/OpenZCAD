import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveLibraryFolderRequest } from './libraryFolderCloudSync';

/**
 * The shelf's sync round for the signed-in account: which codec it picks,
 * and that a page whose account starts encrypting mid-visit never sends
 * folder names readable again.
 */
const state = vi.hoisted(() => ({
  encrypts: false,
  /** The Worker refuses readable folders (it knows before the page does). */
  sealedOnly: false,
  revision: 0,
  saves: [] as SaveLibraryFolderRequest[]
}));

vi.mock('./api', () => ({
  api: {
    getLibraryFolders: vi.fn(async () => ({
      revision: state.revision,
      format: null,
      record: null,
      updatedAt: null
    })),
    saveLibraryFolders: vi.fn(async (request: SaveLibraryFolderRequest) => {
      state.saves.push(request);
      if (request.format === 1 && state.sealedOnly) {
        throw Object.assign(new Error('sealed only'), {
          code: 'LIBRARY_FOLDERS_ENCRYPTION_REQUIRED'
        });
      }
      state.revision += 1;
      return {
        revision: state.revision,
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
  state.encrypts = false;
  state.sealedOnly = false;
  state.revision = 0;
  localStorage.clear();
});

async function shelf(accountId: string, name: string) {
  const {
    createFolder,
    folderStorageKey,
    readLibraryFolders,
    writeLibraryFolders
  } = await import('./libraryFolders');
  const key = folderStorageKey(accountId);
  writeLibraryFolders(
    key,
    createFolder(readLibraryFolders(key), {
      id: `f-${name}`,
      name,
      projectIds: ['proj_encrypted'],
      now: new Date().toISOString()
    })
  );
}

describe('syncAccountLibraryFolders', () => {
  it('asks again each round, so a page that starts encrypting sends nothing readable', async () => {
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    const accountId = 'user_starts_encrypting';
    await shelf(accountId, 'Client work');
    // Before the account held an encrypted project: readable, as before.
    expect(await syncAccountLibraryFolders(accountId, () => false)).toBe(false);
    expect(state.saves.map((save) => save.format)).toEqual([1]);

    // This page encrypts a project, then the user makes a folder.
    state.encrypts = true;
    await shelf(accountId, 'Secret client');
    expect(await syncAccountLibraryFolders(accountId, () => false)).toBe(false);
    // Keys locked: the round waits. No folder name left readable.
    expect(state.saves.map((save) => save.format)).toEqual([1]);
  });

  it('seals from the next round when the Worker refuses readable folders first', async () => {
    const { syncAccountLibraryFolders } =
      await import('./libraryFolderCloudSync');
    const accountId = 'user_member_only';
    await shelf(accountId, 'Client work');
    state.sealedOnly = true;
    // The page's answer lagged the Worker's (another tab accepted an
    // invitation): the refusal keeps sync going, sealed.
    expect(await syncAccountLibraryFolders(accountId, () => false)).toBe(false);
    expect(state.saves.map((save) => save.format)).toEqual([1]);
    expect(await syncAccountLibraryFolders(accountId, () => false)).toBe(false);
    expect(state.saves.map((save) => save.format)).toEqual([1]);
  });
});
