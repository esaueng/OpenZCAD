import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../e2e',
  testMatch: 'video-parity-baseline.spec.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: '../../artifacts/video-parity/playwright',
  reporter: [['list']],
  use: {
    actionTimeout: 10_000,
    baseURL: process.env.VIDEO_PARITY_URL ?? 'http://127.0.0.1:25349',
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    trace: 'retain-on-failure'
  }
});
