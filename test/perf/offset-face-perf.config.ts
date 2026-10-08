import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import config from '../../vitest.config';

// Preserve timing output (the normal test setup suppresses console output).
// The optional baseline swaps only adapter source, retaining the same WASM.
export default defineConfig({
  ...config,
  resolve: {
    alias: {
      ...config.resolve?.alias,
      ...(process.env.CAD_PERF_BASELINE_ROOT
        ? {
            '@openzcad/kernel-adapter/exact': resolve(
              process.env.CAD_PERF_BASELINE_ROOT,
              'packages/kernel-adapter/src/exact.ts'
            )
          }
        : {})
    }
  },
  test: {
    include: ['test/perf/offset-face-perf.test.ts'],
    setupFiles: [],
    maxWorkers: 1,
    testTimeout: 900_000
  }
});
