import { defineConfig } from '@playwright/test';
import config from './playwright.config';

/** An explicit full run also works in shells where CI is already set. */
export default defineConfig({
  ...config,
  grep: undefined,
  metadata: { ...config.metadata, e2eSuite: 'full' }
});
