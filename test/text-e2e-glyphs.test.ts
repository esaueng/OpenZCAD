/**
 * Pins the glyph measurements `test/e2e/text-place-transform.spec.ts` reads
 * (see `test/e2e/textGlyphs.ts`) to the glyph pipeline that produced them.
 */
import { describe, expect, it } from 'vitest';
import { buildTextProfileSet } from '@openzcad/geometry';
import { FontLibrary } from '../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../packages/geometry/src/text/nodeFontSource';
import {
  OPEN_SANS_AREA_AT_10,
  OPEN_SANS_B_STEM_AT_10,
  textFramePoint
} from './e2e/textGlyphs';

const library = new FontLibrary(nodeFontDataSource());

describe('text e2e glyph measurements', () => {
  it('records the exact area of each string the specs engrave', async () => {
    const font = await library.load('open-sans', 'regular');
    for (const [text, area] of Object.entries(OPEN_SANS_AREA_AT_10)) {
      const measured = buildTextProfileSet(font, {
        text,
        size: 10
      }).regions.reduce((total, region) => total + region.area, 0);
      expect(measured, text).toBeCloseTo(area, 9);
    }
  });

  it('records a point on the B stem, and places it in the text frame', async () => {
    const font = await library.load('open-sans', 'regular');
    const turn = 30;
    const object = { x: -4, y: 2.5, rotation: turn };
    const { regions } = buildTextProfileSet(font, {
      text: 'B',
      size: 10,
      x: object.x,
      y: object.y,
      rotation: (turn * Math.PI) / 180
    });
    const point = textFramePoint(object, OPEN_SANS_B_STEM_AT_10);
    // The point lies on a straight piece of the laid-out outline.
    const onOutline = regions[0]!.outer.segments.some((segment) => {
      if (segment.kind !== 'line') return false;
      const { a, b } = segment;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const cross =
        (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      const along =
        ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) /
        (length * length);
      return Math.abs(cross / length) < 1e-9 && along > 0.25 && along < 0.75;
    });
    expect(onOutline).toBe(true);
  });
});
