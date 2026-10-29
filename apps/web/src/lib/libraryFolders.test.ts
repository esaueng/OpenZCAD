import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFolder,
  deleteFolder,
  folderCover,
  folderOf,
  folderStorageKey,
  forgetProjects,
  moveProjectsToFolder,
  nextFolderName,
  parseLibraryFolders,
  readLibraryFolders,
  renameFolder,
  reorderFolders,
  setFolderCover,
  setFolderPinned,
  writeLibraryFolders,
  type LibraryFolders
} from './libraryFolders';

const NOW = '2026-10-29T12:00:00.000Z';
const empty: LibraryFolders = { folders: [] };

function withTwo(): LibraryFolders {
  return createFolder(
    createFolder(empty, {
      id: 'a',
      name: 'Brackets',
      projectIds: ['p1', 'p2'],
      now: NOW
    }),
    { id: 'b', name: 'Holders', projectIds: ['p3'], now: NOW }
  );
}

describe('library folders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('retains edits and account isolation when storage reads and writes throw', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('Storage blocked');
      },
      setItem() {
        throw new Error('Storage blocked');
      }
    });
    const key = folderStorageKey('blocked-reads');
    expect(readLibraryFolders(key)).toEqual(empty);
    const state = withTwo();
    writeLibraryFolders(key, state);
    expect(readLibraryFolders(key)).toBe(state);
    const renamed = renameFolder(readLibraryFolders(key), 'a', 'Visit only');
    writeLibraryFolders(key, renamed);
    expect(readLibraryFolders(key)).toBe(renamed);
    expect(readLibraryFolders(folderStorageKey('other-account'))).toEqual(
      empty
    );
  });

  it('retains folders for the visit when localStorage is absent', () => {
    vi.stubGlobal('localStorage', undefined);
    const state = withTwo();
    const key = folderStorageKey('absent-storage');
    writeLibraryFolders(key, state);
    expect(readLibraryFolders(key)).toBe(state);
  });

  it('names a new folder without duplicating an existing name', () => {
    let state = createFolder(empty, { id: 'a', now: NOW });
    expect(state.folders[0]!.name).toBe('New folder');
    state = createFolder(state, { id: 'b', now: NOW });
    expect(state.folders.map((folder) => folder.name)).toEqual([
      'New folder',
      'New folder 2'
    ]);
    expect(nextFolderName(state)).toBe('New folder 3');
  });

  it('keeps a part in one folder at a time', () => {
    const state = moveProjectsToFolder(withTwo(), ['p1'], 'b');
    expect(folderOf(state, 'p1')?.id).toBe('b');
    expect(state.folders[0]!.projectIds).toEqual(['p2']);
    expect(state.folders[1]!.projectIds).toEqual(['p3', 'p1']);
    // Creating a folder from parts takes them out of the old ones too.
    const merged = createFolder(state, {
      id: 'c',
      projectIds: ['p2', 'p3'],
      now: NOW
    });
    expect(merged.folders.map((folder) => folder.projectIds)).toEqual([
      [],
      ['p1'],
      ['p2', 'p3']
    ]);
  });

  it('takes parts out of every folder with a null target', () => {
    const state = moveProjectsToFolder(withTwo(), ['p2', 'p3'], null);
    expect(state.folders.map((folder) => folder.projectIds)).toEqual([
      ['p1'],
      []
    ]);
  });

  it('uses the chosen cover, else the first listed member', () => {
    let state = withTwo();
    const listed = new Set(['p1', 'p2', 'p3']);
    expect(folderCover(state.folders[0]!, listed)).toBe('p1');
    state = setFolderCover(state, 'a', 'p2');
    expect(folderCover(state.folders[0]!, listed)).toBe('p2');
    // A cover that left the listing (trashed) falls back to the first member.
    expect(folderCover(state.folders[0]!, new Set(['p1']))).toBe('p1');
    // A part outside the folder cannot be its cover.
    expect(setFolderCover(state, 'a', 'p3').folders[0]!.coverProjectId).toBe(
      'p2'
    );
    // Moving the cover out clears it.
    expect(
      moveProjectsToFolder(state, ['p2'], 'b').folders[0]!.coverProjectId
    ).toBeUndefined();
  });

  it('renames, pins, reorders, forgets and ungroups', () => {
    let state = renameFolder(withTwo(), 'a', '  Wall   brackets ');
    expect(state.folders[0]!.name).toBe('Wall brackets');
    expect(renameFolder(state, 'a', '   ')).toBe(state);
    state = setFolderPinned(state, 'b', true);
    expect(state.folders[1]!.pinned).toBe(true);
    state = reorderFolders(state, ['b']);
    expect(state.folders.map((folder) => folder.id)).toEqual(['b', 'a']);
    state = forgetProjects(state, ['p1']);
    expect(state.folders[1]!.projectIds).toEqual(['p2']);
    state = deleteFolder(state, 'b');
    expect(state.folders.map((folder) => folder.id)).toEqual(['a']);
  });

  it('drops malformed storage instead of trusting it', () => {
    expect(parseLibraryFolders('nope')).toEqual(empty);
    expect(parseLibraryFolders('{"folders":3}')).toEqual(empty);
    const parsed = parseLibraryFolders(
      JSON.stringify({
        folders: [
          {
            id: 'a',
            name: 'One',
            projectIds: ['p1', 7, 'p2'],
            coverProjectId: 'zz',
            pinned: 'yes'
          },
          { id: 'a', name: 'Duplicate id' },
          { id: 'b', name: 'Two', projectIds: ['p2', 'p3'], pinned: true },
          { name: 'No id' }
        ]
      })
    );
    expect(parsed.folders).toHaveLength(2);
    expect(parsed.folders[0]).toMatchObject({
      id: 'a',
      projectIds: ['p1', 'p2'],
      pinned: false
    });
    expect(parsed.folders[0]!.coverProjectId).toBeUndefined();
    // p2 was already claimed by the first folder.
    expect(parsed.folders[1]!.projectIds).toEqual(['p3']);
  });

  it('keeps each account’s folders apart', () => {
    writeLibraryFolders(folderStorageKey('user-a'), withTwo());
    expect(readLibraryFolders(folderStorageKey('user-a')).folders).toHaveLength(
      2
    );
    expect(readLibraryFolders(folderStorageKey('user-b')).folders).toHaveLength(
      0
    );
    expect(readLibraryFolders(folderStorageKey(null)).folders).toHaveLength(0);
    // The same stored string reads back as the same object.
    expect(readLibraryFolders(folderStorageKey('user-a'))).toBe(
      readLibraryFolders(folderStorageKey('user-a'))
    );
  });

  it('keeps folders for the visit when storage refuses the write', () => {
    const key = folderStorageKey('user-blocked');
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      });
    try {
      writeLibraryFolders(key, withTwo());
      expect(
        readLibraryFolders(key).folders.map((folder) => folder.id)
      ).toEqual(['a', 'b']);
    } finally {
      setItem.mockRestore();
    }
    // Once storage takes a write again, it is the source.
    writeLibraryFolders(key, deleteFolder(withTwo(), 'a'));
    expect(localStorage.getItem(key)).toContain('"b"');
    expect(readLibraryFolders(key).folders.map((folder) => folder.id)).toEqual([
      'b'
    ]);
  });

  it('keeps a folder’s cover when its parts are reordered', () => {
    const state = setFolderCover(withTwo(), 'a', 'p2');
    const reordered = moveProjectsToFolder(state, ['p2', 'p1'], 'a');
    expect(reordered.folders[0]).toMatchObject({
      projectIds: ['p2', 'p1'],
      coverProjectId: 'p2'
    });
    // Moved to another folder, the cover still leaves with it.
    expect(
      moveProjectsToFolder(state, ['p2'], 'b').folders[0]!.coverProjectId
    ).toBeUndefined();
  });
});
