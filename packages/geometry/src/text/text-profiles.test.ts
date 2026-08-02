import { describe, expect, it } from 'vitest';
import { FONT_FAMILIES, findFontFace, resolveFontStyle } from './registry';
import { FontLibrary, parseFontFace } from './loader';
import { FONT_ASSET_DIR, nodeFontDataSource } from './nodeFontSource';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTextProfileSet, clearTextProfileCache, textProfileSet } from './profiles';
import { flattenLoop } from './loops';
import { layoutText } from './layout';
import { TextGeometryError } from './types';
import {
  TEST_FAMILY_IDS,
  allLoops,
  endpointShoelace,
  loadTestFont,
  loopEnd,
  loopStart
} from './testFonts';
import type { TextLoop, TextProfileSet, TextRegion } from './types';

/**
 * Adjacent segments must share bit-identical endpoint doubles, including
 * across the closing joint. `makeWire` welds at 1e-7, and a joint recomputed
 * by two code paths is the failure that leaves a wire open.
 */
function expectLoopContinuity(loop: TextLoop, label: string): void {
  expect(loop.segments.length, `${label}: empty loop`).toBeGreaterThan(1);
  for (let i = 0; i < loop.segments.length; i += 1) {
    const current = loop.segments[i]!;
    const next = loop.segments[(i + 1) % loop.segments.length]!;
    expect(
      Object.is(current.b.x, next.a.x),
      `${label}: x joint ${i} ${current.b.x} vs ${next.a.x}`
    ).toBe(true);
    expect(
      Object.is(current.b.y, next.a.y),
      `${label}: y joint ${i} ${current.b.y} vs ${next.a.y}`
    ).toBe(true);
  }
  expect(Object.is(loopStart(loop).x, loopEnd(loop).x), `${label}: closure x`).toBe(
    true
  );
  expect(Object.is(loopStart(loop).y, loopEnd(loop).y), `${label}: closure y`).toBe(
    true
  );
}

function expectWinding(region: TextRegion, label: string): void {
  expect(region.outer.winding, `${label}: outer winding`).toBe('ccw');
  expect(region.outer.signedArea, `${label}: outer area sign`).toBeGreaterThan(0);
  expect(endpointShoelace(region.outer), `${label}: outer shoelace`).toBeGreaterThan(
    0
  );
  for (const [index, hole] of region.holes.entries()) {
    expect(hole.winding, `${label}: hole ${index} winding`).toBe('cw');
    expect(hole.signedArea, `${label}: hole ${index} area sign`).toBeLessThan(0);
    expect(endpointShoelace(hole), `${label}: hole ${index} shoelace`).toBeLessThan(
      0
    );
  }
}

function expectWellFormed(set: TextProfileSet, label: string): void {
  for (const [index, region] of set.regions.entries()) {
    expectWinding(region, `${label} region ${index}`);
    for (const [loopIndex, loop] of allLoops(region).entries()) {
      expectLoopContinuity(loop, `${label} region ${index} loop ${loopIndex}`);
    }
  }
}

function contains(outer: TextLoop, inner: TextLoop): boolean {
  const polygon = flattenLoop(outer.segments, 0.01);
  const probe = loopStart(inner);
  let winding = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const side = (b.x - a.x) * (probe.y - a.y) - (probe.x - a.x) * (b.y - a.y);
    if (a.y <= probe.y) {
      if (b.y > probe.y && side > 0) winding += 1;
    } else if (b.y <= probe.y && side < 0) winding -= 1;
  }
  return winding !== 0;
}

