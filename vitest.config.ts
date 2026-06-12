import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACE_PACKAGES = [
  'shared',
  'geometry',
  'document-core',
  'command-system',
  'kernel-adapter',
  'viewport',
  'io-step',
  'io-stl',
  'plugin-api',
  'jobs',
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
    setupFiles: ['test/setup.ts']
  },
  resolve: {
    alias: {
      ...workspaceAliases,
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers.mock.ts', import.meta.url)
      )
    }
  }
});
