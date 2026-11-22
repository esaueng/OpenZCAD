import { describe, expect, it } from 'vitest';
import {
  displayPixelRatio,
  FrameIntervalMeter,
  MAX_VIEWPORT_PIXEL_RATIO,
  NAVIGATION_PIXEL_RATIO,
  navigationPixelRatio,
  SHADOW_MAP_SIZE,
  shadowMapSizeFor,
  SLOW_FRAME_MS,
  TOUCH_SHADOW_MAP_SIZE,
  viewportPixelRatio,
  viewportSampling,
  withReportedPixelRatio
} from './renderBudget';

describe('render budget', () => {
  it('gives a touch device the smaller shadow map and a desktop the tuned one', () => {
    expect(shadowMapSizeFor(true)).toBe(TOUCH_SHADOW_MAP_SIZE);
    expect(shadowMapSizeFor(false)).toBe(SHADOW_MAP_SIZE);
    expect(TOUCH_SHADOW_MAP_SIZE).toBeLessThan(SHADOW_MAP_SIZE);
  });

  it('drops MSAA for a desktop whose pixel ratio is already 2 or more', () => {
    for (const ratio of [2, 2.5, 3]) {
      expect(viewportSampling(true, ratio, false)).toEqual({
        antialias: false,
        supersampled: true
      });
    }
    for (const ratio of [1, 1.25, 1.5, 1.99]) {
      expect(viewportSampling(true, ratio, false)).toEqual({
        antialias: true,
        supersampled: false
      });
    }
  });

  it('keeps MSAA on a touch-first device at any pixel ratio', () => {
    for (const ratio of [1, 2, 3]) {
      expect(viewportSampling(true, ratio, true)).toEqual({
        antialias: true,
        supersampled: false
      });
    }
  });

  it('leaves a profile without antialiasing exactly as it is', () => {
    for (const coarse of [false, true]) {
      for (const ratio of [1, 2, 3]) {
        expect(viewportSampling(false, ratio, coarse)).toEqual({
          antialias: false,
          supersampled: false
        });
      }
    }
  });

  it('holds a supersampled context at 2x whatever the display reports later', () => {
    const supersampled = viewportSampling(true, 2, false);
    // Moved to a 1x display, or zoomed out or in, the backing store stays 2x.
    for (const ratio of [1, 1.25, 1.8, 2, 3]) {
      expect(viewportPixelRatio(supersampled, ratio)).toBe(
        MAX_VIEWPORT_PIXEL_RATIO
      );
    }
    // A multisampled context follows the display, capped at 2.
    const multisampled = viewportSampling(true, 1, false);
    expect(viewportPixelRatio(multisampled, 1)).toBe(1);
    expect(viewportPixelRatio(multisampled, 1.5)).toBe(1.5);
    expect(viewportPixelRatio(multisampled, 3)).toBe(MAX_VIEWPORT_PIXEL_RATIO);
    expect(viewportPixelRatio(viewportSampling(false, 3, false), 3)).toBe(
      MAX_VIEWPORT_PIXEL_RATIO
    );
  });

  it('sizes and styles an export by the display ratio, capped at 2', () => {
    expect(displayPixelRatio(1)).toBe(1);
    expect(displayPixelRatio(1.5)).toBe(1.5);
    expect(displayPixelRatio(3)).toBe(MAX_VIEWPORT_PIXEL_RATIO);
  });

  it('reports an overridden pixel ratio only while drawing', () => {
    class Renderer {
      private ratio = 2;
      getPixelRatio() {
        return this.ratio;
      }
    }
    const renderer = new Renderer();
    const own = renderer.getPixelRatio;
    expect(
      withReportedPixelRatio(renderer, 1, () => renderer.getPixelRatio())
    ).toBe(1);
    expect(renderer.getPixelRatio()).toBe(2);
    expect(() =>
      withReportedPixelRatio(renderer, 1, () => {
        throw new Error('refused');
      })
    ).toThrow('refused');
    expect(renderer.getPixelRatio()).toBe(2);
    expect(renderer.getPixelRatio).toBe(own);
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
