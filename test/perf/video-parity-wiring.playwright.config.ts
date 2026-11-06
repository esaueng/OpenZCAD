import { defineConfig } from '@playwright/test';
import baseline from './video-parity.playwright.config';

export default defineConfig({
  ...baseline,
  testMatch: [
    'direct-edit-parity-wiring.spec.ts',
    'visual-selection-fillet-edit.spec.ts'
  ],
  outputDir: '../../artifacts/video-parity-phase3/wiring-playwright',
  timeout: 180_000
});
