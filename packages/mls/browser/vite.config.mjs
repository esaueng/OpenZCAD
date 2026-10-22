// Built with the web app's Vite by run.mjs (this package has no
// dependencies of its own):
//   pnpm --filter @openzcad/web exec vite build --config "$PWD/packages/mls/browser/vite.config.mjs"
const root = new URL('.', import.meta.url).pathname;

export default {
  root,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: `${root}dist`,
    emptyOutDir: true,
    target: 'es2022',
    // The WASM must stay a separate lazily fetched asset.
    assetsInlineLimit: 0,
    reportCompressedSize: false
  },
  worker: { format: 'es' }
};
