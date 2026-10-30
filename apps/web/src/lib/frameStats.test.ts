import { describe, expect, it } from 'vitest';
import {
  BURST_GAP_MS,
  FRAME_WINDOW_MS,
  FrameStatsMeter,
  HISTORY_LENGTH,
  IDLE_AFTER_MS,
  formatCount
} from './frameStats';

function frames(
  meter: FrameStatsMeter,
  start: number,
  count: number,
  intervalMs: number
): number {
  let at = start;
  for (let index = 0; index < count; index += 1) {
    meter.record({ at, renderMs: 0.5, drawCalls: 12, triangles: 48_000 });
    at += intervalMs;
  }
  return at - intervalMs;
}

describe('FrameStatsMeter', () => {
  it('reports the frame rate of a steady 60 Hz gesture', () => {
    const meter = new FrameStatsMeter();
    const last = frames(meter, 0, 60, 1_000 / 60);
    const summary = meter.summarize(last);
    expect(summary.idle).toBe(false);
    expect(summary.fps).toBeCloseTo(60, 5);
    expect(summary.frameMs).toBeCloseTo(16.667, 2);
    expect(summary.worstFrameMs).toBeCloseTo(16.667, 2);
    expect(summary.renderMs).toBeCloseTo(0.5, 5);
    expect(summary.drawCalls).toBe(12);
    expect(summary.triangles).toBe(48_000);
  });

  it('names the hitch: the worst gap, not just the mean', () => {
    const meter = new FrameStatsMeter();
    const last = frames(meter, 0, 30, 16);
    meter.record({ at: last + 120, renderMs: 0.5, drawCalls: 1, triangles: 1 });
    const summary = meter.summarize(last + 120);
    expect(summary.worstFrameMs).toBe(120);
    expect(summary.fps).toBeLessThan(1_000 / 16);
  });

  /**
   * The viewer renders on demand: between two gestures it draws nothing.
   * That rest is not a slow frame, and a still scene is idle, not 0 fps.
   */
  it('does not count rest between gestures as a slow frame', () => {
    const meter = new FrameStatsMeter();
    const first = frames(meter, 0, 10, 16);
    const second = frames(meter, first + BURST_GAP_MS + 100, 10, 16);
    const summary = meter.summarize(second);
    expect(summary.worstFrameMs).toBe(16);
    expect(summary.fps).toBeCloseTo(62.5, 5);
    expect(meter.history.filter((value) => value === null)).toHaveLength(2);
  });

  it('reads idle once the viewer stops drawing, keeping the last load', () => {
    const meter = new FrameStatsMeter();
    expect(meter.summarize(0).idle).toBe(true);
    const last = frames(meter, 0, 10, 16);
    expect(meter.summarize(last + IDLE_AFTER_MS - 1).idle).toBe(false);
    const rested = meter.summarize(last + FRAME_WINDOW_MS + 1);
    expect(rested.idle).toBe(true);
    expect(rested.fps).toBeNull();
    expect(rested.drawCalls).toBe(12);
    expect(rested.triangles).toBe(48_000);
  });

  it('keeps a bounded history for the graph', () => {
    const meter = new FrameStatsMeter();
    frames(meter, 0, HISTORY_LENGTH * 3, 16);
    expect(meter.history).toHaveLength(HISTORY_LENGTH);
    expect(meter.history.every((value) => value === 16)).toBe(true);
  });
});

describe('formatCount', () => {
  it('abbreviates large triangle counts', () => {
    expect(formatCount(512)).toBe('512');
    expect(formatCount(7_912)).toBe('7.9k');
    expect(formatCount(48_300)).toBe('48k');
    expect(formatCount(1_240_000)).toBe('1.2M');
  });
});
