/** Build the real production app with only a benchmark adapter-options seam. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import webConfig from '../../apps/web/vite.config';
import { assertBenchmarkCheckout } from '../support/benchmarkCheckout';

export default async (...args: Parameters<typeof webConfig>) => {
  const mode = process.env.H02_CACHE_MODE;
  if (mode !== 'disabled' && mode !== 'enabled')
    throw new Error('H02_CACHE_MODE must be disabled or enabled.');
  if (process.env.VITE_E2E !== '1')
    throw new Error('H02 benchmark builds require VITE_E2E=1.');
  if (!process.env.OZ_PERF_OUT)
    throw new Error('Set OZ_PERF_OUT for an isolated benchmark build.');
  const checkout = {
    sourceCommit: process.env.H02_SOURCE_COMMIT ?? '',
    lockfileSha256: process.env.H02_LOCKFILE_SHA256 ?? ''
  };
  assertBenchmarkCheckout(checkout);
  const config = await webConfig(...args);
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      {
        name: 'h02-unchanged-source',
        closeBundle() {
          assertBenchmarkCheckout(checkout);
        }
      }
    ],
    build: {
      ...config.build,
      outDir: resolve(dirname(process.env.OZ_PERF_OUT), `h02-build-${mode}`)
    },
    define: { ...config.define, __H02_CACHE_MODE__: JSON.stringify(mode) },
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        ...(process.env.H02_SESSION_PROBE === '1'
          ? {
              './exactRebuildCache': fileURLToPath(
                new URL('./h02-session-rebuild-cache.ts', import.meta.url)
              )
            }
          : {}),
        '@openzcad/kernel-adapter/exact': fileURLToPath(
          new URL(
            process.env.H02_SESSION_PROBE === '1'
              ? './h02-session-exact.ts'
              : './h02-browser-exact.ts',
            import.meta.url
          )
        )
      }
    }
  };
};
