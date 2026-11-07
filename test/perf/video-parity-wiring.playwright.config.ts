import { defineConfig } from '@playwright/test';
import baseline from './video-parity.playwright.config';
import { resolve } from 'node:path';

export default defineConfig({
  ...baseline,
  testMatch: [
    'direct-edit-parity-wiring.spec.ts',
    'visual-selection-fillet-edit.spec.ts'
  ],
  outputDir: process.env.VIDEO_PARITY_OUT
    ? resolve(process.env.VIDEO_PARITY_OUT, 'playwright')
    : '../../artifacts/video-parity-phase3/wiring-playwright',
  timeout: 180_000
});
