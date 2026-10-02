import { describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  lazyWithStaleChunkNotice,
  onStaleChunk,
  watchPreloadErrors
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

describe('preload errors', () => {
  it('reports a chunk the preload helper could not load, and only that', () => {
    const listener = vi.fn();
    const stopListening = onStaleChunk(listener);
    const stopWatching = watchPreloadErrors(window);
    const fire = (payload: unknown) => {
      const event = new Event('vite:preloadError', { cancelable: true });
      Object.assign(event, { payload });
      window.dispatchEvent(event);
      return event;
    };
    const event = fire(
      new TypeError(
        'Failed to fetch dynamically imported module: https://zcad.app/assets/demos-BLYQ4WoN.js'
      )
    );
    expect(listener).toHaveBeenCalledOnce();
    // The caller still gets its own rejection.
    expect(event.defaultPrevented).toBe(false);
    fire(new Error('Cannot read properties of null'));
    expect(listener).toHaveBeenCalledOnce();
    stopWatching();
    fire(new TypeError('Importing a module script failed.'));
    expect(listener).toHaveBeenCalledOnce();
    stopListening();
  });
});
