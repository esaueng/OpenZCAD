import { defineConfig } from 'vitest/config';
import config from './cad-operations.config';

export default defineConfig({
  ...config,
  test: { ...config.test, include: ['test/perf/sketch-edit.bench.ts'] }
});
