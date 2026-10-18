/**
 * Fetches every on-demand chunk of this deploy once the page is idle, so a
 * tool opens without waiting on the network and a deploy that lands
 * mid-session cannot strand a tool whose chunk this tab never fetched (see
 * `staleChunk.ts`). The chunk list comes from index.html, written at build
 * time by `build/lazyChunkPrefetch.ts`. Hashed assets are cached immutably,
 * so each chunk downloads once per deploy at most.
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
  base: string = import.meta.env.BASE_URL
): void {
  const connection = (navigator as { connection?: { saveData?: boolean } })
    .connection;
  if (connection?.saveData) return;
  const pending = lazyChunkUrls(doc, base);
  const next = () => {
    for (const href of pending.splice(0, BATCH)) {
      const link = doc.createElement('link');
      link.rel = href.endsWith('.css') ? 'prefetch' : 'modulepreload';
      link.href = href;
      link.setAttribute('fetchpriority', 'low');
      doc.head.append(link);
    }
    if (pending.length > 0) idle(next);
  };
  idle(next);
}
