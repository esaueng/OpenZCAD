// Run from the repository root:
//   pnpm exec vitest run --config spikes/mls/harness/vitest.config.mjs
// Needs the WASM packages from spikes/mls/build.sh.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: new URL('.', import.meta.url).pathname,
    include: ['*.test.mjs'],
    environment: 'node',
    testTimeout: 120_000
  }
});
