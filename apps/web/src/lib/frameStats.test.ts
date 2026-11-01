import { describe, expect, it } from 'vitest';
import {
  BURST_GAP_MS,
  FPS_SERIES_SECONDS,
  FRAME_WINDOW_MS,
  FrameStatsMeter,
  HISTORY_LENGTH,
  HITCH_MS,
  IDLE_AFTER_MS,
  RECENT_INTERVALS,
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
  it('retains long animation stalls while excluding sleep between gestures', () => {
    const meter = new FrameStatsMeter();
    meter.record({ at: 0, renderMs: 0.5, drawCalls: 1, triangles: 1 });
    meter.record({
      at: 400,
      continuous: true,
      renderMs: 0.5,
      drawCalls: 1,
      triangles: 1
    });
    meter.record({
      at: 2_000,
      continuous: true,
      renderMs: 0.5,
      drawCalls: 1,
      triangles: 1
    });
    expect(meter.summarize(2_000)).toMatchObject({
      frameMs: 1_600,
      worstFrameMs: 1_600
    });
    expect(meter.recentStats()).toMatchObject({
      frames: 2,
      hitches: 2,
      worstFrameMs: 1_600
    });
    expect(meter.history).toEqual([null, 400, 1_600]);
    meter.record({
      at: 4_000,
      continuous: false,
      renderMs: 0.5,
      drawCalls: 1,
      triangles: 1
    });
    expect(meter.history.at(-1)).toBeNull();
    expect(meter.recentStats().frames).toBe(2);
  });

  it('does not report a long callback as idle immediately after it completes', () => {
    const meter = new FrameStatsMeter();
    meter.record({
      at: 0,
      renderMs: 1_000,
      cpuMs: 1_300,
      drawCalls: 1,
      triangles: 1
    });
    expect(meter.summarize(1_300)).toMatchObject({
      idle: false,
      cpuMs: 1_300,
      renderMs: 1_000
    });
    expect(meter.summarize(1_300 + IDLE_AFTER_MS + 1).idle).toBe(true);
  });
  it('reports full callback CPU separately from render calls and frame intervals', () => {
    const meter = new FrameStatsMeter();
    meter.record({
      at: 0,
      renderMs: 1,
      cpuMs: 8,
      drawCalls: 9,
      triangles: 32_000
    });
    meter.record({
      at: 16,
      renderMs: 3,
      cpuMs: 12,
      drawCalls: 9,
      triangles: 32_000
    });
    // Legacy samples do not invent a full-frame CPU value.
    meter.record({ at: 32, renderMs: 2, drawCalls: 9, triangles: 32_000 });
    expect(meter.summarize(32)).toMatchObject({
      cpuMs: 10,
      renderMs: 2,
      frameMs: 16,
      drawCalls: 9,
      triangles: 32_000
    });
    expect(meter.summarize(FRAME_WINDOW_MS + 40).cpuMs).toBeNull();
  });

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

  it('reports recent average, 1% and 0.1% lows from the slowest frames', () => {
    const meter = new FrameStatsMeter();
    // 990 frames at 10 ms, then 10 hitches of 40 ms: the slowest 1%.
    let at = frames(meter, 0, 991, 10);
    for (let index = 0; index < 10; index += 1) {
      at += 40;
      meter.record({ at, renderMs: 0.5, drawCalls: 1, triangles: 1 });
    }
    const recent = meter.recentStats();
    expect(recent.frames).toBe(1_000);
    expect(recent.averageFps).toBeCloseTo(1_000 / 10.3, 5);
    expect(recent.low1Fps).toBeCloseTo(25, 5);
    expect(recent.low01Fps).toBeCloseTo(25, 5);
    expect(recent.minFps).toBeCloseTo(25, 5);
    expect(recent.p99FrameMs).toBe(40);
    expect(recent.worstFrameMs).toBe(40);
    expect(recent.hitches).toBe(10);
    expect(HITCH_MS).toBeLessThan(40);
  });

  it('keeps rest out of the lows and bounds the recent window', () => {
    const meter = new FrameStatsMeter();
    expect(meter.recentStats().averageFps).toBeNull();
    const first = frames(meter, 0, 10, 16);
    frames(meter, first + BURST_GAP_MS + 1_000, 10, 16);
    expect(meter.recentStats().minFps).toBeCloseTo(62.5, 5);
    frames(meter, 100_000, RECENT_INTERVALS + 50, 8);
    const recent = meter.recentStats();
    expect(recent.frames).toBe(RECENT_INTERVALS);
    expect(recent.minFps).toBeCloseTo(125, 5);
  });

  it('graphs one frame rate per second and breaks over rest', () => {
    const meter = new FrameStatsMeter();
    // A second at 50 fps, two seconds of rest, then a second at 100 fps.
    frames(meter, 10_000, 50, 20);
    const last = frames(meter, 13_000, 100, 10);
    const series = meter.fpsSeries(last);
    expect(series).toHaveLength(FPS_SERIES_SECONDS);
    expect(series.at(-1)).toBeCloseTo(100, 5);
    expect(series.at(-2)).toBeNull();
    expect(series.at(-3)).toBeNull();
    expect(series.at(-4)).toBeCloseTo(50, 5);
    // Seconds that fell off the graph's span are not read back.
    expect(meter.fpsSeries(last + FPS_SERIES_SECONDS * 1_000)).toEqual(
      new Array(FPS_SERIES_SECONDS).fill(null)
    );
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
