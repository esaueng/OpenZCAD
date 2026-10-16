/** Benchmark build only. Normal Vite builds never alias this module. */
export * from '../../packages/kernel-adapter/src/exact';
import {
  createExactKernelAdapter as create,
  type ExactKernelAdapterOptions
} from '../../packages/kernel-adapter/src/exact';

declare const __H02_CACHE_MODE__: 'disabled' | 'enabled';

export function createExactKernelAdapter(
  options: ExactKernelAdapterOptions = {}
) {
  console.debug('[H02 cache mode]', __H02_CACHE_MODE__);
  return create({
    ...options,
    measurementCacheDiagnostics: true,
    ...(__H02_CACHE_MODE__ === 'disabled'
      ? {
          historyCheckpointLimit: 0,
          measuredShapeCacheBytes: 0,
          importedStepCacheBytes: 0
        }
      : {})
  });
}
