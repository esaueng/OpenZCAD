import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { useSteadySaveState } from './useSteadySaveState';

function render(state: WorkspaceSaveState, projectId: string | null = 'p1') {
  return renderHook(
    ({ state, projectId }) => useSteadySaveState(state, projectId, 700),
    { initialProps: { state, projectId } }
  );
}

describe('useSteadySaveState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never announces a save that finishes quickly', () => {
    const { result, rerender } = render('synced');
    expect(result.current).toBe('synced');
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('synced');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ state: 'syncing', projectId: 'p1' });
    expect(result.current).toBe('synced');
    rerender({ state: 'synced', projectId: 'p1' });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe('synced');
  });

  it('announces a save that runs past the delay', () => {
    const { result, rerender } = render('local');
    rerender({ state: 'saving', projectId: 'p1' });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe('saving');
    rerender({ state: 'local', projectId: 'p1' });
    expect(result.current).toBe('local');
  });

  it('keeps Syncing up through newer device writes', () => {
    const { result, rerender } = render('synced');
    rerender({ state: 'syncing', projectId: 'p1' });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe('syncing');
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('syncing');
    rerender({ state: 'syncing', projectId: 'p1' });
    expect(result.current).toBe('syncing');
    rerender({ state: 'synced', projectId: 'p1' });
    expect(result.current).toBe('synced');
    // The next save starts over: a quick one is not announced.
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('synced');
  });

  it('shows failures and conflicts at once', () => {
    const { result, rerender } = render('synced');
    rerender({ state: 'saving', projectId: 'p1' });
    rerender({ state: 'device-failed', projectId: 'p1' });
    expect(result.current).toBe('device-failed');
    rerender({ state: 'conflict', projectId: 'p1' });
    expect(result.current).toBe('conflict');
  });

  it("does not hold another project's settled state", () => {
    const { result, rerender } = render('synced', 'p1');
    rerender({ state: 'saving', projectId: 'p2' });
    expect(result.current).toBe('saving');
  });

  it('does not hold a reopened project’s state from its last opening', () => {
    const { result, rerender } = render('synced', 'p1');
    rerender({ state: 'synced', projectId: null });
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('saving');
  });

  it('shows the first state of a mount as it is', () => {
    const { result } = render('saving');
    expect(result.current).toBe('saving');
  });
});
