import { createHash } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// Each checkout derives its own stable port from its path, so concurrent e2e
// runs in different worktrees never reuse (or tear down) each other's preview
// servers. Set PLAYWRIGHT_PORT to pin a specific port instead.
function portForCheckout(): number {
  const envPort = Number(process.env.PLAYWRIGHT_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) return envPort;
  const digest = createHash('sha256').update(process.cwd()).digest();
  return 20000 + (digest.readUInt32BE(0) % 10000);
}

const PORT = portForCheckout();

export default defineConfig({
  testDir: './test/e2e',
  // Without this, CI's four-way shard split allocates whole files, and the
  // suite's sizes make that allocation the wall clock: one run landed
  // 80/13/57/20 tests per shard with modeling.spec.ts alone at 7.3 minutes,
  // so the slowest shard ran six times longer than the fastest. Per-test
  // allocation keeps the shards near even. Tests already run in isolated
  // browser contexts; nothing in the suite depends on in-file order.
  fullyParallel: true,
  // Playwright's focus is run-wide, not file-wide, so one `test.only` left in a
  // push turns all four CI shards into a single executed test: three run zero,
  // every shard exits 0, and the `e2e` aggregate — documented below as the one
  // stable context a human is meant to trust — prints green having exercised
  // that single test. Root Vitest gets this for free (`allowOnly` defaults to
  // `!CI`); Playwright does not.
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
    command: `VITE_E2E=1 pnpm --filter @openzcad/web build && pnpm --filter @openzcad/web preview --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
