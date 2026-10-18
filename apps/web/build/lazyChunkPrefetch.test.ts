import { describe, expect, it } from 'vitest';
import {
  LAZY_CHUNK_LIST_ID,
  injectLazyChunkList,
  lazyChunkFiles
} from './lazyChunkPrefetch';

describe('lazy chunk prefetch list', () => {
  it('lists what dynamic imports reach, with CSS and static deps, never entries or URL workers', () => {
    const files = lazyChunkFiles({
      'assets/index-a.js': {
        type: 'chunk',
        fileName: 'assets/index-a.js',
        isEntry: true,
        imports: ['assets/react-r.js'],
        dynamicImports: [
          'assets/Export-b.js',
          'assets/meshImportWorkerClient-m.js'
        ]
      },
      'assets/react-r.js': { type: 'chunk', fileName: 'assets/react-r.js' },
      'assets/Export-b.js': {
        type: 'chunk',
        fileName: 'assets/Export-b.js',
        imports: ['assets/shared-s.js', 'assets/index-a.js'],
        viteMetadata: { importedCss: new Set(['assets/Export-b.css']) }
      },
      'assets/shared-s.js': { type: 'chunk', fileName: 'assets/shared-s.js' },
      'assets/meshImportWorkerClient-m.js': {
        type: 'chunk',
        fileName: 'assets/meshImportWorkerClient-m.js'
      },
      // Started by URL, never imported: not something the page can preload.
      'assets/pdf.worker.min-d.js': {
        type: 'chunk',
        fileName: 'assets/pdf.worker.min-d.js'
      },
      'assets/geometryWorker-e.js': {
        type: 'asset',
        fileName: 'assets/geometryWorker-e.js'
      }
    });
    expect(files).toEqual([
      'assets/Export-b.css',
      'assets/Export-b.js',
      'assets/meshImportWorkerClient-m.js',
      'assets/shared-s.js'
    ]);
  });

  it('writes the list into head as inert, HTML-safe JSON', () => {
    const html = injectLazyChunkList(
      '<html><head><title>x</title></head><body></body></html>',
      ['assets/a</script>.js']
    );
    expect(html).toContain(
      `<script type="application/json" id="${LAZY_CHUNK_LIST_ID}">["assets/a\\u003c/script>.js"]</script>`
    );
    expect(html.indexOf(LAZY_CHUNK_LIST_ID)).toBeLessThan(
      html.indexOf('</head>')
    );
    expect(() => injectLazyChunkList('<html></html>', [])).toThrow(/head/);
  });
});
