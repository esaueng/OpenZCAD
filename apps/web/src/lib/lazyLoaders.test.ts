import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('lazy chunk loaders', () => {
  // 13 November design review I5: a plain `React.lazy` (FileDropTarget in
  // AppShell) failed offline straight to the page's "Loading interrupted"
  // card. `lazyWithStaleChunkNotice` and `preloadableLazy` wait for the
  // connection and retry; `staleChunk.ts` is where they call `lazy` itself.
  it('builds every lazy component on a loader that survives going offline', () => {
    const plain = sources(SRC)
      .filter((path) => !path.endsWith('staleChunk.ts'))
      .filter((path) =>
        /(?:^|[^\w.])(?:React\.)?lazy\(/m.test(
          readFileSync(path, 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '')
        )
      )
      .map((path) => relative(SRC, path));
    expect(plain).toEqual([]);
  });
});
