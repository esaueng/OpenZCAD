/** Build the real production app with only a benchmark adapter-options seam. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import webConfig from '../../apps/web/vite.config';

export default async (...args: Parameters<typeof webConfig>) => {
  const mode = process.env.H02_CACHE_MODE;
  if (mode !== 'disabled' && mode !== 'enabled')
    throw new Error('H02_CACHE_MODE must be disabled or enabled.');
  if (process.env.VITE_E2E !== '1')
    throw new Error('H02 benchmark builds require VITE_E2E=1.');
  if (!process.env.OZ_PERF_OUT)
    throw new Error('Set OZ_PERF_OUT for an isolated benchmark build.');
  const config = await webConfig(...args);
  return {
    ...config,
    build: {
      ...config.build,
      outDir: resolve(dirname(process.env.OZ_PERF_OUT), `h02-build-${mode}`)
    },
    define: { ...config.define, __H02_CACHE_MODE__: JSON.stringify(mode) },
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@openzcad/kernel-adapter/exact': fileURLToPath(
          new URL('./h02-browser-exact.ts', import.meta.url)
        )
      }
    }
  };
};
