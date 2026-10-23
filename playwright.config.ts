import { createHash } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import {
  privateArtifactPaths,
  privatePlaywrightOutput
} from './test/support/privateArtifacts';
import { fullRenderBuild } from './test/support/renderBuild';

// Private runs need final CLI destinations checked before Playwright's cleanup;
// globalSetup and test hooks run after it has already removed output folders.
const privatePaths =
  (process.env.OZ_PERF || process.env.H02_SESSION_PROBE === '1') &&
  process.env.OZ_PERF_HOLDER_STEP
    ? privateArtifactPaths(process.env.OZ_PERF_OUT, undefined, [
        process.env.OZ_PERF_HOLDER_STEP
      ])
    : undefined;
const privateOutput = privatePaths
  ? privatePlaywrightOutput(
      privatePaths,
      process.argv.slice(2),
      process.env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE
    )
  : undefined;
if (privatePaths) {
  process.env.OZ_PERF_HOLDER_STEP = privatePaths.inputs[0]!;
  process.env.OZ_PERF_OUT = privatePaths.output;
}

// Each checkout derives its own stable port from its path, so concurrent e2e
// runs in different worktrees never reuse (or tear down) each other's preview
// servers. Set PLAYWRIGHT_PORT to pin a specific port instead.
function portForCheckout(): number {
  const envPort = Number(process.env.PLAYWRIGHT_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536)
    return envPort;
  const digest = createHash('sha256').update(process.cwd()).digest();
  return 20000 + (digest.readUInt32BE(0) % 10000);
}

const PORT = portForCheckout();

// Performance probes and documentation captures build the production
// renderer, and never reuse a server that may hold the cheaper e2e one.
const FULL_RENDER_BUILD = fullRenderBuild();

export default defineConfig({
  ...(privateOutput ? { outputDir: privateOutput } : {}),
  testDir: './test/e2e',
  // Playwright's default also collects `*.test.ts` and `*.spec.tsx`, which
  // `scripts/e2e-shards.mjs` would not assign to a CI shard (and a `.test.ts`
  // here is already a root Vitest file). Pinning the pattern keeps the two
  // in step by construction; `test/e2e-shards.test.ts` checks this line.
  testMatch: '**/*.spec.ts',
  // Tests in one file run on different workers, so a long file such as
  // modeling.spec.ts (53 tests) does not serialise a CI shard onto one
  // worker. CI assigns whole files to shards by recorded duration through
  // `scripts/e2e-shards.mjs`; this keeps each shard's own workers busy. Tests
  // already run in isolated browser contexts; nothing in the suite depends
  // on in-file order.
  fullyParallel: true,
  // The default scales with the host CPU count, even when a self-hosted slot
  // has a smaller CPU budget. Match the two-worker hosted baseline so browser
  // and geometry workers do not crowd each other into the test deadline.
  workers: process.env.CI ? 2 : undefined,
  // Playwright's focus is run-wide, not file-wide, so one `test.only` left in a
  // push turns the CI shard holding it into a single executed test: the other
  // shards run zero, every shard exits 0, and the `e2e` aggregate — documented
  // below as the one stable context a human is meant to trust — prints green
  // having exercised that single test. Root Vitest gets this for free
  // (`allowOnly` defaults to `!CI`); Playwright does not.
  forbidOnly: !!process.env.CI,
  // GitHub-hosted runners are much slower than the previous CI hardware: cold
  // Chromium, IndexedDB, and geometry-worker starts can eat most of the 30 s
  // default test budget on a 2-core machine. Give CI runs more room and one
  // retry so a slow cold start does not fail an otherwise green suite.
  timeout: process.env.CI ? 90_000 : 30_000,
  retries: process.env.CI ? 2 : 0,
  // CI shards the suite across four 2-core runners, where repeated Chromium,
  // IndexedDB, and geometry-worker cold starts can cross Playwright's 5 s
  // assertion default. Product timing probes keep their own strict budgets;
  // this only gives readiness assertions the same allowance already used by
  // the focused cold-restore coverage.
  expect: {
    timeout: process.env.CI ? 30_000 : 5_000
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Playwright's default emulation prefers LIGHT, and the theme setting's
    // 'system' default follows it — so without this pin the whole suite would
    // silently run the light chrome. The suite's baseline is the product's
    // dark default; theme switching has its own coverage in settings.spec.ts,
    // which emulates both preferences explicitly.
    colorScheme: 'dark'
  },
  webServer: {
    command: `VITE_E2E=1${FULL_RENDER_BUILD ? ' VITE_E2E_FULL_RENDER=1' : ''} pnpm --filter @openzcad/web build && pnpm --filter @openzcad/web preview --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI && !FULL_RENDER_BUILD,
    timeout: 120_000
  }
});
