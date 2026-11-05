import { describe, expect, it } from 'vitest';
import {
  FrameIntervalMeter,
  NAVIGATION_PIXEL_RATIO,
  navigationPixelRatio,
  SHADOW_MAP_SIZE,
  shadowMapSizeFor,
  SLOW_FRAME_MS,
  TOUCH_SHADOW_MAP_SIZE
} from './renderBudget';

describe('render budget', () => {
  it('gives a touch device the smaller shadow map and a desktop the tuned one', () => {
    expect(shadowMapSizeFor(true)).toBe(TOUCH_SHADOW_MAP_SIZE);
    expect(shadowMapSizeFor(false)).toBe(SHADOW_MAP_SIZE);
    expect(TOUCH_SHADOW_MAP_SIZE).toBeLessThan(SHADOW_MAP_SIZE);
  });

  it('lowers the navigation pixel ratio only for a device dropping frames', () => {
    expect(navigationPixelRatio(2, null)).toBeNull();
    expect(navigationPixelRatio(2, 1000 / 60)).toBeNull();
    expect(navigationPixelRatio(2, SLOW_FRAME_MS + 1)).toBe(
      NAVIGATION_PIXEL_RATIO
    );
    // Never "lowers" a display already at or below it.
    expect(navigationPixelRatio(1, 50)).toBeNull();
    expect(navigationPixelRatio(NAVIGATION_PIXEL_RATIO, 50)).toBeNull();
  });
});

describe('FrameIntervalMeter', () => {
  it('averages back-to-back frames and ignores the gap across a sleep', () => {
    const meter = new FrameIntervalMeter();
    expect(meter.intervalMs).toBeNull();
    meter.sample(0, false);
    meter.sample(16, true);
    expect(meter.intervalMs).toBeCloseTo(16, 9);
    // The loop slept for five seconds: not a frame's cost.
    meter.sample(5016, false);
    expect(meter.intervalMs).toBeCloseTo(16, 9);
    meter.sample(5056, true);
    expect(meter.intervalMs).toBeCloseTo(16 * 0.8 + 40 * 0.2, 9);
  });

  it('settles on a steady slow rate', () => {
    const meter = new FrameIntervalMeter();
    let now = 0;
    meter.sample(now, false);
    for (let frame = 0; frame < 60; frame += 1) {
      now += 33;
      meter.sample(now, true);
    }
    expect(meter.intervalMs).toBeCloseTo(33, 6);
    expect(navigationPixelRatio(2, meter.intervalMs)).toBe(
      NAVIGATION_PIXEL_RATIO
    );
  });
});
