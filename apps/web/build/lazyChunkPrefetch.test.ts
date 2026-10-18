import { describe, expect, it } from 'vitest';
import {
  LAZY_CHUNK_LIST_ID,
  injectLazyChunkList,
  lazyChunkFiles
} from './lazyChunkPrefetch';

describe('lazy chunk prefetch list', () => {
  it('lists on-demand chunks and their CSS, never entries, assets or workers', () => {
    const files = lazyChunkFiles({
      'assets/index-a.js': {
        type: 'chunk',
        fileName: 'assets/index-a.js',
        isEntry: true
      },
      'assets/Export-b.js': {
        type: 'chunk',
        fileName: 'assets/Export-b.js',
        viteMetadata: { importedCss: new Set(['assets/Export-b.css']) }
      },
      'assets/three-c.js': { type: 'chunk', fileName: 'assets/three-c.js' },
      'assets/pdf.worker.min-d.js': {
        type: 'chunk',
        fileName: 'assets/pdf.worker.min-d.js'
      },
      'assets/geometryWorker-e.js': {
        type: 'asset',
        fileName: 'assets/geometryWorker-e.js'
      },
      'assets/remus_wasm_bg-f.wasm': {
        type: 'asset',
        fileName: 'assets/remus_wasm_bg-f.wasm'
      }
    });
    expect(files).toEqual([
      'assets/Export-b.css',
      'assets/Export-b.js',
      'assets/three-c.js'
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
