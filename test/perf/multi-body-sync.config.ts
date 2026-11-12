import { defineConfig } from 'vitest/config';
import config from '../../vitest.config';

export default defineConfig({
  ...config,
  test: {
    include: ['test/perf/multi-body-sync.bench.ts'],
    setupFiles: [],
    maxWorkers: 1,
    testTimeout: 1_800_000
  }
});
