import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SKETCH_TEXT_CODE_UNITS,
  MAX_SKETCH_TEXT_OBJECTS,
  MAX_TEXT_OBJECT_CODE_UNITS
} from '@openzcad/shared';
import { computeSketchProfileAnalysis } from '../regions';
import { setTextFontProvider } from './fontProvider';
import { layoutText } from './layout';
import { buildTextProfileSet, textProfileSet } from './profiles';
import { textDisplayLoops, textSketchProfiles } from './sketchProfiles';
import { loadTestFont } from './testFonts';
import type { SketchRegionObject } from '../regions';

function object(
  id: string,
  text: string,
  construction = false
): SketchRegionObject {
  return {
    id,
    data: {
      objectKind: 'text',
      text,
      construction,
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 10,
      x: 0,
      y: 0
    }
  };
}

const resolve = (value: number | string) => Number(value);

afterEach(() => {
  vi.restoreAllMocks();
  setTextFontProvider(null);
});

describe('text outline work limits', () => {
  it.each([
    ['letters', 'A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1)],
    ['line breaks', '\r\n'.repeat(MAX_TEXT_OBJECT_CODE_UNITS)],
    ['astral characters', '😀'.repeat(MAX_TEXT_OBJECT_CODE_UNITS / 2 + 1)]
  ])(
    'refuses excessive %s before font or glyph work through every entry point',
    async (_, text) => {
      const font = await loadTestFont('open-sans');
      const glyphLookup = vi.spyOn(font.font, 'charToGlyph');
      const provider = vi.fn(() => font);
      setTextFontProvider(provider);
      const request = { text, size: 10 };
      const parameters = {
        text,
        fontFamily: 'open-sans',
        fontStyle: 'regular' as const,
        size: 10,
        x: 0,
        y: 0
      };

      for (const expand of [buildTextProfileSet, textProfileSet, layoutText]) {
        expect(() => expand(font, request)).toThrow('outline limit');
      }
      expect(() => textSketchProfiles('label', parameters)).toThrow(
        'outline limit'
      );
      expect(textDisplayLoops(parameters)).toBeNull();
      expect(provider).not.toHaveBeenCalled();
      expect(glyphLookup).not.toHaveBeenCalled();

      const analysis = computeSketchProfileAnalysis(
        [object('label', text)],
        resolve
      );
      expect(analysis.profiles).toEqual([]);
      expect(analysis.diagnostics).toEqual([
        expect.objectContaining({
          code: 'unresolved-outline',
          severity: 'error',
          sourceEntityIds: ['label']
        })
      ]);
      expect(analysis.diagnostics[0]!.message).toContain('outline limit');
      expect(provider).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'aggregate characters',
      Array.from(
        { length: MAX_SKETCH_TEXT_CODE_UNITS / MAX_TEXT_OBJECT_CODE_UNITS + 1 },
        (_, index) =>
          object(`label-${index}`, 'A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS))
      )
    ],
    [
      'empty objects',
      Array.from({ length: MAX_SKETCH_TEXT_OBJECTS + 1 }, (_, index) =>
        object(`label-${index}`, '')
      )
    ],
    [
      'repeated references',
      Array.from({ length: MAX_SKETCH_TEXT_OBJECTS + 1 }, () =>
        object('repeated-label', 'A')
      )
    ]
  ])(
    'preflights %s as a whole, preserving non-text geometry',
    (_, textObjects) => {
      const circle: SketchRegionObject = {
        id: 'circle',
        data: { objectKind: 'circle', radius: 4, centerX: 0, centerY: 0 }
      };
      const before = computeSketchProfileAnalysis([circle], resolve);
      const source = vi.fn((_entry: SketchRegionObject) => null);
      const provider = vi.fn(() => undefined);
      setTextFontProvider(provider);
      const objects = [...textObjects, circle];
      const stored = JSON.stringify(objects);
      const analysis = computeSketchProfileAnalysis(
        objects,
        resolve,
        undefined,
        { profileSource: source }
      );

      expect(analysis.profiles).toEqual(before.profiles);
      expect(analysis.diagnostics).toHaveLength(textObjects.length);
      expect(
        analysis.diagnostics.every(
          (diagnostic) =>
            diagnostic.code === 'unresolved-outline' &&
            diagnostic.message.includes('outline limit')
        )
      ).toBe(true);
      expect(source.mock.calls.map(([entry]) => entry.id)).toEqual(['circle']);
      expect(provider).not.toHaveBeenCalled();
      expect(JSON.stringify(objects)).toBe(stored);
    }
  );

  it('counts construction text because display still expands it', () => {
    const source = vi.fn(() => null);
    const analysis = computeSketchProfileAnalysis(
      [
        ...Array.from({ length: MAX_SKETCH_TEXT_OBJECTS }, (_, index) =>
          object(`construction-${index}`, '', true)
        ),
        object('label', 'A')
      ],
      resolve,
      undefined,
      { profileSource: source }
    );
    expect(source).not.toHaveBeenCalled();
    expect(
      analysis.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === 'unresolved-outline' &&
          diagnostic.sourceEntityIds.includes('label')
      )
    ).toMatchObject({
      code: 'unresolved-outline',
      sourceEntityIds: ['label']
    });
  });

  it('accepts a collection exactly at both sketch limits', () => {
    const source = vi.fn((_entry: SketchRegionObject) => []);
    const objects = Array.from(
      { length: MAX_SKETCH_TEXT_OBJECTS },
      (_, index) =>
        object(
          `label-${index}`,
          index < MAX_SKETCH_TEXT_CODE_UNITS / MAX_TEXT_OBJECT_CODE_UNITS
            ? 'I'.repeat(MAX_TEXT_OBJECT_CODE_UNITS)
            : ''
        )
    );
    const analysis = computeSketchProfileAnalysis(objects, resolve, undefined, {
      profileSource: source
    });
    expect(analysis.diagnostics).toEqual([]);
    expect(source).toHaveBeenCalledTimes(MAX_SKETCH_TEXT_OBJECTS);
  });

  it('accepts complete text at the boundary and keeps code points, spacing and exact curves', async () => {
    const font = await loadTestFont('open-sans');
    const text = 'I'.repeat(MAX_TEXT_OBJECT_CODE_UNITS);
    const set = buildTextProfileSet(font, { text, size: 10 });
    expect(set.text).toBe(text);
    expect(set.glyphs).toHaveLength(MAX_TEXT_OBJECT_CODE_UNITS);
    expect(set.regions).toHaveLength(MAX_TEXT_OBJECT_CODE_UNITS);
    expect(set.regions.every((region) => region.source === 'exact')).toBe(true);
    const layout = layoutText(font, { text: 'A😀\r\nB', size: 10 });
    expect(layout.glyphs.map((glyph) => glyph.char)).toEqual(['A', '😀', 'B']);
    expect(layout.lineCount).toBe(2);
    const regular = buildTextProfileSet(font, { text: 'Og', size: 10 });
    expect(
      regular.regions.some((region) =>
        region.outer.segments.some((segment) => segment.kind === 'quadratic')
      )
    ).toBe(true);
  });
});
