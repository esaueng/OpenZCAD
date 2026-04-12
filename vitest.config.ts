import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts']
  },
  resolve: {
    alias: {
      '@openzcad/shared': '/packages/shared/src/index.ts',
      '@openzcad/document-core': '/packages/document-core/src/index.ts',
      '@openzcad/command-system': '/packages/command-system/src/index.ts',
      '@openzcad/kernel-adapter': '/packages/kernel-adapter/src/index.ts',
      '@openzcad/viewport': '/packages/viewport/src/index.ts',
      '@openzcad/io-step': '/packages/io-step/src/index.ts',
      '@openzcad/io-stl': '/packages/io-stl/src/index.ts',
      '@openzcad/plugin-api': '/packages/plugin-api/src/index.ts',
      '@openzcad/jobs': '/packages/jobs/src/index.ts',
      '@openzcad/persistence': '/packages/persistence/src/index.ts',
      '@openzcad/cloudflare-adapters': '/packages/cloudflare-adapters/src/index.ts',
      'cloudflare:workers': '/test/cloudflare-workers.mock.ts'
    }
  }
});
