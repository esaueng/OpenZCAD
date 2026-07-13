import { defineConfig } from '@playwright/test';

// Dedicated port so the suite never collides with (or reuses) an unrelated
// dev/preview server from another checkout.
const PORT = 4319;

export default defineConfig({
  testDir: './test/e2e',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`
  },
  webServer: {
    command: `pnpm --filter @openzcad/web build && pnpm --filter @openzcad/web preview --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
