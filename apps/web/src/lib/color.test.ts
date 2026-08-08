import { describe, expect, it } from 'vitest';
import { FEATURE_COLORS } from '@openzcad/shared';
import {
  hexToHsv,
  hexToRgb,
  hsvToHex,
  hsvToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsv
} from './color';

describe('normalizeHex', () => {
  it('accepts shorthand and unhashed input', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('4DA3FF')).toBe('#4da3ff');
    expect(normalizeHex('  #e1a948 ')).toBe('#e1a948');
  });

  it('rejects malformed values', () => {
    expect(normalizeHex('#abcd')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#gg0000')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('rgb conversions', () => {
  it('round-trips every feature palette color through HSV', () => {
    for (const hex of Object.values(FEATURE_COLORS)) {
      const hsv = hexToHsv(hex);
      expect(hsv).not.toBeNull();
      expect(hsvToHex(hsv!)).toBe(hex);
    }
  });

  it('keeps black, white, and gray at zero hue and saturation', () => {
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });
    const gray = hexToHsv('#808080');
    expect(gray?.s).toBe(0);
    expect(gray?.v).toBeCloseTo(0.502, 3);
  });

  it('maps primary hues to the expected angles', () => {
    expect(hexToHsv('#ff0000')?.h).toBe(0);
    expect(hexToHsv('#00ff00')?.h).toBe(120);
    expect(hexToHsv('#0000ff')?.h).toBe(240);
  });

  it('clamps out-of-range channels in rgbToHex', () => {
    expect(rgbToHex({ r: 300, g: -4, b: 128 })).toBe('#ff0080');
  });

  it('round-trips HSV drags through RGB without drift', () => {
    const rgb = hsvToRgb({ h: 208, s: 0.66, v: 0.83 });
    const hsv = rgbToHsv(rgb);
    expect(hsv.h).toBeCloseTo(208, 0);
    expect(hsv.s).toBeCloseTo(0.66, 2);
    expect(hsv.v).toBeCloseTo(0.83, 2);
  });

  it('parses hexToRgb channels', () => {
    expect(hexToRgb('#4da3ff')).toEqual({ r: 77, g: 163, b: 255 });
    expect(hexToRgb('#xyz')).toBeNull();
  });
});
