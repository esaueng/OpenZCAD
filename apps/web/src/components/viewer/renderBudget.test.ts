import { describe, expect, it } from 'vitest';
import {
  displayPixelRatio,
  NavigationResolution,
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

describe('NavigationResolution', () => {
  it('uses severe GPU time for the first moving frame and restores full size at rest', () => {
    const budget = new NavigationResolution();
    expect(budget.ratio(0, false, 2, 300)).toBe(2);
    expect(budget.ratio(30_000, true, 2, 300)).toBe(0.75);
    expect(budget.ratio(30_016, true, 2)).toBe(0.75);
    expect(budget.ratio(30_032, false, 2, 300)).toBe(2);
    expect(budget.ratio(40_000, true, 2, 35)).toBe(2);
  });

  it('keeps idle gaps, isolated slow frames and healthy drags at full resolution', () => {
    const budget = new NavigationResolution();
    for (const now of [0, 16, 32, 180, 196, 212]) {
      expect(budget.ratio(now, true, 2)).toBe(2);
    }
    expect(budget.ratio(228, false, 2)).toBe(2);
    for (const now of [5000, 5016, 5032]) {
      expect(budget.ratio(now, true, 2)).toBe(2);
    }
  });

  it('locks a slow drag at a lower ratio and restores even if the pointer just parks', () => {
    const budget = new NavigationResolution();
    expect(budget.ratio(0, true, 2)).toBe(2);
    expect(budget.ratio(40, true, 2)).toBe(2);
    expect(budget.ratio(80, true, 2)).toBe(NAVIGATION_PIXEL_RATIO);
    expect(budget.ratio(96, true, 2)).toBe(NAVIGATION_PIXEL_RATIO);
    expect(budget.ratio(112, false, 2)).toBe(2);
    expect(budget.ratio(5000, true, 2)).toBe(2);
  });

  it('uses a deeper reduction for sustained stalls and never increases a low display ratio', () => {
    for (const [full, moving] of [
      [2, 0.75],
      [1, 0.75],
      [0.6, 0.6]
    ] as const) {
      const budget = new NavigationResolution();
      budget.ratio(0, true, full);
      budget.ratio(300, true, full);
      expect(budget.ratio(600, true, full)).toBe(moving);
      budget.reset();
      expect(budget.ratio(900, true, full)).toBe(full);
    }
  });

  it('steps down again only after two severe intervals at the intermediate ratio', () => {
    const budget = new NavigationResolution();
    const times = [0, 40, 80, 240, 400, 416, 432];
    expect(times.map((t) => budget.ratio(t, true, 2))).toEqual([
      2,
      2,
      NAVIGATION_PIXEL_RATIO,
      NAVIGATION_PIXEL_RATIO,
      0.75,
      0.75,
      0.75
    ]);
    expect(budget.ratio(448, false, 2)).toBe(2);
  });
});
