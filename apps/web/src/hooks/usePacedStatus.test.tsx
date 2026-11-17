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

  it('replaces an obsolete tool state immediately and never replays its pending message', () => {
    const { result, rerender } = renderHook(
      ({ status, immediate }) =>
        usePacedStatus<Tone>(status, 'ready', true, undefined, immediate),
      { initialProps: { status: 'Note placement started.', immediate: false } }
    );
    rerender({ status: 'Drawing updated.', immediate: false });
    expect(result.current.status).toBe('Note placement started.');
    rerender({
      status: 'Placement canceled. Drawing properties opened.',
      immediate: true
    });
    expect(result.current.status).toBe(
      'Placement canceled. Drawing properties opened.'
    );
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
    });
    expect(result.current.status).toBe(
      'Placement canceled. Drawing properties opened.'
    );
    rerender({ status: 'Note added.', immediate: true });
    expect(result.current.status).toBe('Note added.');
  });

  describe('settle (#1632)', () => {
    const PHASE = ' · Rebuilding geometry…';
    // What the readout passes: a shown line with a phase settles to its
    // message once the model is ready.
    const settle = (shown: string, next: string) => {
      if (!shown.endsWith(PHASE)) return null;
      const message = shown.slice(0, -PHASE.length);
      return message === next ? next : message;
    };
    const render = (status: string) =>
      renderHook(
        ({ status }) =>
          usePacedStatus<Tone>(status, 'ready', true, undefined, false, settle),
        { initialProps: { status } }
      );

    it('retires the phase at once, inside the dwell already begun', () => {
      const { result, rerender } = render(`Added box.${PHASE}`);
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      rerender({ status: 'Added box.' });
      expect(result.current.status).toBe('Added box.');
      // The dwell did not restart: the next message waits only 100 ms more.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      rerender({ status: 'Added cylinder.' });
      expect(result.current.status).toBe('Added box.');
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(result.current.status).toBe('Added cylinder.');
    });

    it('drops the phase while a newer message waits its turn', () => {
      const { result, rerender } = render(`Added box.${PHASE}`);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      rerender({ status: 'Added cylinder.' });
      expect(result.current.status).toBe('Added box.');
      act(() => {
        vi.advanceTimersByTime(STATUS_MIN_DWELL_MS - 200);
      });
      expect(result.current.status).toBe('Added cylinder.');
    });

    it('paces as usual when the shown line has no phase', () => {
      const { result, rerender } = render('Added box.');
      rerender({ status: 'Added cylinder.' });
      expect(result.current.status).toBe('Added box.');
    });
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

  it('counts the passed-over messages its predicate calls notable', () => {
    const { result, rerender } = renderHook(
      ({ status, tone }: { status: string; tone: Tone }) =>
        usePacedStatus<Tone>(
          status,
          tone,
          true,
          (_status, candidate) => candidate === 'warning'
        ),
      { initialProps: { status: 'Opened Bracket.', tone: 'ready' as Tone } }
    );
    rerender({ status: 'Rebuilding', tone: 'running' });
    rerender({ status: 'Fillet failed: radius too large', tone: 'warning' });
    rerender({ status: 'Measuring', tone: 'running' });
    rerender({ status: 'Ready', tone: 'ready' });
    act(() => {
      vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
    });
    expect(result.current).toEqual({
      status: 'Ready',
      tone: 'ready',
      skipped: 1
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