describe('font registry', () => {
  it('every declared face is a real file that parses', async () => {
    const source = nodeFontDataSource();
    for (const family of FONT_FAMILIES) {
      for (const face of family.faces) {
        const bytes = await source({
          file: face.file,
          url: face.file,
          family: family.family,
          style: face.style
        });
        const loaded = parseFontFace(family.id, face.style, bytes);
        expect(loaded.unitsPerEm, `${family.id} ${face.style}`).toBeGreaterThan(0);
        expect(loaded.font.numGlyphs).toBeGreaterThan(50);
      }
    }
  });

  it('ships one distinct file per style — no synthetic bold or italic', () => {
    const files = new Set<string>();
    for (const family of FONT_FAMILIES) {
      for (const face of family.faces) {
        expect(files.has(face.file), `duplicate asset ${face.file}`).toBe(false);
        files.add(face.file);
      }
    }
    expect(files.size).toBe(21);
  });

  it('italic is a redrawn letterform, not a sheared regular', async () => {
    const regular = await loadTestFont('inter', 'regular');
    const italic = await loadTestFont('inter', 'italic');
    const regularA = buildTextProfileSet(regular, { text: 'a', size: 10 });
    const italicA = buildTextProfileSet(italic, { text: 'a', size: 10 });
    // A shear maps every control point one-for-one, so it cannot change how
    // many segments the outline has. A different segment count can only come
    // from a separately drawn glyph.
    expect(regularA.regions[0]!.outer.segments.length).not.toBe(
      italicA.regions[0]!.outer.segments.length
    );
  });

  it('bold is a heavier drawing at the same em size', async () => {
    const regular = await loadTestFont('open-sans', 'regular');
    const bold = await loadTestFont('open-sans', 'bold');
    const area = (set: TextProfileSet): number =>
      set.regions.reduce((sum, region) => sum + region.area, 0);
    const light = area(buildTextProfileSet(regular, { text: 'H', size: 10 }));
    const heavy = area(buildTextProfileSet(bold, { text: 'H', size: 10 }));
    expect(heavy).toBeGreaterThan(light * 1.2);
  });

  it('falls back down a style chain instead of faking a missing style', () => {
    expect(resolveFontStyle('oswald', 'italic')).toBe('regular');
    expect(resolveFontStyle('oswald', 'boldItalic')).toBe('bold');
    expect(resolveFontStyle('pacifico', 'bold')).toBe('regular');
    expect(resolveFontStyle('inter', 'boldItalic')).toBe('boldItalic');
    expect(findFontFace('oswald', 'italic')).toBeUndefined();
    expect(resolveFontStyle('nope', 'regular')).toBeUndefined();
  });

  it('declares the licence the font binary itself names', async () => {
    // Not everything on Google Fonts is OFL — Roboto Slab is Apache-2.0.
    // The registry has to agree with the binary, or the notices lie.
    const source = nodeFontDataSource();
    const expected: Record<string, string> = {
      'OFL-1.1': 'sil.org/OFL|openfontlicense.org',
      'Apache-2.0': 'apache.org/licenses/LICENSE-2.0'
    };
    const licenseText = await readFile(
      path.join(FONT_ASSET_DIR, 'manifest.json'),
      'utf8'
    );
    const manifest = JSON.parse(licenseText) as {
      licenses: Record<string, string>;
    };
    for (const family of FONT_FAMILIES) {
      expect(manifest.licenses[family.id], `${family.id} manifest`).toBe(
        family.license
      );
      const face = family.faces[0]!;
      const bytes = await source({
        file: face.file,
        url: face.file,
        family: family.family,
        style: face.style
      });
      const loaded = parseFontFace(family.id, face.style, bytes);
      const url =
        loaded.font.names.windows?.licenseURL?.en ??
        loaded.font.names.macintosh?.licenseURL?.en ??
        '';
      expect(url, `${family.id} licence url`).toMatch(
        new RegExp(expected[family.license]!)
      );
    }
  });

  it('resolves a family by id or display name', () => {
    expect(findFontFace('Open Sans', 'bold')?.face.file).toBe('open-sans-bold.ttf');
    expect(findFontFace('open-sans', 'bold')?.face.file).toBe('open-sans-bold.ttf');
  });
});

