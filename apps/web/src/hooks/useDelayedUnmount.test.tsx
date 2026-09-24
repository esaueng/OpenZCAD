import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedUnmount } from './useDelayedUnmount';

/** Widens the initial value so a later rerender may pass null. */
const props = <T,>(value: T | null): { value: T | null } => ({ value });

describe('useDelayedUnmount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the last value through the exit, then drops it', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDelayedUnmount(value, 100),
      { initialProps: props<{ label: string }>({ label: 'Top face' }) }
    );
    expect(result.current).toEqual({
      rendered: { label: 'Top face' },
      closing: false
    });

    rerender({ value: null });
    expect(result.current).toEqual({
      rendered: { label: 'Top face' },
      closing: true
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toEqual({ rendered: null, closing: false });
  });

  it('renders the newest value as it changes, without extra renders', () => {
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ value }) => {
        renders += 1;
        return useDelayedUnmount(value, 100);
      },
      { initialProps: props<{ label: string }>({ label: 'a' }) }
    );
    const before = renders;
    // A fresh object with the same meaning, as App passes on every render.
    rerender({ value: { label: 'b' } });
    expect(result.current.rendered).toEqual({ label: 'b' });
    expect(renders - before).toBe(1);
  });

  it('cancels the exit when the value comes back mid-fade', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDelayedUnmount(value, 100),
      { initialProps: props<string>('first') }
    );
    rerender({ value: null });
    expect(result.current.closing).toBe(true);
    rerender({ value: 'second' });
    expect(result.current).toEqual({ rendered: 'second', closing: false });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toEqual({ rendered: 'second', closing: false });
  });

  it('never shows an exit for a value that was never there', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDelayedUnmount(value, 100),
      { initialProps: props<string>(null) }
    );
    rerender({ value: null });
    expect(result.current).toEqual({ rendered: null, closing: false });
  });
});
