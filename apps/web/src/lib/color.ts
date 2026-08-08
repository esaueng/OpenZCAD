/**
 * Color space conversions for the in-app color picker. Hue is in degrees
 * [0, 360), saturation and value in [0, 1], RGB channels in [0, 255].
 */
export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Accepts '#rgb', 'rgb', '#rrggbb', 'rrggbb'; returns lowercase '#rrggbb'. */
export function normalizeHex(input: string): string | null {
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(input.trim());
  if (!match || !match[1]) {
    return null;
  }
  let digits = match[1].toLowerCase();
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((channel) => channel + channel)
      .join('');
  }
  return `#${digits}`;
}

export function hexToRgb(hex: string): RgbColor | null {
  const normalized = normalizeHex(hex);
  if (!normalized) {
    return null;
  }
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / delta + 2);
    } else {
      h = 60 * ((rn - gn) / delta + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: HsvColor): RgbColor {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  let rn: number;
  let gn: number;
  let bn: number;
  if (hue < 60) {
    [rn, gn, bn] = [c, x, 0];
  } else if (hue < 120) {
    [rn, gn, bn] = [x, c, 0];
  } else if (hue < 180) {
    [rn, gn, bn] = [0, c, x];
  } else if (hue < 240) {
    [rn, gn, bn] = [0, x, c];
  } else if (hue < 300) {
    [rn, gn, bn] = [x, 0, c];
  } else {
    [rn, gn, bn] = [c, 0, x];
  }
  return { r: (rn + m) * 255, g: (gn + m) * 255, b: (bn + m) * 255 };
}

export function hexToHsv(hex: string): HsvColor | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb) : null;
}

export function hsvToHex(color: HsvColor): string {
  return rgbToHex(hsvToRgb(color));
}
