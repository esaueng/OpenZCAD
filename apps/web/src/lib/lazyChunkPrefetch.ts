/**
 * Fetches every on-demand chunk of this deploy once the page is idle, so a
 * tool opens without waiting on the network and a deploy that lands
 * mid-session cannot strand a tool whose chunk this tab never fetched (see
 * `staleChunk.ts`). The chunk list comes from index.html, written at build
 * time by `build/lazyChunkPrefetch.ts`. Hashed assets are cached immutably,
 * so each chunk downloads once per deploy at most.
 *
 * Chunks go into the HTTP cache through plain `fetch`, never `modulepreload`:
 * a module preload that fails (offline, or the link dropping mid-batch) is
 * kept in the document's module map, and every later `import()` of it fails
 * until a reload. A failed fetch leaves nothing behind, and the queue waits
 * out an offline spell rather than spending it on doomed requests.
 */
const LIST_ID = 'oz-lazy-chunks';
/** Chunks requested per idle slot, so the prefetch never floods the link. */
const BATCH = 4;

export function lazyChunkUrls(doc: Document, base: string): string[] {
  const raw = doc.getElementById(LIST_ID)?.textContent;
  if (!raw) return [];
  try {
    const files: unknown = JSON.parse(raw);
    return Array.isArray(files)
      ? files
          .filter((file): file is string => typeof file === 'string')
          .map((file) => new URL(file, new URL(base, doc.baseURI)).href)
      : [];
  } catch {
    return [];
  }
}

function idle(callback: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback, { timeout: 5_000 });
  } else {
    window.setTimeout(callback, 1_000);
  }
}

export function prefetchLazyChunks(
  doc: Document = document,
  base: string = import.meta.env.BASE_URL,
  load: (href: string) => Promise<unknown> = (href) =>
    fetch(href, { priority: 'low' }).then((response) => response.arrayBuffer())
): void {
  const connection = (navigator as { connection?: { saveData?: boolean } })
    .connection;
  if (connection?.saveData) return;
  const pending = lazyChunkUrls(doc, base);
  const next = () => {
    if (navigator.onLine === false) {
      window.addEventListener('online', () => idle(next), { once: true });
      return;
    }
    const batch = pending.splice(0, BATCH);
    // One batch at a time, each fully read so the response is cached; a
    // failure is dropped (the chunk simply loads on demand later).
    void Promise.allSettled(batch.map((href) => load(href))).then(() => {
      if (pending.length > 0) idle(next);
    });
  };
  idle(next);
}
