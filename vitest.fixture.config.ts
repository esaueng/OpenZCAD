import { defineConfig } from 'vitest/config';
import config from './vitest.config';
import { ROOT_FULL_INCLUDE } from './scripts/unit-suites.mjs';

// The deadline harness creates a temporary control file and owns its cold
// Git fixtures. Outer CI prewarming must not make that control pass.
export default defineConfig({
  ...config,
  test: { ...config.test, include: ROOT_FULL_INCLUDE, globalSetup: [] }
});
