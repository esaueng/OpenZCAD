import { defineConfig } from 'vitest/config';
import config from './vitest.config';
import { ROOT_FULL_INCLUDE } from './scripts/unit-suites.mjs';

export default defineConfig({
  ...config,
  test: { ...config.test, include: ROOT_FULL_INCLUDE }
});
