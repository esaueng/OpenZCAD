// Built with the web app's Vite by run.mjs (this package has no
// dependencies of its own):
//   node apps/web/node_modules/vite/bin/vite.js build --config packages/crypto/browser/vite.config.mjs
import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: fileURLToPath(new URL('dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false
  }
};
