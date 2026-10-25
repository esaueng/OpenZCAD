import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettledFlag } from './useSettledFlag';

describe('useSettledFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never shows a flag that clears before the delay', () => {
    const { result, rerender } = renderHook(
      ({ flag }) => useSettledFlag(flag, 400),
      { initialProps: { flag: false } }
    );
    rerender({ flag: true });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    rerender({ flag: false });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(false);
  });

  it('shows a flag that holds past the delay, and drops it at once', () => {
    const { result, rerender } = renderHook(
      ({ flag }) => useSettledFlag(flag, 400),
      { initialProps: { flag: true } }
    );
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe(true);
    rerender({ flag: false });
    expect(result.current).toBe(false);
  });

  it('starts the delay over when the flag comes back', () => {
    const { result, rerender } = renderHook(
      ({ flag }) => useSettledFlag(flag, 400),
      { initialProps: { flag: true } }
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender({ flag: false });
    rerender({ flag: true });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe(true);
  });
});
