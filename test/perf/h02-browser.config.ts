import { accessSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

if (!process.env.OZ_PERF || !process.env.OZ_PERF_HOLDER_STEP)
  throw new Error(
    'Set OZ_PERF=1 and OZ_PERF_HOLDER_STEP to a local STEP source.'
  );
accessSync(process.env.OZ_PERF_HOLDER_STEP);
if (!['disabled', 'enabled'].includes(process.env.H02_CACHE_MODE ?? ''))
  throw new Error('H02_CACHE_MODE must be disabled or enabled.');
if (!process.env.OZ_PERF_OUT || !isAbsolute(process.env.OZ_PERF_OUT))
  throw new Error(
    'Set OZ_PERF_OUT to an absolute local path outside the repository.'
  );

const output = process.env.OZ_PERF_OUT;
let ancestor = resolve(output);
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
const canonicalOutput = resolve(
  realpathSync(ancestor),
  relative(ancestor, resolve(output))
);
const relativeOutput = relative(realpathSync(process.cwd()), canonicalOutput);
if (
  relativeOutput !== '..' &&
  !relativeOutput.startsWith(`..${sep}`) &&
  !isAbsolute(relativeOutput)
)
  throw new Error('Private samples must remain outside the repository.');

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
  outputDir: resolve(
    dirname(output),
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
