import { defineConfig } from 'vitest/config';
import config from '../../vitest.config';

/** Manual diagnostic; the root suite discovers only *.test.ts files. */
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['test/perf/h02-publication-history.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0
  }
});
