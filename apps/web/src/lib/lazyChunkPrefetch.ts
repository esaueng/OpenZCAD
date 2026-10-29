import { prefersSavingData } from './saveData';
import { MODEL_VISIBLE_MARK } from './startupReadiness';

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
 *
 * A chunk the page has already requested (the workspace imported it, or a
 * preload link named it) is skipped: its copy is already in the HTTP cache,
 * and a second request is only a duplicate in any network audit run with the
 * cache disabled. Nothing is fetched until the opened project's model is on
 * screen, or a library visit has had time to settle, so the prefetch never
 * competes with the startup that matters.
 */
const LIST_ID = 'oz-lazy-chunks';
/** Chunks requested per idle slot, so the prefetch never floods the link. */
const BATCH = 4;
/**
 * How long to wait for the opened project's first frame before prefetching
 * anyway. A library visit, a project with no bodies, or a failed rebuild
 * never marks one.
 */
export const MODEL_VISIBLE_WAIT_MS = 15_000;

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

/**
 * Every URL this document has requested or is requesting: finished requests
 * from Resource Timing (kept current by an observer, because the timeline's
 * own buffer stops at 250 entries), plus the scripts, stylesheets and
 * preloads in the DOM, which name a chunk before its request completes.
 */
export function requestedUrls(doc: Document) {
  const finished = new Set<string>();
  let observer: PerformanceObserver | undefined;
  try {
    for (const entry of performance.getEntriesByType('resource'))
      finished.add(entry.name);
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) finished.add(entry.name);
    });
    observer.observe({ type: 'resource' });
  } catch {
    // Without Resource Timing the DOM below is the only record.
  }
  return {
    has(href: string): boolean {
      if (finished.has(href)) return true;
      for (const element of doc.querySelectorAll<
        HTMLLinkElement | HTMLScriptElement
      >('link[href], script[src]')) {
        const named =
          element instanceof HTMLScriptElement ? element.src : element.href;
        if (named === href) return true;
      }
      return false;
    },
    dispose(): void {
      observer?.disconnect();
    }
  };
}

/**
 * Resolves once the opened project's model is on screen (`oz:model-visible`),
 * or after `timeoutMs` when no model is coming.
 */
export function modelVisible(
  timeoutMs: number = MODEL_VISIBLE_WAIT_MS
): Promise<void> {
  return new Promise((resolve) => {
    let observer: PerformanceObserver | undefined;
    const done = () => {
      observer?.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      if (performance.getEntriesByName(MODEL_VISIBLE_MARK, 'mark').length) {
        done();
        return;
      }
      observer = new PerformanceObserver((list) => {
        if (list.getEntriesByName(MODEL_VISIBLE_MARK).length > 0) done();
      });
      observer.observe({ type: 'mark' });
    } catch {
      // No observer support: the timeout alone decides.
    }
  });
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
    fetch(href, { priority: 'low' }).then((response) => response.arrayBuffer()),
  ready: Promise<void> = modelVisible()
): void {
  if (prefersSavingData()) return;
  const pending = lazyChunkUrls(doc, base);
  if (pending.length === 0) return;
  const requested = requestedUrls(doc);
  const next = () => {
    if (navigator.onLine === false) {
      window.addEventListener('online', () => idle(next), { once: true });
      return;
    }
    // Checked as each batch is cut, not once up front: the workspace keeps
    // importing chunks while the queue runs.
    const batch: string[] = [];
    while (batch.length < BATCH && pending.length > 0) {
      const href = pending.shift()!;
      if (!requested.has(href)) batch.push(href);
    }
    // One batch at a time, each fully read so the response is cached; a
    // failure is dropped (the chunk simply loads on demand later).
    void Promise.allSettled(batch.map((href) => load(href))).then(() => {
      if (pending.length > 0) idle(next);
      else requested.dispose();
    });
  };
  void ready.then(() => idle(next));
}