describe('a letter with a counter', () => {
  it("'O' is one region with exactly one hole, in every family", async () => {
    for (const familyId of TEST_FAMILY_IDS) {
      const font = await loadTestFont(familyId);
      const set = buildTextProfileSet(font, { text: 'O', size: 10 });
      expect(set.regions.length, `${familyId} region count`).toBe(1);
      const region = set.regions[0]!;
      expect(region.holes.length, `${familyId} hole count`).toBe(1);
      expectWinding(region, `${familyId} O`);
      expectLoopContinuity(region.outer, `${familyId} O outer`);
      expectLoopContinuity(region.holes[0]!, `${familyId} O hole`);
      expect(contains(region.outer, region.holes[0]!), `${familyId} hole inside`).toBe(
        true
      );
      // Holes really are subtracted: a filled disc of this outline would be
      // much larger than the ring the letter actually encloses.
      expect(region.area).toBeLessThan(Math.abs(region.outer.signedArea));
      expect(region.area).toBeGreaterThan(0);
    }
  });

  it("'A' is one region with exactly one counter", async () => {
    // Pacifico is excluded on purpose: its script capital A is an open form
    // with no closed counter, so there is nothing to assign.
    for (const familyId of TEST_FAMILY_IDS.filter((id) => id !== 'pacifico')) {
      const font = await loadTestFont(familyId);
      const set = buildTextProfileSet(font, { text: 'A', size: 10 });
      expect(set.regions.length, `${familyId} region count`).toBe(1);
      expect(set.regions[0]!.holes.length, `${familyId} counter count`).toBe(1);
      expectWellFormed(set, `${familyId} A`);
    }
  });

  it("keeps 'O' as exact beziers, not a polyline", async () => {
    const font = await loadTestFont('open-sans');
    const set = buildTextProfileSet(font, { text: 'O', size: 10 });
    const region = set.regions[0]!;
    expect(region.source).toBe('exact');
    expect(set.merged).toBe(false);
    const kinds = new Set(region.outer.segments.map((segment) => segment.kind));
    expect(kinds.has('quadratic') || kinds.has('cubic')).toBe(true);
    // A flattened circle would need far more than a couple dozen pieces.
    expect(region.outer.segments.length).toBeLessThan(32);
  });
});

describe('a multi-glyph word', () => {
  it('gives one region per letter and only the O is holed', async () => {
    for (const familyId of ['open-sans', 'lora', 'oswald', 'roboto-slab']) {
      const font = await loadTestFont(familyId);
      const set = buildTextProfileSet(font, { text: 'HELLO', size: 10 });
      expect(set.regions.length, `${familyId} regions`).toBe(5);
      const holes = set.regions.map((region) => region.holes.length);
      expect(holes, `${familyId} holes`).toEqual([0, 0, 0, 0, 1]);
      expect(set.merged, `${familyId} merged`).toBe(false);
      expect(
        set.regions.every((region) => region.source === 'exact'),
        `${familyId} exact`
      ).toBe(true);
      expectWellFormed(set, `${familyId} HELLO`);
    }
  });

  it('advances the pen left to right and reports the run width', async () => {
    const font = await loadTestFont('open-sans');
    const set = buildTextProfileSet(font, { text: 'HELLO', size: 10 });
    const xs = set.regions.map((region) => region.boundingBox.min.x);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    }
    expect(set.advanceWidth).toBeGreaterThan(set.boundingBox.max.x - set.boundingBox.min.x);
    expect(set.lineCount).toBe(1);
  });

  it('spaces advance the pen but contribute no region', async () => {
    const font = await loadTestFont('open-sans');
    const withSpace = buildTextProfileSet(font, { text: 'A B', size: 10 });
    expect(withSpace.regions.length).toBe(2);
    expect(withSpace.glyphs.length).toBe(3);
    expect(withSpace.glyphs[1]!.char).toBe(' ');
    expect(withSpace.glyphs[1]!.advanceUnits).toBeGreaterThan(0);
  });

  it('lays out newlines onto successive baselines', async () => {
    const font = await loadTestFont('open-sans');
    const set = buildTextProfileSet(font, { text: 'A\nB', size: 10 });
    expect(set.lineCount).toBe(2);
    expect(set.regions.length).toBe(2);
    const [first, second] = set.regions;
    expect(second!.boundingBox.max.y).toBeLessThan(first!.boundingBox.min.y);
  });

  it('centres and right-aligns about the origin', async () => {
    const font = await loadTestFont('open-sans');
    const left = buildTextProfileSet(font, { text: 'HELLO', size: 10 });
    const centred = buildTextProfileSet(font, {
      text: 'HELLO',
      size: 10,
      align: 'center'
    });
    const right = buildTextProfileSet(font, {
      text: 'HELLO',
      size: 10,
      align: 'right'
    });
    expect(centred.boundingBox.min.x).toBeLessThan(0);
    expect(centred.boundingBox.max.x).toBeGreaterThan(0);
    expect(right.boundingBox.max.x).toBeLessThan(left.advanceWidth * 0.01);
    const width = (set: TextProfileSet): number =>
      set.boundingBox.max.x - set.boundingBox.min.x;
    expect(width(centred)).toBeCloseTo(width(left), 9);
    expect(width(right)).toBeCloseTo(width(left), 9);
  });

  it('applies kerning when the font has a pair, and honours the toggle', async () => {
    const font = await loadTestFont('pacifico');
    const kerned = layoutText(font, { text: 'To', size: 10 });
    const unkerned = layoutText(font, { text: 'To', size: 10 }, { kerning: false });
    expect(kerned.glyphs[1]!.penUnits).toBeLessThan(unkerned.glyphs[1]!.penUnits);
  });

  it('reports characters the font has no glyph for', async () => {
    const font = await loadTestFont('open-sans');
    const set = buildTextProfileSet(font, { text: 'A\u{10FFFD}A', size: 10 });
    expect(set.missingChars).toEqual(['\u{10FFFD}']);
  });
});

