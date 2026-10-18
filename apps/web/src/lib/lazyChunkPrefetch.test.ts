import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyChunkUrls, prefetchLazyChunks } from './lazyChunkPrefetch';

function island(json: string) {
  document.head.innerHTML = `<script type="application/json" id="oz-lazy-chunks">${json}</script>`;
}

afterEach(() => {
  document.head.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('lazy chunk prefetch', () => {
  it('resolves the list against the app base, not the current route', () => {
    island('["assets/a.js", "assets/b.css", 7]');
    const urls = lazyChunkUrls(document, '/');
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      '/assets/a.js',
      '/assets/b.css'
    ]);
    island('not json');
    expect(lazyChunkUrls(document, '/')).toEqual([]);
    document.head.innerHTML = '';
    expect(lazyChunkUrls(document, '/')).toEqual([]);
  });

  it('adds low-priority preloads a few at a time while the page is idle', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    island(
      JSON.stringify([
        'assets/1.js',
        'assets/2.js',
        'assets/3.js',
        'assets/4.js',
        'assets/5.css'
      ])
    );
    prefetchLazyChunks(document, '/');
    const links = () => [...document.head.querySelectorAll('link')];
    expect(links()).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(links()).toHaveLength(4);
    expect(links().every((link) => link.rel === 'modulepreload')).toBe(true);
    expect(links()[0]!.getAttribute('fetchpriority')).toBe('low');
    vi.advanceTimersByTime(1_000);
    expect(links().at(-1)!.rel).toBe('prefetch');
    expect(links()).toHaveLength(5);
  });

  it('respects Save-Data', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    island('["assets/1.js"]');
    prefetchLazyChunks(document, '/');
    vi.advanceTimersByTime(10_000);
    expect(document.head.querySelectorAll('link')).toHaveLength(0);
  });
});
