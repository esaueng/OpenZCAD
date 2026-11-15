import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLibraryLayout, saveLibraryLayout } from './libraryLayout';

describe('library layout reservation', () => {
  it('retains recovery footer positions beyond the project count when empty folders precede them', () => {
    const layout = {
      all: 1,
      pinned: 0,
      attention: 0,
      local: 0,
      footers: [2],
      groups: [{ label: null, count: 3 }]
    } as const;
    saveLibraryLayout({
      ...layout,
      footers: [...layout.footers],
      groups: [...layout.groups]
    });
    expect(readLibraryLayout()).toEqual(layout);
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps the pinned and unpinned groups, reading the old label as Others', () => {
    // The unpinned group was "Projects" under a "Projects" heading; a tab
    // opened before the rename still holds that label for this session.
    const groups = [
      { label: 'Pinned', count: 2 },
      { label: 'Projects', count: 4 }
    ];
    sessionStorage.setItem(
      'openzcad.library.layout.v1',
      JSON.stringify({
        all: 6,
        pinned: 2,
        attention: 0,
        local: 0,
        footers: [],
        groups
      })
    );
    expect(readLibraryLayout()?.groups).toEqual([
      { label: 'Pinned', count: 2 },
      { label: 'Others', count: 4 }
    ]);
    saveLibraryLayout({
      all: 6,
      pinned: 2,
      attention: 0,
      local: 0,
      footers: [],
      groups: [
        { label: 'Pinned', count: 2 },
        { label: 'Others', count: 4 }
      ]
    });
    expect(readLibraryLayout()?.groups?.[1]?.label).toBe('Others');
  });

  it('remembers only counts and footer positions for a reload', () => {
    const layout = {
      all: 12,
      pinned: 1,
      attention: 3,
      local: 0,
      footers: [0, 7]
    };
    saveLibraryLayout(layout);
    expect(readLibraryLayout()).toEqual(layout);
  });

  it.each([
    'null',
    '{',
    '{"all":999999}',
    '{"all":2,"pinned":3,"attention":0,"local":0,"footers":[]}'
  ])('ignores invalid stored layout %s', (value) => {
    sessionStorage.setItem('openzcad.library.layout.v1', value);
    expect(readLibraryLayout()).toBeNull();
  });

  it('works without session storage', () => {
    vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLibraryLayout()).toBeNull();
    expect(() =>
      saveLibraryLayout({
        all: 1,
        pinned: 0,
        attention: 0,
        local: 0,
        footers: []
      })
    ).not.toThrow();
  });
});
