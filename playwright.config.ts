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
  use: {
    baseURL: `http://127.0.0.1:${PORT}`
  },
  webServer: {
    command: `VITE_E2E=1 pnpm --filter @openzcad/web build && pnpm --filter @openzcad/web preview --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
