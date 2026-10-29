import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_VISIBLE_WAIT_MS,
  lazyChunkUrls,
  modelVisible,
  prefetchLazyChunks
} from './lazyChunkPrefetch';
import { MODEL_VISIBLE_MARK } from './startupReadiness';

function island(json: string) {
  document.head.innerHTML = `<script type="application/json" id="oz-lazy-chunks">${json}</script>`;
}

const ready = () => Promise.resolve();

afterEach(() => {
  document.head.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  performance.clearMarks(MODEL_VISIBLE_MARK);
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
    prefetchLazyChunks(
      document,
      '/',
      (href) => {
        loaded.push(new URL(href).pathname);
        return href.includes('2.js')
          ? Promise.reject(new Error('offline'))
          : Promise.resolve();
      },
      ready()
    );
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

  it('skips chunks the page already requested, including ones imported mid-queue', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const origin = new URL('/', document.baseURI).origin;
    const finished = [`${origin}/assets/imported.js`];
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(
      (type) =>
        (type === 'resource'
          ? finished.map((name) => ({ name }))
          : []) as PerformanceEntryList
    );
    island(
      JSON.stringify([
        'assets/imported.js',
        'assets/preloaded.js',
        'assets/1.js',
        'assets/2.js',
        'assets/3.js',
        'assets/4.js',
        'assets/later.js',
        'assets/5.js'
      ])
    );
    // A chunk whose import is still in flight is named by its preload link.
    const preload = document.createElement('link');
    preload.rel = 'modulepreload';
    preload.href = '/assets/preloaded.js';
    document.head.append(preload);
    const loaded: string[] = [];
    prefetchLazyChunks(
      document,
      '/',
      (href) => {
        loaded.push(new URL(href).pathname);
        return Promise.resolve();
      },
      ready()
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loaded).toEqual([
      '/assets/1.js',
      '/assets/2.js',
      '/assets/3.js',
      '/assets/4.js'
    ]);
    // The workspace imports one while the queue runs: a preload names it.
    const imported = document.createElement('link');
    imported.rel = 'modulepreload';
    imported.href = '/assets/later.js';
    document.head.append(imported);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loaded.slice(4)).toEqual(['/assets/5.js']);
  });

  it('waits for the opened model before fetching anything', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    island('["assets/1.js"]');
    let showModel!: () => void;
    const shown = new Promise<void>((resolve) => (showModel = resolve));
    const load = vi.fn(() => Promise.resolve());
    prefetchLazyChunks(document, '/', load, shown);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).not.toHaveBeenCalled();
    showModel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('treats the model-visible mark, or a library visit timing out, as ready', async () => {
    performance.mark(MODEL_VISIBLE_MARK);
    await expect(modelVisible(60_000)).resolves.toBeUndefined();
    performance.clearMarks(MODEL_VISIBLE_MARK);

    vi.useFakeTimers();
    let settled = false;
    void modelVisible().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(MODEL_VISIBLE_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('waits out an offline spell instead of fetching', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    island('["assets/1.js"]');
    const loaded: string[] = [];
    prefetchLazyChunks(
      document,
      '/',
      (href) => {
        loaded.push(href);
        return Promise.resolve();
      },
      ready()
    );
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
    prefetchLazyChunks(document, '/', load, ready());
    vi.advanceTimersByTime(10_000);
    expect(load).not.toHaveBeenCalled();
  });
});