describe('nested counters', () => {
  it("'®' nests a counter inside a counter", async () => {
    for (const familyId of ['open-sans', 'lora', 'oswald', 'roboto-slab']) {
      const font = await loadTestFont(familyId);
      const set = buildTextProfileSet(font, { text: '®', size: 10 });
      // The circle is a region with the ring as its hole; the R inside that
      // hole is material again, and its bowl is a hole once more. A two-level
      // outer/hole split would collapse this into one wrong region.
      expect(set.regions.length, `${familyId} regions`).toBe(2);
      expectWellFormed(set, `${familyId} ®`);
      const outerRegion = set.regions.find(
        (region) => region.area === Math.max(...set.regions.map((r) => r.area))
      )!;
      const innerRegion = set.regions.find((region) => region !== outerRegion)!;
      expect(outerRegion.holes.length, `${familyId} ring`).toBe(1);
      expect(innerRegion.holes.length, `${familyId} R bowl`).toBe(1);
      // The inner region really does sit inside the outer region's hole.
      expect(contains(outerRegion.holes[0]!, innerRegion.outer)).toBe(true);
      expect(contains(innerRegion.outer, innerRegion.holes[0]!)).toBe(true);
    }
  });

  it("'©' puts an island inside a counter", async () => {
    const font = await loadTestFont('open-sans');
    const set = buildTextProfileSet(font, { text: '©', size: 10 });
    expect(set.regions.length).toBe(2);
    const [ring, letter] = set.regions;
    expect(ring!.holes.length).toBe(1);
    expect(letter!.holes.length).toBe(0);
    expect(contains(ring!.holes[0]!, letter!.outer)).toBe(true);
    expectWellFormed(set, '©');
  });
});

