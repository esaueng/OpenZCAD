// Built with the web app's Vite (the spike is not a workspace package):
//   pnpm --filter @openzcad/web exec vite build --config "$PWD/spikes/mls/web/vite.config.mjs"
const root = new URL('.', import.meta.url).pathname;

export default {
  root,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: `${root}dist`,
    emptyOutDir: true,
    target: 'es2022',
    // Inline nothing: every WASM file must stay a separate lazy asset.
    assetsInlineLimit: 0,
    reportCompressedSize: false
  },
  worker: { format: 'es' }
};
