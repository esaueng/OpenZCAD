import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useArrivals } from './useArrivals';

describe('useArrivals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags nothing on the first render or when the list fills from empty', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useArrivals(ids, 900),
      { initialProps: { ids: [] as string[] } }
    );
    expect(result.current.size).toBe(0);

    rerender({ ids: ['a', 'b', 'c'] });
    expect(result.current.size).toBe(0);
  });

  it('flags only the ids that joined, and holds them through re-renders', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useArrivals(ids, 900),
      { initialProps: { ids: ['a', 'b'] } }
    );

    rerender({ ids: ['a', 'b', 'c'] });
    expect([...result.current]).toEqual(['c']);

    // The new feature gets selected: same ids, another render mid-animation.
    rerender({ ids: ['a', 'b', 'c'] });
    expect([...result.current]).toEqual(['c']);

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.size).toBe(0);
  });

  it('treats a reorder or a removal as no arrival', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useArrivals(ids, 900),
      { initialProps: { ids: ['a', 'b', 'c'] } }
    );
    rerender({ ids: ['c', 'a', 'b'] });
    expect(result.current.size).toBe(0);
    rerender({ ids: ['c', 'a'] });
    expect(result.current.size).toBe(0);
  });
});
