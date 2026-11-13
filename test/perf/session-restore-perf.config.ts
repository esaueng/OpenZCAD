import { defineConfig } from 'vitest/config';
import config from '../../vitest.config';

// Preserve timing output (the normal test setup suppresses console output).
export default defineConfig({
  ...config,
  test: {
    include: ['test/perf/session-restore-perf.test.ts'],
    setupFiles: [],
    maxWorkers: 1,
    testTimeout: 900_000
  }
});
