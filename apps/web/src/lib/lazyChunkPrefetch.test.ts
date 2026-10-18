import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyChunkUrls, prefetchLazyChunks } from './lazyChunkPrefetch';

function island(json: string) {
  document.head.innerHTML = `<script type="application/json" id="oz-lazy-chunks">${json}</script>`;
}

afterEach(() => {
  document.head.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('fetches into the HTTP cache a batch at a time, never touching the module map', async () => {
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
    const loaded: string[] = [];
    prefetchLazyChunks(document, '/', (href) => {
      loaded.push(new URL(href).pathname);
      return href.includes('2.js')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve();
    });
    expect(loaded).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loaded).toEqual([
      '/assets/1.js',
      '/assets/2.js',
      '/assets/3.js',
      '/assets/4.js'
    ]);
    // A failed fetch does not stop the queue.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loaded.at(-1)).toBe('/assets/5.css');
    expect(document.head.querySelectorAll('link')).toHaveLength(0);
  });

  it('waits out an offline spell instead of fetching', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    island('["assets/1.js"]');
    const loaded: string[] = [];
    prefetchLazyChunks(document, '/', (href) => {
      loaded.push(href);
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loaded).toHaveLength(0);
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loaded).toHaveLength(1);
  });

  it('respects Save-Data', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    island('["assets/1.js"]');
    const load = vi.fn(() => Promise.resolve());
    prefetchLazyChunks(document, '/', load);
    vi.advanceTimersByTime(10_000);
    expect(load).not.toHaveBeenCalled();
  });
});