describe('overlapping glyphs', () => {
  it('merges a touching pair into one region and removes the shared ink', async () => {
    const font = await loadTestFont('pacifico');
    const merged = buildTextProfileSet(font, { text: 'aa', size: 10 });
    const unmerged = buildTextProfileSet(
      font,
      { text: 'aa', size: 10 },
      { mergeOverlaps: false }
    );
    expect(merged.merged).toBe(true);
    expect(merged.regions.length).toBe(1);
    expect(unmerged.regions.length).toBe(2);

    const total = (set: TextProfileSet): number =>
      set.regions.reduce((sum, region) => sum + region.area, 0);
    // The union is a real union: the shared ink is counted once, so the
    // merged area is strictly smaller than the two glyphs added up.
    expect(total(merged)).toBeLessThan(total(unmerged));
    expect(total(merged)).toBeGreaterThan(total(unmerged) * 0.8);

    const region = merged.regions[0]!;
    expect(region.source).toBe('unioned');
    expect(region.glyphIndices).toEqual([0, 1]);
    expect(
      region.outer.segments.every((segment) => segment.kind === 'line')
    ).toBe(true);
    expect(merged.unionedGlyphs).toEqual([0, 1]);
    expectWellFormed(merged, 'pacifico aa');
    // Both counters survive the merge.
    expect(region.holes.length).toBe(2);
  });

  it('leaves kerned-but-untouching neighbours exact', async () => {
    const font = await loadTestFont('oswald');
    // Oswald 'AV' at this spacing has overlapping bounding boxes and no
    // shared ink; the bbox gate must not be the only test.
    const set = buildTextProfileSet(font, {
      text: 'AV',
      size: 10,
      letterSpacing: -0.1
    });
    const [a, v] = set.regions;
    expect(a!.boundingBox.max.x).toBeGreaterThan(v!.boundingBox.min.x);
    expect(set.merged).toBe(false);
    expect(set.regions.every((region) => region.source === 'exact')).toBe(true);
  });

  it('resolves glyphs whose own contours overlap', async () => {
    // Inter draws 'e' as overlapping strokes in a single self-intersecting
    // contour. Handed to the kernel unresolved that is not a valid wire.
    const font = await loadTestFont('inter');
    const set = buildTextProfileSet(font, { text: 'e', size: 10 });
    expect(set.merged).toBe(true);
    expect(set.unionedGlyphs).toEqual([0]);
    const region = set.regions[0]!;
    expect(region.source).toBe('unioned');
    expect(region.holes.length).toBe(1);
    expectWellFormed(set, 'inter e');
  });

  it('keeps clean families exact across a whole pangram', async () => {
    for (const familyId of ['open-sans', 'lora', 'oswald']) {
      const font = await loadTestFont(familyId);
      const set = buildTextProfileSet(font, {
        text: 'The quick brown fox',
        size: 10
      });
      expect(set.unionedGlyphs, `${familyId}`).toEqual([]);
      expect(set.regions.every((region) => region.source === 'exact')).toBe(true);
      expectWellFormed(set, `${familyId} pangram`);
    }
  });
});

describe('purity and caching', () => {
  it('is deterministic: identical requests give identical doubles', async () => {
    const font = await loadTestFont('lora');
    const request = { text: 'Ogg', size: 7.5, x: 1.25, y: -3, rotation: 0.4 };
    const first = buildTextProfileSet(font, request);
    const second = buildTextProfileSet(font, request);
    expect(first).not.toBe(second);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reuses a cached set and keys on every geometric parameter', async () => {
    clearTextProfileCache();
    const font = await loadTestFont('open-sans');
    const base = { text: 'Hi', size: 10 };
    expect(textProfileSet(font, base)).toBe(textProfileSet(font, base));
    expect(textProfileSet(font, base)).not.toBe(
      textProfileSet(font, { ...base, size: 11 })
    );
    expect(textProfileSet(font, base)).not.toBe(
      textProfileSet(font, { ...base, text: 'Hj' })
    );
    expect(textProfileSet(font, base)).not.toBe(
      textProfileSet(font, { ...base, rotation: 0.1 })
    );
    const bold = await loadTestFont('open-sans', 'bold');
    expect(textProfileSet(font, base)).not.toBe(textProfileSet(bold, base));
  });

  it('parses each font face once', async () => {
    let reads = 0;
    const library = new FontLibrary((request) => {
      reads += 1;
      return nodeFontDataSource()(request);
    });
    const [first, second] = await Promise.all([
      library.load('lora', 'regular'),
      library.load('lora', 'regular')
    ]);
    await library.load('lora', 'regular');
    expect(reads).toBe(1);
    expect(first).toBe(second);
  });
});

