import type { PluginOption } from 'vite';

/** The id of the JSON island in index.html that lists the lazy chunks. */
export const LAZY_CHUNK_LIST_ID = 'oz-lazy-chunks';

interface BundleEntry {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  viteMetadata?: { importedCss?: Set<string> };
}

/**
 * Every main-thread chunk the app loads on demand, with its CSS: the targets
 * of a dynamic `import()` anywhere in the bundle, plus the chunks those import
 * statically. Read from the import graph, not file names, so a worker started
 * by URL (the 1.2 MB pdf.js worker; worker bundles are assets anyway) is left
 * out while main-thread modules such as `meshImportWorkerClient` stay in.
 * Entry chunks already load with the page.
 */
export function lazyChunkFiles(bundle: Record<string, BundleEntry>): string[] {
  const chunks = new Map(
    Object.values(bundle)
      .filter((entry) => entry.type === 'chunk')
      .map((entry) => [entry.fileName, entry])
  );
  const pending = [...chunks.values()].flatMap(
    (entry) => entry.dynamicImports ?? []
  );
  const reached = new Set<string>();
  while (pending.length > 0) {
    const fileName = pending.pop()!;
    const entry = chunks.get(fileName);
    if (!entry || entry.isEntry || reached.has(fileName)) continue;
    reached.add(fileName);
    pending.push(...(entry.imports ?? []));
  }
  const files = new Set<string>();
  for (const fileName of reached) {
    files.add(fileName);
    for (const css of chunks.get(fileName)!.viteMetadata?.importedCss ?? [])
      files.add(css);
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
