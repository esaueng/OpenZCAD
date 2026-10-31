import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { unitTestInclude } from '../../scripts/unit-suites.mjs';

export default defineConfig({
  test: {
    ...(unitTestInclude('web') ? { include: unitTestInclude('web') } : {}),
    environment: 'happy-dom',
    setupFiles: [fileURLToPath(new URL('./src/test/setup.ts', import.meta.url))]
  }
});
