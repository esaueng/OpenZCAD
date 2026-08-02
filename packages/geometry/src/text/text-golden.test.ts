import { describe, expect, it } from 'vitest';
import { buildTextProfileSet } from './profiles';
import { loadTestFont } from './testFonts';
import type { TextLoop, TextProfileSet, TextSegment } from './types';

/**
 * Golden snapshots of profile output.
 *
 * The module is pure, so these are stable: the same font bytes and the same
 * request always give the same doubles. A diff here means the glyph pipeline
 * changed shape — segment kinds, ordering, winding, hole assignment, or the
 * coordinates themselves.
 *
 * Coordinates are printed to 9 decimals. That is far tighter than the 1e-7
 * weld `makeWire` applies, so a real geometric change cannot hide, while the
 * last bits of double noise do not churn the file. Bit-identical joints are
 * asserted directly in `text-profiles.test.ts`, not through the snapshot.
 */
const PLACES = 9;

function n(value: number): number {
  return Number(value.toFixed(PLACES));
}

function p(point: { x: number; y: number }): string {
  return `${n(point.x)} ${n(point.y)}`;
}

function segment(item: TextSegment): string {
  if (item.kind === 'line') {
    return `L ${p(item.b)}`;
  }
  if (item.kind === 'quadratic') {
    return `Q ${p(item.control)} ${p(item.b)}`;
  }
  return `C ${p(item.control1)} ${p(item.control2)} ${p(item.b)}`;
}

function loop(item: TextLoop): Record<string, unknown> {
  return {
    winding: item.winding,
    signedArea: n(item.signedArea),
    start: p(item.segments[0]!.a),
    segments: item.segments.map(segment)
  };
}

function snapshot(set: TextProfileSet): Record<string, unknown> {
  return {
    family: set.family,
    style: set.style,
    text: set.text,
    size: set.size,
    advanceWidth: n(set.advanceWidth),
    lineCount: set.lineCount,
    merged: set.merged,
    unionedGlyphs: set.unionedGlyphs,
    boundingBox: `${p(set.boundingBox.min)} .. ${p(set.boundingBox.max)}`,
    regions: set.regions.map((region) => ({
      source: region.source,
      glyphIndices: region.glyphIndices,
      area: n(region.area),
      samplePoint: p(region.samplePoint),
      outer: loop(region.outer),
      holes: region.holes.map(loop)
    }))
  };
}

describe('golden profiles', () => {
  it('Open Sans regular "Og" keeps exact quadratics', async () => {
    const font = await loadTestFont('open-sans', 'regular');
    const set = buildTextProfileSet(font, { text: 'Og', size: 10 });
    expect(set.merged).toBe(false);
    expect(snapshot(set)).toMatchSnapshot();
  });

  it('Lora bold "A@" keeps exact quadratics', async () => {
    const font = await loadTestFont('lora', 'bold');
    const set = buildTextProfileSet(font, { text: 'A@', size: 8 });
    expect(set.merged).toBe(false);
    expect(snapshot(set)).toMatchSnapshot();
  });

  it('JetBrains Mono italic "il" is monospaced and exact', async () => {
    const font = await loadTestFont('jetbrains-mono', 'italic');
    const set = buildTextProfileSet(font, { text: 'il', size: 6 });
    expect(snapshot(set)).toMatchSnapshot();
  });

  it('Pacifico regular "aa" goes through the overlap union', async () => {
    const font = await loadTestFont('pacifico', 'regular');
    const set = buildTextProfileSet(font, { text: 'aa', size: 10 });
    expect(set.merged).toBe(true);
    expect(snapshot(set)).toMatchSnapshot();
  });

  it('Inter regular "e" is resolved from a self-intersecting contour', async () => {
    const font = await loadTestFont('inter', 'regular');
    const set = buildTextProfileSet(font, { text: 'e', size: 10 });
    expect(set.merged).toBe(true);
    expect(snapshot(set)).toMatchSnapshot();
  });
});
