import type {
  PatternOverlapReply,
  PatternOverlapRequest
} from './pattern-overlap-workers';
import type { RemusKernel } from 'remus-wasm';
import { MEASUREMENT_DEFLECTION } from './measurement-deflection';

// Install the listener before awaiting WASM so the first request is retained.
const bindings = import('remus-wasm');
self.onmessage = async ({ data }: MessageEvent<PatternOverlapRequest>) => {
  let kernel: RemusKernel | undefined;
  try {
    const { RemusKernel } = await bindings;
    const volumes: (number | null)[] = [];
    if (data.pairs.length) {
      kernel = new RemusKernel();
      for (const pair of data.pairs) {
        try {
          const [left, right] = kernel.deserializeSolids(pair);
          const result = kernel.booleanWithQuality(
            'intersect',
            left!,
            right!,
            true
          );
          volumes.push(
            result.quality === 'exact'
              ? kernel.volume(result.solid, MEASUREMENT_DEFLECTION)
              : null
          );
        } catch {
          // A refused exact intersection is retried with the live kernel's
          // existing union/volume fallback. The other pairs are independent.
          volumes.push(null);
        }
      }
    }
    self.postMessage({ volumes } satisfies PatternOverlapReply);
  } catch {
    self.postMessage({ volumes: null } satisfies PatternOverlapReply);
  } finally {
    kernel?.free();
  }
};
