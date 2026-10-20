import { describe, expect, it } from 'vitest';
import { pruneProjectionCache } from './projectionCache';

describe('pruneProjectionCache', () => {
  const sized = (entries: [string, number][]) => new Map(entries);

  it('drops what no sheet draws, keeps the sheet on screen, and bounds the rest by recency', () => {
    const cache = sized([
      ['old', 40],
      ['gone', 10],
      ['shown', 500],
      ['newer', 30],
      ['newest', 20]
    ]);
    pruneProjectionCache(
      cache,
      new Set(['old', 'shown', 'newer', 'newest']),
      new Set(['shown']),
      60,
      (bytes) => bytes
    );
    // "gone" is drawn by nothing; "shown" stays however large; of the
    // inactive 90 bytes, the least recent ("old") goes to fit 60.
    expect([...cache.keys()]).toEqual(['newer', 'newest', 'shown']);
  });

  it('makes the sheet on screen the most recent, so leaving it keeps it longest', () => {
    const cache = sized([
      ['a', 10],
      ['b', 10]
    ]);
    pruneProjectionCache(
      cache,
      new Set(['a', 'b']),
      new Set(['a']),
      100,
      (bytes) => bytes
    );
    // Then the user switches to b's sheet with no room for a second sheet:
    // a is the only inactive entry and over budget, so it goes.
    pruneProjectionCache(
      cache,
      new Set(['a', 'b']),
      new Set(['b']),
      5,
      (bytes) => bytes
    );
    expect([...cache.keys()]).toEqual(['b']);
  });
});
