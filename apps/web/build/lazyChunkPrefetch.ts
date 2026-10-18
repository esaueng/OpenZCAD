import type { PluginOption } from 'vite';

/** The id of the JSON island in index.html that lists the lazy chunks. */
export const LAZY_CHUNK_LIST_ID = 'oz-lazy-chunks';

interface BundleEntry {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  viteMetadata?: { importedCss?: Set<string> };
}

/**
 * Every main-thread chunk the app loads on demand, with its CSS. Entry
 * chunks already load with the page. Worker scripts are left out: most are
 * separate builds that reach this bundle only as assets, and the one that is
 * a chunk (the 1.2 MB pdf.js worker, for PDF attachments only) runs in a
 * worker, where a module preload on the page does nothing for it.
 */
const WORKER_SCRIPT = /worker/i;

export function lazyChunkFiles(bundle: Record<string, BundleEntry>): string[] {
  const files = new Set<string>();
  for (const entry of Object.values(bundle)) {
    if (entry.type !== 'chunk' || entry.isEntry) continue;
    if (WORKER_SCRIPT.test(entry.fileName)) continue;
    files.add(entry.fileName);
    for (const css of entry.viteMetadata?.importedCss ?? []) files.add(css);
  }
  return [...files].sort();
}

/**
 * Writes the list into index.html as inert JSON (a CSP-safe data island, not
 * a script), so the list always names the chunks of the deploy that served
 * the page.
 */
export function injectLazyChunkList(html: string, files: string[]): string {
  const island = `<script type="application/json" id="${LAZY_CHUNK_LIST_ID}">${JSON.stringify(
    files
  ).replaceAll('<', '\\u003c')}</script>`;
  if (!html.includes('</head>')) {
    throw new Error('index.html has no </head> to carry the lazy chunk list.');
  }
  return html.replace('</head>', `    ${island}\n  </head>`);
}

/** See `src/lib/lazyChunkPrefetch.ts` for the runtime half. */
export function lazyChunkPrefetch(): PluginOption {
  return {
    name: 'openzcad-lazy-chunk-prefetch',
    apply: 'build',
    // Vite writes index.html after the chunks are final; the post-order
    // transform is the hook that sees both.
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        return context.bundle
          ? injectLazyChunkList(html, lazyChunkFiles(context.bundle))
          : html;
      }
    }
  };
}
