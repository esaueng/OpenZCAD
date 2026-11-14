import { describe, expect, it } from 'vitest';
import { folderClickSelection } from './objectFolderView';

describe('folderClickSelection', () => {
  it('replaces the selection with the folder bodies on a plain click', () => {
    expect(folderClickSelection(['a'], ['b', 'c'], false)).toEqual(['b', 'c']);
  });

  it('clears the old pick when a plain click lands on an empty folder', () => {
    // Regression: an empty folder used to leave the previous body selected.
    expect(folderClickSelection(['a', 'b'], [], false)).toEqual([]);
  });

  it('adds a folder that is not wholly picked with ⌘/Shift', () => {
    expect(folderClickSelection(['a', 'b'], ['b', 'c'], true)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });

  it('removes a folder that is wholly picked with ⌘/Shift, as a body row toggles', () => {
    expect(folderClickSelection(['a', 'b', 'c'], ['b', 'c'], true)).toEqual([
      'a'
    ]);
  });

  it('leaves the selection alone when ⌘/Shift lands on an empty folder', () => {
    expect(folderClickSelection(['a'], [], true)).toEqual(['a']);
  });
});
