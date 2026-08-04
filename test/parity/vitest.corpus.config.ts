/**
 * Vitest project for the STEP + geometry parity corpus.
 *
 * The corpus is a SEPARATE run from the root suite on purpose. Every corpus
 * file is imported through two WASM kernels, re-exported, and re-imported;
 * that is seconds of geometry per file, and the root suite already had to
 * bound its worker count once to stop kernel startup from becoming unrelated
 * five-second timeouts. Sharing a pool with the fast suites repeats that.
 *
 * The mechanism: corpus suites are named `*.spec.ts`, and the root config's
 * `include` only matches `*.test.ts`. So the root run never picks them up, and
 * this config includes nothing else. Keep that invariant when adding files —
 * a corpus suite named `.test.ts` silently joins the default pool.
 *
 *   pnpm test:parity-corpus
 *   OPENZCAD_WRITE_PARITY_BASELINES=1 pnpm test:parity-corpus
 *
 * The workspace aliases are rebuilt here from `packages/*` rather than
 * imported from `../../vitest.config.ts`. Importing it would pull the root
 * config into the typecheck program, which `tsconfig.json` deliberately scopes
 * to `apps packages test types`. Discovering the packages from disk keeps this
 * in step with the root config without duplicating its list.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const REPO_ROOT = new URL('../../', import.meta.url);

const workspaceAliases = Object.fromEntries(
  readdirSync(fileURLToPath(new URL('packages', REPO_ROOT)), {
    withFileTypes: true
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [
      `@openzcad/${entry.name}`,
      fileURLToPath(new URL(`packages/${entry.name}/src/index.ts`, REPO_ROOT))
    ])
);

/** Same kernel overlay as the root config: swap in a local brepkit build. */
const brepkitOverlay: Record<string, string> = process.env.BREPKIT_WASM_PKG
  ? { 'brepkit-wasm': `${process.env.BREPKIT_WASM_PKG}/brepkit_wasm.js` }
  : {};

export default defineConfig({
  test: {
    root: fileURLToPath(REPO_ROOT),
    environment: 'node',
    include: ['test/parity/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    // One worker: two kernel WASM instances per file is already the memory
    // ceiling worth spending, and the corpus is measurement, not throughput.
    maxWorkers: 1,
    fileParallelism: false,
    // Import + re-export + re-import of the 841 KB bracket sample through OCCT
    // is several seconds; the whole corpus is measured in one `beforeAll`.
    testTimeout: 120_000,
    hookTimeout: 900_000
  },
  resolve: {
    alias: {
      ...brepkitOverlay,
      '@openzcad/kernel-adapter/exact': fileURLToPath(
        new URL('packages/kernel-adapter/src/exact.ts', REPO_ROOT)
      ),
      ...workspaceAliases,
      'cloudflare:workers': fileURLToPath(
        new URL('test/cloudflare-workers.mock.ts', REPO_ROOT)
      )
    }
  }
});
