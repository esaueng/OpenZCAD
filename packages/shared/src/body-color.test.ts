import { describe, expect, it } from 'vitest';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  BODY_COLOR_PRESETS,
  DEFAULT_BODY_COLOR,
  FEATURE_COLORS,
  PREVIEW_BODY_COLOR,
  bodyDisplayColor,
  chosenBodyColor,
  featureColor,
  type FeatureKind
} from './index';

/** HSL hue (degrees) and saturation of a #rrggbb colour. */
function hsl(hex: string): { h: number; s: number } {
  const [r, g, b] = [1, 3, 5].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255
  ) as [number, number, number];
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const lightness = (high + low) / 2;
  const chroma = high - low;
  if (chroma === 0) return { h: 0, s: 0 };
  const s = chroma / (1 - Math.abs(2 * lightness - 1));
  const sector =
    high === r
      ? ((g - b) / chroma) % 6
      : high === g
        ? (b - r) / chroma + 2
        : (r - g) / chroma + 4;
  return { h: (sector * 60 + 360) % 360, s };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('body colour (design review G2)', () => {
  const kinds = Object.keys(FEATURE_COLORS) as FeatureKind[];

  it.each(kinds)(
    'draws a %s body in the default, not the colour it was stamped with',
    (kind) => {
      const stamped = { [BODY_COLOR_METADATA_KEY]: featureColor(kind) };
      expect(chosenBodyColor(stamped, kind)).toBeNull();
      expect(bodyDisplayColor(stamped, kind)).toBe(DEFAULT_BODY_COLOR);
    }
  );

  it('draws a body with no colour at all in the default', () => {
    expect(bodyDisplayColor(undefined, 'extrude')).toBe(DEFAULT_BODY_COLOR);
    expect(bodyDisplayColor({}, 'hole')).toBe(DEFAULT_BODY_COLOR);
    expect(bodyDisplayColor({ [BODY_COLOR_METADATA_KEY]: '  ' }, 'hole')).toBe(
      DEFAULT_BODY_COLOR
    );
  });

  it('keeps a chosen colour, even one equal to the stamp', () => {
    expect(
      bodyDisplayColor(
        {
          [BODY_COLOR_METADATA_KEY]: FEATURE_COLORS.hole,
          [BODY_COLOR_CHOSEN_METADATA_KEY]: true
        },
        'hole'
      )
    ).toBe(FEATURE_COLORS.hole);
  });

  it('keeps an unmarked colour other than the stamp: an older pick', () => {
    // A box someone painted purple before the mark existed, and a demo's
    // gold finish on a fillet body.
    expect(
      bodyDisplayColor({ [BODY_COLOR_METADATA_KEY]: '#a78bfa' }, 'primitive')
    ).toBe('#a78bfa');
    expect(
      bodyDisplayColor({ [BODY_COLOR_METADATA_KEY]: '#e1a948' }, 'fillet')
    ).toBe('#e1a948');
  });

  it('compares a stamp without regard to case', () => {
    expect(
      bodyDisplayColor(
        { [BODY_COLOR_METADATA_KEY]: FEATURE_COLORS.extrude.toUpperCase() },
        'extrude'
      )
    ).toBe(DEFAULT_BODY_COLOR);
  });

  it('treats any stamp as one when the feature is unknown', () => {
    expect(
      bodyDisplayColor(
        { [BODY_COLOR_METADATA_KEY]: FEATURE_COLORS.boolean },
        undefined
      )
    ).toBe(DEFAULT_BODY_COLOR);
    expect(
      bodyDisplayColor({ [BODY_COLOR_METADATA_KEY]: '#123456' }, undefined)
    ).toBe('#123456');
  });

  it('offers the default first among the presets', () => {
    expect(BODY_COLOR_PRESETS[0]).toBe(DEFAULT_BODY_COLOR);
    expect(new Set(BODY_COLOR_PRESETS).size).toBe(BODY_COLOR_PRESETS.length);
  });

  it.each([...BODY_COLOR_PRESETS])(
    'keeps the body colour %s well away from the preview hue',
    (color) => {
      const body = hsl(color);
      const preview = hsl(PREVIEW_BODY_COLOR);
      // Either a near-grey, which no one reads as mint, or another hue.
      expect(
        body.s < 0.3 || hueDistance(body.h, preview.h) >= 45,
        `${color}: hue ${body.h.toFixed(0)}°, saturation ${body.s.toFixed(2)}`
      ).toBe(true);
    }
  );

  it('keeps the default neutral', () => {
    expect(hsl(DEFAULT_BODY_COLOR).s).toBeLessThan(0.3);
  });
});
