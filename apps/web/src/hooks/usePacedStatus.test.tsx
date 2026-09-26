import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_MIN_DWELL_MS, usePacedStatus } from './usePacedStatus';

type Tone = 'ready' | 'warning' | 'running';

const props = (status: string, tone: Tone = 'ready', live = true) => ({
  status,
  tone,
  live
});

function renderPaced(initial = props('Opened Bracket.')) {
  return renderHook(
    ({ status, tone, live }) => usePacedStatus<Tone>(status, tone, live),
    { initialProps: initial }
  );
}

describe('usePacedStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a message at once when the last one has had its dwell', () => {
    const { result, rerender } = renderPaced();
    expect(result.current).toEqual({
      status: 'Opened Bracket.',
      tone: 'ready',
      skipped: 0
    });
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
    });
    rerender(props('Fillet added'));
    expect(result.current.status).toBe('Fillet added');
  });

  it('collapses a burst to its latest message and counts what it passed over', () => {
    const { result, rerender } = renderPaced(props('Rebuilding', 'running'));
    // Ten messages inside one dwell: the first stays readable.
    for (let index = 1; index <= 10; index += 1) {
      act(() => {
        vi.advanceTimersByTime(50);
      });
      rerender(props(`Step ${index}`, 'running'));
      expect(result.current.status).toBe('Rebuilding');
    }
    rerender(props('Reopened Gentle Duckling.', 'ready'));
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
    });
    expect(result.current).toEqual({
      status: 'Reopened Gentle Duckling.',
      tone: 'ready',
      skipped: 10
    });
    // The next message after a quiet dwell starts a fresh count.
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
    });
    rerender(props('Saved'));
    expect(result.current).toEqual({
      status: 'Saved',
      tone: 'ready',
      skipped: 0
    });
  });

  it('holds each message for the dwell even when the burst keeps going', () => {
    const { result, rerender } = renderPaced(props('First'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(props('Second'));
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS - 100);
    });
    expect(result.current.status).toBe('Second');
    rerender(props('Third'));
    expect(result.current.status).toBe('Second');
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
    });
    expect(result.current.status).toBe('Third');
  });

  it('never lets a hidden toast hold back or stand in for the next message', () => {
    const { result, rerender } = renderPaced(props('Fillet added'));
    // Retired or muted within the dwell: nothing on screen to protect.
    rerender(props('Fillet added', 'ready', false));
    rerender(props('Chamfer added', 'ready', false));
    expect(result.current.status).toBe('Chamfer added');
    rerender(props('Shell added', 'ready', true));
    expect(result.current).toEqual({
      status: 'Shell added',
      tone: 'ready',
      skipped: 0
    });
  });
});
