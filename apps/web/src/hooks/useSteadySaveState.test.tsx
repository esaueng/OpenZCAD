import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { useSteadySaveState } from './useSteadySaveState';

function render(state: WorkspaceSaveState, projectId: string | null = 'p1') {
  return renderHook(
    ({ state, projectId }) => useSteadySaveState(state, projectId, 600),
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

  it('announces a save as soon as it starts', () => {
    const { result, rerender } = render('synced');
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('saving');
  });

  it('holds a brief save’s label, never showing it settled early', () => {
    const { result, rerender } = render('local');
    rerender({ state: 'saving', projectId: 'p1' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ state: 'local', projectId: 'p1' });
    expect(result.current).toBe('saving');
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBe('saving');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('local');
  });

  it('settles at once after a save that ran past the minimum', () => {
    const { result, rerender } = render('synced');
    rerender({ state: 'syncing', projectId: 'p1' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ state: 'synced', projectId: 'p1' });
    expect(result.current).toBe('synced');
  });

  it('keeps Syncing up through newer device writes', () => {
    const { result, rerender } = render('synced');
    rerender({ state: 'syncing', projectId: 'p1' });
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('syncing');
    rerender({ state: 'syncing', projectId: 'p1' });
    expect(result.current).toBe('syncing');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ state: 'synced', projectId: 'p1' });
    expect(result.current).toBe('synced');
    // The next save starts a new streak, from Saving.
    rerender({ state: 'saving', projectId: 'p1' });
    expect(result.current).toBe('saving');
  });

  it('shows failures and conflicts at once', () => {
    const { result, rerender } = render('synced');
    rerender({ state: 'saving', projectId: 'p1' });
    rerender({ state: 'device-failed', projectId: 'p1' });
    expect(result.current).toBe('device-failed');
    rerender({ state: 'conflict', projectId: 'p1' });
    expect(result.current).toBe('conflict');
  });

  it("does not carry one project's Syncing into the next project's save", () => {
    const { result, rerender } = render('synced', 'p1');
    rerender({ state: 'syncing', projectId: 'p1' });
    // Still in flight as the next project opens with its own device save.
    rerender({ state: 'saving', projectId: 'p2' });
    expect(result.current).toBe('saving');
  });

  it("does not hold one project's busy label over the next project", () => {
    const { result, rerender } = render('saving', 'p1');
    rerender({ state: 'synced', projectId: 'p2' });
    expect(result.current).toBe('synced');
  });
});
