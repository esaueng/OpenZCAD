import { accessSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';
import {
  assertBenchmarkCheckout,
  benchmarkCheckout
} from '../support/benchmarkCheckout';
import { privateArtifactPaths } from '../support/privateArtifacts';

if (!process.env.OZ_PERF || !process.env.OZ_PERF_HOLDER_STEP)
  throw new Error(
    'Set OZ_PERF=1 and OZ_PERF_HOLDER_STEP to a local STEP source.'
  );
accessSync(process.env.OZ_PERF_HOLDER_STEP);
const checkout = benchmarkCheckout();
// Playwright loads this config again in workers. Preserve the coordinator's
// build identity instead of silently repinning after a checkout switch.
assertBenchmarkCheckout({
  sourceCommit: process.env.H02_SOURCE_COMMIT ?? checkout.sourceCommit,
  lockfileSha256: process.env.H02_LOCKFILE_SHA256 ?? checkout.lockfileSha256
});
process.env.H02_SOURCE_COMMIT = checkout.sourceCommit;
process.env.H02_LOCKFILE_SHA256 = checkout.lockfileSha256;
process.env.OPENZCAD_BUILD_COMMIT = checkout.sourceCommit;
if (!['disabled', 'enabled'].includes(process.env.H02_CACHE_MODE ?? ''))
  throw new Error('H02_CACHE_MODE must be disabled or enabled.');
const paths = privateArtifactPaths(process.env.OZ_PERF_OUT);
process.env.OZ_PERF_OUT = paths.output;

const server = base.webServer as {
  command: string;
  url: string;
  timeout: number;
};
export default defineConfig({
  ...base,
  testDir: '../e2e',
  testMatch: 'perf-holder-reload.spec.ts',
  grep: /private holder/,
  workers: 1,
  retries: 0,
  outputDir: paths.artifact(
    `h02-playwright-${process.env.H02_CACHE_MODE}-${process.env.H02_PAIR ?? 'unpaired'}`
  ),
  webServer: {
    ...server,
    // A stale server could silently measure the other arm. Always build/start.
    reuseExistingServer: false,
    command: server.command
      .replace(
        'pnpm --filter @openzcad/web build',
        'pnpm --filter @openzcad/web exec vite build --config ../../test/perf/h02-vite.config.ts'
      )
      .replace(
        'pnpm --filter @openzcad/web preview',
        'VITE_E2E=1 pnpm --filter @openzcad/web exec vite preview --config ../../test/perf/h02-vite.config.ts'
      )
  }
});
