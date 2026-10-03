import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FEATURE_COLORS } from '@openzcad/shared';
import { SELECTION_SEMANTICS } from './semantics';
import { contextBodyColor, selectedFaceColor } from './selectionTint';

type Rgb = { r: number; g: number; b: number };

function srgb(color: THREE.ColorRepresentation): Rgb {
  return new THREE.Color(color).getRGB(
    { r: 0, g: 0, b: 0 },
    THREE.SRGBColorSpace
  );
}

/** WCAG relative luminance of a display colour. */
function luminance(color: THREE.ColorRepresentation): number {
  const { r, g, b } = srgb(color);
  const channel = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: THREE.ColorRepresentation, b: THREE.ColorRepresentation) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

function hue(color: THREE.ColorRepresentation): number {
  return (
    new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)
      .h * 360
  );
}

function hueDistance(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The fill this replaced: the accent laid over the face at fill opacity. */
function accentFilm(color: string): THREE.Color {
  const { face, faceOpacity } = SELECTION_SEMANTICS.selected;
  const base = srgb(color);
  const accent = srgb(face);
  return new THREE.Color().setRGB(
    base.r + (accent.r - base.r) * faceOpacity,
    base.g + (accent.g - base.g) * faceOpacity,
    base.b + (accent.b - base.b) * faceOpacity,
    THREE.SRGBColorSpace
  );
}

const featureColors = Object.entries(FEATURE_COLORS);

describe('selection tint (design review F8)', () => {
  it('draws the old accent film duller than the gold body it selected', () => {
    // The finding, measured: blue over the near-complementary gold mixed to
    // grey-tan, darker than the body around it, so the pick looked off.
    const gold = FEATURE_COLORS.primitive;
    const film = accentFilm(gold);
    expect(luminance(film)).toBeLessThan(luminance(gold));
    // And greyer: most of the gold's saturation is gone.
    const saturation = (color: THREE.Color) =>
      color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).s;
    expect(saturation(film)).toBeLessThan(
      saturation(new THREE.Color(gold)) / 2
    );
  });

  it.each(featureColors)(
    'lifts a selected %s face above its own colour',
    (_kind, color) => {
      expect(luminance(selectedFaceColor(color))).toBeGreaterThan(
        luminance(color)
      );
    }
  );

  it.each(featureColors)(
    'keeps a selected %s face its own hue',
    (_kind, color) => {
      // A light tint, not a recolour: the face still reads as its feature.
      expect(
        hueDistance(hue(selectedFaceColor(color)), hue(color))
      ).toBeLessThan(20);
    }
  );

  it.each(featureColors)(
    'sets a selected %s face clearly apart from the receding rest',
    (_kind, color) => {
      const rest = contextBodyColor(color, false);
      expect(luminance(rest)).toBeLessThan(luminance(color));
      // The selection is the bright thing on screen, by a wide margin.
      expect(contrast(selectedFaceColor(color), rest)).toBeGreaterThan(1.8);
    }
  );

  it('dims the rest by about a third and leaves an emphasized body alone', () => {
    const gold = FEATURE_COLORS.primitive;
    const dimmed = srgb(contextBodyColor(gold, false));
    const base = srgb(gold);
    const keep = 1 - SELECTION_SEMANTICS.selected.contextDim;
    expect(dimmed.r).toBeCloseTo(base.r * keep, 4);
    expect(dimmed.g).toBeCloseTo(base.g * keep, 4);
    expect(dimmed.b).toBeCloseTo(base.b * keep, 4);
    expect(SELECTION_SEMANTICS.selected.contextDim).toBeGreaterThanOrEqual(
      0.25
    );
    expect(SELECTION_SEMANTICS.selected.contextDim).toBeLessThanOrEqual(0.35);
    expect(contextBodyColor(gold, true).getHexString()).toBe(
      new THREE.Color(gold).getHexString()
    );
  });

  it('still separates a near-white body from its context', () => {
    expect(
      contrast(selectedFaceColor('#ffffff'), contextBodyColor('#ffffff', false))
    ).toBeGreaterThan(1.8);
  });

  it('writes into the colour it is given instead of allocating', () => {
    const target = new THREE.Color();
    expect(selectedFaceColor('#e1a948', target)).toBe(target);
    expect(contextBodyColor('#e1a948', false, target)).toBe(target);
  });
});
