import { describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  lazyWithStaleChunkNotice,
  onStaleChunk
} from './staleChunk';

function loaderOf(component: unknown): () => Promise<unknown> {
  // React.lazy stores the loader on the exotic component; calling it is what
  // the first render would do.
  return (component as { _payload: { _result: () => Promise<unknown> } })
    ._payload._result;
}

describe('stale chunk handling', () => {
  it('recognises the chunk-load failures browsers raise after a deploy', () => {
    expect(
      isChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://zcad.app/assets/ModelingOperationsForm-BjEcM817.js'
        )
      )
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError('Importing a module script failed.'))
    ).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of null'))).toBe(
      false
    );
  });

  it('tells subscribers about a missing chunk and still rejects the import', async () => {
    const listener = vi.fn();
    const stop = onStaleChunk(listener);
    const Lazy = lazyWithStaleChunkNotice(() =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: x.js')
      )
    );
    await expect(loaderOf(Lazy)()).rejects.toThrow('dynamically imported');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stays quiet for an ordinary import error', async () => {
    const listener = vi.fn();
    const stop = onStaleChunk(listener);
    const Lazy = lazyWithStaleChunkNotice(() =>
      Promise.reject(new Error('module threw during evaluation'))
    );
    await expect(loaderOf(Lazy)()).rejects.toThrow('module threw');
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
