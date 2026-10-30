import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameStatsSink } from '../lib/frameStats';
import {
  FRAME_STATS_REPAINT_MS,
  ViewportFrameStats,
  frameStatsLines
} from './ViewportFrameStats';

describe('ViewportFrameStats', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads the viewer’s frames and repaints without React renders', () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<FrameStatsSink | null> = { current: null };
    const view = render(<ViewportFrameStats sinkRef={sinkRef} />);
    const overlay = screen.getByRole('status', { name: 'Frame rate' });
    expect(overlay).toHaveTextContent(/^idle/);
    expect(sinkRef.current).toBeTypeOf('function');

    const now = performance.now();
    for (let index = 0; index < 30; index += 1) {
      sinkRef.current!({
        at: now - (29 - index) * 20,
        renderMs: 1.25,
        drawCalls: 9,
        triangles: 7_900
      });
    }
    act(() => {
      vi.advanceTimersByTime(FRAME_STATS_REPAINT_MS);
    });
    expect(overlay).toHaveTextContent('50 fps');
    expect(overlay).toHaveTextContent('frame 20.0 ms · worst 20.0');
    expect(overlay).toHaveTextContent('cpu 1.25 ms');
    expect(overlay).toHaveTextContent('9 draws · 7.9k tris');
    expect(overlay).not.toHaveAttribute('data-idle');

    // Turning the overlay off hands the viewer nothing to call.
    view.unmount();
    expect(sinkRef.current).toBeNull();
  });

  it('says idle rather than zero when nothing has been drawn', () => {
    expect(
      frameStatsLines({
        idle: true,
        fps: null,
        frameMs: null,
        worstFrameMs: null,
        renderMs: null,
        drawCalls: null,
        triangles: null
      })
    ).toEqual(['idle', 'frame – ms · worst –', 'cpu – ms', '– draws · – tris']);
  });
});
