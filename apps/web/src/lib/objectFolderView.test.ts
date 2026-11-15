import { describe, expect, it } from 'vitest';
import { folderClickSelection, folderCommandPicks } from './objectFolderView';

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

describe('folderCommandPicks', () => {
  it('adds the folder bodies a many-body command has not picked yet', () => {
    expect(folderCommandPicks(['a'], ['a', 'b', 'c'], 'many')).toEqual({
      kind: 'toggle',
      bodies: ['b', 'c']
    });
  });

  it('takes back a folder whose bodies the command has all picked', () => {
    // Regression: a folder toggle cleared the selection while Union kept
    // both operands and could still commit them.
    expect(folderCommandPicks(['a', 'b', 'c'], ['b', 'c'], 'many')).toEqual({
      kind: 'toggle',
      bodies: ['b', 'c']
    });
  });

  it('leaves the command alone for an empty folder', () => {
    expect(folderCommandPicks(['a'], [], 'many')).toEqual({ kind: 'none' });
    expect(folderCommandPicks(['a'], [], 'one')).toEqual({ kind: 'none' });
  });

  it('gives a one-body command a folder of exactly one body', () => {
    expect(folderCommandPicks(['a'], ['b'], 'one')).toEqual({
      kind: 'toggle',
      bodies: ['b']
    });
    expect(folderCommandPicks(['a'], ['b', 'c'], 'one')).toEqual({
      kind: 'too-many'
    });
  });
});
