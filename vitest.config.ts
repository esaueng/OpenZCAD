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
  'io-shapr',
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

/**
 * Kernel overlay for the parity harness: point REMUS_WASM_PKG at a local
 * remus `crates/wasm/pkg` build to run every kernel test against it
 * without touching package.json or the lockfile. `remus-runtime.ts` is the
 * runtime seam, so one package alias swaps the kernel completely.
 */
const remusOverlay = process.env.REMUS_WASM_PKG
  ? { 'remus-wasm': process.env.REMUS_WASM_PKG }
  : {};

export default defineConfig({
  test: {
    environment: 'node',
    // Exact-kernel suites instantiate large OCCT/Remus WASM modules. Keep
    // file-level parallelism bounded so CI does not turn kernel startup into
    // unrelated five-second test timeouts under CPU and memory contention.
    maxWorkers: 4,
    // Package-owned tests live beside their source so they resolve that
    // package's own dependencies (`three` is not a root dependency).
    include: ['test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
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
      ...remusOverlay,
      '@openzcad/kernel-adapter/exact': fileURLToPath(
        new URL('./packages/kernel-adapter/src/exact.ts', import.meta.url)
      ),
      '@openzcad/ai-contracts/auto-parameterize': fileURLToPath(
        new URL(
          './packages/ai-contracts/src/auto-parameterize.ts',
          import.meta.url
        )
      ),
      ...workspaceAliases,
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers.mock.ts', import.meta.url)
      )
    }
  }
});