describe('placement', () => {
  it('translates and rotates rigidly', async () => {
    const font = await loadTestFont('open-sans');
    const plain = buildTextProfileSet(font, { text: 'L', size: 10 });
    const moved = buildTextProfileSet(font, { text: 'L', size: 10, x: 3, y: -2 });
    expect(moved.boundingBox.min.x).toBeCloseTo(plain.boundingBox.min.x + 3, 9);
    expect(moved.boundingBox.min.y).toBeCloseTo(plain.boundingBox.min.y - 2, 9);

    const turned = buildTextProfileSet(font, {
      text: 'L',
      size: 10,
      rotation: Math.PI / 2
    });
    // A quarter turn about the origin sends (x, y) to (−y, x).
    expect(turned.regions[0]!.area).toBeCloseTo(plain.regions[0]!.area, 9);
    expect(turned.boundingBox.min.x).toBeCloseTo(-plain.boundingBox.max.y, 9);
    expectWellFormed(turned, 'rotated L');
  });

  it('scales linearly with size', async () => {
    const font = await loadTestFont('open-sans');
    const small = buildTextProfileSet(font, { text: 'O', size: 5 });
    const large = buildTextProfileSet(font, { text: 'O', size: 15 });
    expect(large.regions[0]!.area).toBeCloseTo(small.regions[0]!.area * 9, 6);
  });
});

describe('failure modes', () => {
  it('refuses a size that is not a positive number', async () => {
    const font = await loadTestFont('open-sans');
    expect(() => buildTextProfileSet(font, { text: 'A', size: 0 })).toThrow(
      TextGeometryError
    );
    expect(() => buildTextProfileSet(font, { text: 'A', size: -1 })).toThrow(
      TextGeometryError
    );
    expect(() => buildTextProfileSet(font, { text: 'A', size: Number.NaN })).toThrow(
      TextGeometryError
    );
  });

  it('refuses a family or style that is not bundled', async () => {
    const library = new FontLibrary(nodeFontDataSource());
    await expect(library.load('comic-sans', 'regular')).rejects.toThrow(
      TextGeometryError
    );
    await expect(library.load('oswald', 'italic')).rejects.toThrow(
      TextGeometryError
    );
  });

  it('produces an empty set for text with no ink', async () => {
    const font = await loadTestFont('open-sans');
    const set = buildTextProfileSet(font, { text: '   ', size: 10 });
    expect(set.regions).toEqual([]);
    expect(set.advanceWidth).toBeGreaterThan(0);
    const empty = buildTextProfileSet(font, { text: '', size: 10 });
    expect(empty.regions).toEqual([]);
    expect(empty.advanceWidth).toBe(0);
  });
});

describe('every bundled family', () => {
  it('survives letter spacing tight enough to force the union', async () => {
    // Negative spacing drives neighbours into each other, which is the case
    // that used to strand the union's boundary trace. Every result must still
    // be closed and correctly wound, in every face.
    for (const familyId of TEST_FAMILY_IDS) {
      const font = await loadTestFont(familyId);
      for (const text of ['ll', 'Wa', 'gg', 'AV', 'To', 'HELLO']) {
        for (const letterSpacing of [-0.1, -0.3, -0.45]) {
          const set = buildTextProfileSet(font, {
            text,
            size: 10,
            letterSpacing
          });
          expectWellFormed(set, `${familyId} "${text}" @${letterSpacing}`);
        }
      }
    }
  });


  it('produces closed, correctly wound loops for a mixed string', async () => {
    for (const familyId of TEST_FAMILY_IDS) {
      for (const style of ['regular', 'bold', 'italic', 'boldItalic'] as const) {
        const resolved = resolveFontStyle(familyId, style);
        if (resolved !== style) {
          continue;
        }
        const font = await loadTestFont(familyId, style);
        const set = buildTextProfileSet(font, {
          text: 'Hamburgefonstiv 0189 @&%',
          size: 12
        });
        // Pacifico joins most neighbours into merged regions, so the count
        // is much lower there than for the text faces.
        expect(set.regions.length, `${familyId} ${style}`).toBeGreaterThan(
          familyId === 'pacifico' ? 4 : 10
        );
        expectWellFormed(set, `${familyId} ${style}`);
      }
    }
  });
});
