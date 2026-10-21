/** Serial private-session qualification; never included by ordinary E2E CI. */
import { dirname, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import matched from './h02-browser.config';

if (
  process.env.H02_SESSION_PROBE !== '1' ||
  process.env.H02_CACHE_MODE !== 'enabled'
)
  throw new Error(
    'Private session requires H02_SESSION_PROBE=1 and enabled defaults.'
  );
export default defineConfig({
  ...matched,
  testMatch: 'h02-private-session.spec.ts',
  grep: undefined,
  timeout: 3_600_000,
  outputDir: resolve(
    dirname(process.env.OZ_PERF_OUT!),
    'h02-private-session-artifacts'
  )
});
