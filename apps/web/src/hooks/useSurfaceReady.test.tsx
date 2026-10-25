import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSurfaceReady } from './useSurfaceReady';

function surfaceWith(load: () => Promise<void>) {
  let loaded = false;
  return {
    isLoaded: () => loaded,
    preload: () =>
      load().then(() => {
        loaded = true;
      })
  };
}

describe('useSurfaceReady', () => {
  it('holds a surface back until its chunk has loaded', async () => {
    let finish!: () => void;
    const surface = surfaceWith(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    const { result, rerender } = renderHook(
      ({ wanted }) => useSurfaceReady(surface, wanted),
      { initialProps: { wanted: false } }
    );
    expect(result.current).toBe(false);
    rerender({ wanted: true });
    expect(result.current).toBe(false);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
  });

  it('lets a surface whose load failed render, to report it', async () => {
    const surface = surfaceWith(() => Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useSurfaceReady(surface, true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
  });
});
