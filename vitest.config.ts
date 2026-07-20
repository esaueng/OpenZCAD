import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACE_PACKAGES = [
  'shared',
  'geometry',
  'document-core',
  'command-system',
  'kernel-adapter',
  'ai-contracts',
  'viewport',
  'io-step',
  'io-stl',
  'persistence',
  'cloudflare-adapters'
] as const;

const workspaceAliases = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [
    `@openzcad/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))
  ])
);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'packages/*/src/**/*.ts',
        'apps/web/worker/**/*.ts',
        'apps/web/src/lib/**/*.ts'
      ],
      exclude: ['**/*.test.ts', '**/dist/**']
    }
  },
  resolve: {
    alias: {
      '@openzcad/kernel-adapter/exact': fileURLToPath(
        new URL('./packages/kernel-adapter/src/exact.ts', import.meta.url)
      ),
      ...workspaceAliases,
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers.mock.ts', import.meta.url)
      )
    }
  }
});
