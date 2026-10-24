// Built with the web app's Vite by run.mjs (this package has no
// dependencies of its own):
//   node apps/web/node_modules/vite/bin/vite.js build --config packages/mls/browser/vite.config.mjs
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  root,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: fileURLToPath(new URL('dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    // The WASM must stay a separate lazily fetched asset.
    assetsInlineLimit: 0,
    reportCompressedSize: false
  },
  worker: { format: 'es' }
};
