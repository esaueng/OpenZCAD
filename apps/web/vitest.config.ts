import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: [fileURLToPath(new URL('./src/test/setup.ts', import.meta.url))]
  }
});
