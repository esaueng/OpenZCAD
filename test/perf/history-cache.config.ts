import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import config from '../../vitest.config.ts';

const baseline = process.env.HISTORY_MODE === 'baseline';
const baselineRoot = process.env.HISTORY_BASELINE_ROOT;
if (baseline && !baselineRoot)
  throw new Error('Set HISTORY_BASELINE_ROOT to the baseline checkout.');

export default defineConfig({
  ...config,
  resolve: {
    alias: {
      ...config.resolve?.alias,
      ...(baseline
        ? {
            '@openzcad/kernel-adapter/exact': resolve(
              baselineRoot!,
              'packages/kernel-adapter/src/exact.ts'
            )
          }
        : {})
    }
  },
  test: {
    include: ['test/perf/history-cache.bench.ts'],
    setupFiles: process.env.HISTORY_SESSION
      ? ['./test/perf/history-cache-memory.setup.ts']
      : [],
    maxWorkers: 1,
    testTimeout: 1_800_000
  }
});
