import { describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  lazyWithReload,
  reloadForStaleChunk
} from './lazyWithReload';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    }
  };
}

describe('stale chunk recovery', () => {
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

  it('reloads once, then lets a repeat failure through to the boundary', () => {
    const reload = vi.fn();
    let now = 1_000;
    const host = { storage: memoryStorage(), reload, now: () => now };
    expect(reloadForStaleChunk(host)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    now += 5_000;
    expect(reloadForStaleChunk(host)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    now += 120_000;
    expect(reloadForStaleChunk(host)).toBe(true);
  });

  it('keeps the lazy import pending while the reload is in flight', async () => {
    const reload = vi.fn();
    const host = { storage: memoryStorage(), reload, now: () => 0 };
    const factory = vi.fn(() =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: x.js')
      )
    );
    const Lazy = lazyWithReload(factory, host);
    // React.lazy stores the loader on the exotic component; calling it is
    // what the first render would do.
    const payload = (
      Lazy as unknown as { _payload: { _result: () => Promise<unknown> } }
    )._payload;
    let settled = false;
    void payload._result().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });

  it('rethrows an ordinary import error so the boundary can show it', async () => {
    const host = { storage: memoryStorage(), reload: vi.fn(), now: () => 0 };
    const Lazy = lazyWithReload(
      () => Promise.reject(new Error('module threw during evaluation')),
      host
    );
    const payload = (
      Lazy as unknown as { _payload: { _result: () => Promise<unknown> } }
    )._payload;
    await expect(payload._result()).rejects.toThrow(
      'module threw during evaluation'
    );
    expect(host.reload).not.toHaveBeenCalled();
  });
});
