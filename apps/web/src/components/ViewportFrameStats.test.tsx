import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameStatsSink } from '../lib/frameStats';
import {
  FRAME_STATS_PANEL_STORAGE_KEY,
  FRAME_STATS_REPAINT_MS,
  ViewportFrameStats,
  frameStatsFields
} from './ViewportFrameStats';

function field(name: string): string | null {
  return document.querySelector(`[data-field="${name}"]`)?.textContent ?? null;
}

describe('ViewportFrameStats', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.removeItem(FRAME_STATS_PANEL_STORAGE_KEY);
  });

  it('reads the viewer’s frames and repaints without React renders', () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<FrameStatsSink | null> = { current: null };
    const view = render(<ViewportFrameStats sinkRef={sinkRef} />);
    const overlay = screen.getByRole('status', { name: 'Frame rate' });
    expect(field('rate')).toBe('idle');
    expect(sinkRef.current).toBeTypeOf('function');

    const now = performance.now();
    for (let index = 0; index < 30; index += 1) {
      sinkRef.current!({
        at: now - (29 - index) * 20,
        renderMs: 1.25,
        cpuMs: 4.5,
        drawCalls: 9,
        triangles: 7_900
      });
    }
    act(() => {
      vi.advanceTimersByTime(FRAME_STATS_REPAINT_MS);
    });
    expect(field('rate')).toBe('50');
    expect(field('frame')).toBe('20.0 ms');
    expect(field('average')).toBe('50');
    expect(field('low1')).toBe('50');
    expect(field('cpu')).toBe('1.25 ms');
    expect(field('cpuFrame')).toBe('4.50 ms');
    expect(field('load')).toBe('9 · 7.9k');
    expect(field('frames')).toBe('29');
    expect(overlay).not.toHaveAttribute('data-idle');

    // Turning the overlay off hands the viewer nothing to call.
    view.unmount();
    expect(sinkRef.current).toBeNull();
  });

  it('folds to its top row and remembers the fold', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<FrameStatsSink | null> = { current: null };
    const view = render(<ViewportFrameStats sinkRef={sinkRef} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse frame rate panel' })
    );
    const overlay = screen.getByRole('status', { name: 'Frame rate' });
    expect(overlay).toHaveAttribute('data-collapsed');
    expect(
      JSON.parse(window.localStorage.getItem(FRAME_STATS_PANEL_STORAGE_KEY)!)
    ).toMatchObject({ collapsed: true });
    view.unmount();

    render(<ViewportFrameStats sinkRef={sinkRef} />);
    expect(
      screen.getByRole('button', { name: 'Expand frame rate panel' })
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps numeric text nodes stable while the live values change', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<FrameStatsSink | null> = { current: null };
    render(<ViewportFrameStats sinkRef={sinkRef} />);
    const overlay = screen.getByRole('status', { name: 'Frame rate' });
    const cpu = overlay.querySelector('[data-field="cpu"]')!;
    const rate = overlay.querySelector('[data-field="rate"]')!;
    const cpuText = cpu.firstChild;
    const rateText = rate.firstChild;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) =>
      mutations.push(...records)
    );
    observer.observe(overlay, {
      subtree: true,
      childList: true,
      characterData: true
    });
    sinkRef.current!({
      at: performance.now(),
      renderMs: 2,
      cpuMs: 5,
      drawCalls: 9,
      triangles: 100
    });
    sinkRef.current!({
      at: performance.now() + 16,
      renderMs: 2,
      cpuMs: 5,
      drawCalls: 9,
      triangles: 100
    });
    await act(async () => {
      vi.advanceTimersByTime(FRAME_STATS_REPAINT_MS);
    });
    expect(field('cpu')).toBe('2.00 ms');
    expect(field('rate')).not.toBe('idle');
    expect(cpu.firstChild).toBe(cpuText);
    expect(rate.firstChild).toBe(rateText);
    expect(mutations.some((record) => record.type === 'characterData')).toBe(
      true
    );
    expect(mutations.filter((record) => record.type === 'childList')).toEqual(
      []
    );
    observer.disconnect();
  });

  it('finishes graph layout and font resolution before changing readout text', () => {
    vi.useFakeTimers();
    const readoutsDuringGraph: (string | null)[] = [];
    const context = new Proxy(
      {},
      {
        get: () => () => undefined,
        set: (_target, key) => {
          if (key === 'font') readoutsDuringGraph.push(field('cpu'));
          return true;
        }
      }
    ) as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context
    );
    const sinkRef: MutableRefObject<FrameStatsSink | null> = { current: null };
    render(<ViewportFrameStats sinkRef={sinkRef} />);
    // happy-dom has no layout; make only these graphs participate in it.
    for (const canvas of document.querySelectorAll(
      '.viewport-frame-stats-graph'
    )) {
      Object.defineProperty(canvas, 'offsetParent', {
        get: () => document.body
      });
    }
    readoutsDuringGraph.length = 0;
    sinkRef.current!({
      at: performance.now(),
      renderMs: 2,
      cpuMs: 5,
      drawCalls: 9,
      triangles: 100
    });
    act(() => {
      vi.advanceTimersByTime(FRAME_STATS_REPAINT_MS);
    });
    expect(readoutsDuringGraph).toEqual(['– ms']);
    expect(field('cpu')).toBe('2.00 ms');
  });

  it('closes through the overlay setting, and offers no close without it', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<FrameStatsSink | null> = { current: null };
    const onClose = vi.fn();
    const view = render(
      <ViewportFrameStats sinkRef={sinkRef} onClose={onClose} />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Close frame rate panel' })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<ViewportFrameStats sinkRef={sinkRef} />);
    expect(
      screen.queryByRole('button', { name: 'Close frame rate panel' })
    ).toBeNull();
  });

  it('says idle rather than zero when nothing has been drawn', () => {
    expect(
      frameStatsFields(
        {
          idle: true,
          fps: null,
          frameMs: null,
          worstFrameMs: null,
          renderMs: null,
          cpuMs: null,
          drawCalls: null,
          triangles: null
        },
        {
          frames: 0,
          averageFps: null,
          low1Fps: null,
          low01Fps: null,
          minFps: null,
          p99FrameMs: null,
          worstFrameMs: null,
          hitches: 0
        }
      )
    ).toEqual({
      rate: 'idle',
      frame: '– ms',
      average: '–',
      low1: '–',
      low01: '–',
      min: '–',
      cpu: '– ms',
      cpuFrame: '– ms',
      worst: '– ms',
      p99: '– ms',
      hitches: '0',
      load: '– · –',
      frames: '0'
    });
  });
});
