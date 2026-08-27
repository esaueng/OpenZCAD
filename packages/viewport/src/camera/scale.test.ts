import { describe, expect, it } from 'vitest';
import {
  chooseViewportScale,
  DEFAULT_SCALE_BAR_MAX_WIDTH_PX,
  formatViewportScale
} from './scale';

describe('viewport scale indicator', () => {
  it('chooses conventional 1/2/5 spans within the visual width budget', () => {
    const zoomLevels = [0.00001, 0.01, 0.05, 0.1, 1, 1000];

    for (const worldUnitsPerPixel of zoomLevels) {
      const scale = chooseViewportScale(worldUnitsPerPixel);
      expect(scale).not.toBeNull();
      expect(scale!.widthPx).toBeLessThanOrEqual(
        DEFAULT_SCALE_BAR_MAX_WIDTH_PX + 1e-9
      );
      expect(scale!.widthPx).toBeGreaterThanOrEqual(80 - 1e-9);

      const exponent = Math.floor(Math.log10(scale!.value));
      const normalized = scale!.value / 10 ** exponent;
      expect([1, 2, 5]).toContain(normalized);
    }
  });

  it('updates the represented distance as the viewport zoom changes', () => {
    expect(chooseViewportScale(0.1)?.value).toBeCloseTo(20);
    expect(chooseViewportScale(0.01)?.value).toBeCloseTo(2);
    expect(chooseViewportScale(1)?.value).toBeCloseTo(200);
  });

  it('rejects invalid camera scales instead of displaying stale precision', () => {
    expect(chooseViewportScale(0)).toBeNull();
    expect(chooseViewportScale(Number.NaN)).toBeNull();
    expect(chooseViewportScale(Number.POSITIVE_INFINITY)).toBeNull();
    expect(chooseViewportScale(0.1, 0)).toBeNull();
  });

  it('formats document units compactly', () => {
    expect(formatViewportScale(10, 'mm')).toBe('10 mm');
    expect(formatViewportScale(0.005, 'mm')).toBe('0.005 mm');
    expect(formatViewportScale(2, 'inch')).toBe('2 in');
    expect(formatViewportScale(0.00001, 'mm')).toBe('1e-5 mm');
  });
});
