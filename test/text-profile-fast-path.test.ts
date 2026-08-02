/**
 * The text fast path in `computeSketchProfileAnalysis`.
 *
 * Two things have to be true at once. Text must produce correct profiles —
 * outer loops counter-clockwise, holes clockwise, counters where the letter
 * has one, exact beziers rather than polylines. And it must never enter the
 * half-edge arrangement: that pipeline is quadratic in curve count in several
 * places and runs on the UI thread and the worker on every keystroke, so
 * routing a 2,000-segment word through it would be a product failure even
 * though the geometry would come out right.
 *
 * See `docs/plans/text-feature-plan.md`, design decision 4.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  regionLoopSignedArea,
  setTextFontProvider,
  type RegionLoop,
  type SketchProfile,
  type SketchRegionObject
} from '@openzcad/geometry';
import type { ParamValue } from '@openzcad/shared';
import { FontLibrary } from '../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../packages/geometry/src/text/nodeFontSource';

const resolve = (value: ParamValue): number =>
  typeof value === 'number' ? value : Number(value);

const library = new FontLibrary(nodeFontDataSource());

function textObject(
  id: string,
  overrides: Partial<
    Extract<SketchRegionObject['data'], { objectKind: 'text' }>
  > = {}
): SketchRegionObject {
  return {
    id,
    data: {
      objectKind: 'text',
      text: 'TEXT',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 10,
      x: 0,
      y: 0,
      ...overrides
    }
  };
}

function installProvider(): void {
  setTextFontProvider((family, style) => library.peek(family, style));
}

beforeAll(async () => {
  await library.load('open-sans', 'regular');
  await library.load('open-sans', 'bold');
});

afterEach(() => {
  setTextFontProvider(null);
});

describe('text objects expand into ready-made profiles', () => {
  it('produces one region per letter, in reading order', () => {
    installProvider();
    const profiles = computeSketchRegions([textObject('text_1')], resolve);
    expect(profiles).toHaveLength(4);
    // Reading order, not the arrangement's largest-area-first sort: the two
    // 'T's are identical in area and would be interleaved with 'E' and 'X'
    // by an area sort.
    const lefts = profiles.map((profile) => profile.boundingBox.min.x);
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    expect(
      profiles.every(
        (profile) =>
          profile.sourceEntityIds.length === 1 &&
          profile.sourceEntityIds[0] === 'text_1'
      )
    ).toBe(true);
  });

  it('gives counters holes and gives letters without counters none', () => {
    installProvider();
    const profiles = computeSketchRegions(
      [textObject('text_1', { text: 'BoIl' })],
      resolve
    );
    // B has two counters, o has one, I and l have none.
    expect(profiles.map((profile) => profile.holes.length)).toEqual([
      2, 1, 0, 0
    ]);
  });

  it('keeps the font beziers exact instead of flattening them', () => {
    installProvider();
    const [round] = computeSketchRegions(
      [textObject('text_1', { text: 'o' })],
      resolve
    );
    const kinds = new Set(round!.outer.curves.map((curve) => curve.kind));
    expect(kinds.has('bezier')).toBe(true);
    // Open Sans is a TrueType face, so its 'o' is a small number of
    // quadratics. A flattened circle at any usable tolerance needs far more.
    expect(round!.outer.curves.length).toBeLessThan(24);
    // 'T' is genuinely straight-sided, so this is not "everything is a
    // bezier" passing by accident.
    const [tee] = computeSketchRegions(
      [textObject('text_1', { text: 'T' })],
      resolve
    );
    expect(tee!.outer.curves.every((curve) => curve.kind === 'line')).toBe(
      true
    );
  });

  it('winds outers counter-clockwise and holes clockwise', () => {
    installProvider();
    const profiles = computeSketchRegions(
      [textObject('text_1', { text: 'Bog' })],
      resolve
    );
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(regionLoopSignedArea(profile.outer)).toBeGreaterThan(0);
      expect(profile.holes.length).toBeGreaterThan(0);
      for (const hole of profile.holes) {
        expect(regionLoopSignedArea(hole)).toBeLessThan(0);
      }
      // The reported area is outer minus holes, computed exactly.
      const exact =
        regionLoopSignedArea(profile.outer) +
        profile.holes.reduce(
          (total, hole) => total + regionLoopSignedArea(hole),
          0
        );
      expect(profile.area).toBeCloseTo(exact, 6);
    }
  });

  it('shares one point object across every joint of a loop', () => {
    installProvider();
    const profiles = computeSketchRegions(
      [textObject('text_1', { text: 'Bag' })],
      resolve
    );
    const loops: RegionLoop[] = profiles.flatMap((profile) => [
      profile.outer,
      ...profile.holes
    ]);
    expect(loops.length).toBeGreaterThan(3);
    let joints = 0;
    for (const loop of loops) {
      for (let index = 0; index < loop.curves.length; index += 1) {
        const current = loop.curves[index]!;
        const next = loop.curves[(index + 1) % loop.curves.length]!;
        if (current.kind === 'arc' || next.kind === 'arc') {
          throw new Error('text loops never contain arcs');
        }
        // `makeWire` welds at 1e-7. Object identity is a stronger claim than
        // "within tolerance": it means the doubles cannot differ at all,
        // including across the wrap-around joint.
        expect(Object.is(current.b, next.a)).toBe(true);
        joints += 1;
      }
    }
    expect(joints).toBeGreaterThan(40);
  });

  it('places a sample point inside the region and outside its holes', () => {
    installProvider();
    const [letterO] = computeSketchRegions(
      [textObject('text_1', { text: 'O' })],
      resolve
    );
    const inside = (
      polyline: { x: number; y: number }[],
      px: number,
      py: number
    ) => {
      let hit = false;
      for (let i = 0, j = polyline.length - 1; i < polyline.length; j = i++) {
        const a = polyline[i]!;
        const b = polyline[j]!;
        if (
          a.y > py !== b.y > py &&
          px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x
        ) {
          hit = !hit;
        }
      }
      return hit;
    };
    const sample = letterO!.samplePoint;
    expect(inside(letterO!.outer.polyline, sample.x, sample.y)).toBe(true);
    expect(letterO!.holes).toHaveLength(1);
    expect(inside(letterO!.holes[0]!.polyline, sample.x, sample.y)).toBe(false);
  });
});

describe('the fast path bypasses the arrangement', () => {
  it('hands the arrangement no curves at all for a text-only sketch', () => {
    installProvider();
    // `modelScale` is measured from the curves the arrangement received, and
    // floors at 1. A sketch whose text spans ~22 units reporting a model
    // scale of 1 is a direct observation that `buildSubCurves` and its
    // quadratic neighbours saw nothing — not an inference from timing.
    const analysis = computeSketchProfileAnalysis(
      [textObject('text_1', { text: 'Bog', size: 20 })],
      resolve
    );
    expect(analysis.profiles.length).toBeGreaterThan(0);
    const span = Math.max(
      ...analysis.profiles.map(
        (profile) => profile.boundingBox.max.x - profile.boundingBox.min.x
      )
    );
    expect(span).toBeGreaterThan(5);
    expect(analysis.modelScale).toBe(1);

    // For contrast, an ordinary sketch of the same extent does report it.
    const drawn = computeSketchProfileAnalysis(
      [
        {
          id: 'rect_1',
          data: {
            objectKind: 'rectangle',
            width: 30,
            height: 20,
            centerX: 0,
            centerY: 0
          }
        }
      ],
      resolve
    );
    expect(drawn.modelScale).toBe(30);
  });

  it('grows linearly, not quadratically, as the string grows', () => {
    installProvider();
    const short = computeSketchProfileAnalysis(
      [textObject('text_1', { text: 'Bog' })],
      resolve
    );
    const long = computeSketchProfileAnalysis(
      [textObject('text_1', { text: 'Bog'.repeat(10) })],
      resolve
    );
    const curveCount = (profiles: SketchProfile[]): number =>
      profiles.reduce(
        (total, profile) =>
          total +
          [profile.outer, ...profile.holes].reduce(
            (loopTotal, loop) => loopTotal + loop.curves.length,
            0
          ),
        0
      );
    expect(long.profiles).toHaveLength(short.profiles.length * 10);
    expect(curveCount(long.profiles)).toBe(curveCount(short.profiles) * 10);
    expect(long.diagnostics).toEqual([]);
  });

  it('leaves the arrangement to the other objects in the same sketch', () => {
    installProvider();
    const objects: SketchRegionObject[] = [
      {
        id: 'rect_1',
        data: {
          objectKind: 'rectangle',
          width: 40,
          height: 20,
          centerX: 0,
          centerY: 0
        }
      },
      textObject('text_1', { text: 'Hi', size: 6 })
    ];
    const analysis = computeSketchProfileAnalysis(objects, resolve);
    const fromRect = analysis.profiles.filter((profile) =>
      profile.sourceEntityIds.includes('rect_1')
    );
    const fromText = analysis.profiles.filter((profile) =>
      profile.sourceEntityIds.includes('text_1')
    );
    expect(fromRect).toHaveLength(1);
    // Three, not two: the tittle of the 'i' is its own disconnected region,
    // which is exactly why an extrude over text needs the entity-wide
    // reference rather than one reference per visible letter.
    expect(fromText).toHaveLength(3);
    // The text sits inside the rectangle, yet the rectangle's profile is a
    // plain four-sided cell — the accepted v1 limitation is that text does
    // not intersect the sketch geometry drawn over it.
    expect(fromRect[0]!.outer.curves).toHaveLength(4);
    expect(fromRect[0]!.holes).toHaveLength(0);
    expect(fromRect[0]!.area).toBeCloseTo(800, 9);
  });

  it('skips construction text entirely', () => {
    installProvider();
    const object = textObject('text_1');
    const profiles = computeSketchRegions(
      [{ id: object.id, data: { ...object.data, construction: true } }],
      resolve
    );
    expect(profiles).toEqual([]);
  });
});

describe('failing loudly when a face is unavailable', () => {
  it('reports a diagnostic instead of silently contributing nothing', () => {
    setTextFontProvider(null);
    const analysis = computeSketchProfileAnalysis(
      [textObject('text_1')],
      resolve
    );
    expect(analysis.profiles).toEqual([]);
    expect(analysis.diagnostics).toHaveLength(1);
    expect(analysis.diagnostics[0]!.code).toBe('unresolved-outline');
    expect(analysis.diagnostics[0]!.severity).toBe('error');
    expect(analysis.diagnostics[0]!.sourceEntityIds).toEqual(['text_1']);
    expect(analysis.diagnostics[0]!.message).toContain('font provider');
  });

  it('names the missing face when one style is loaded and another is not', () => {
    installProvider();
    const analysis = computeSketchProfileAnalysis(
      [textObject('text_1', { fontStyle: 'italic' })],
      resolve
    );
    expect(analysis.profiles).toEqual([]);
    expect(analysis.diagnostics[0]!.message).toContain('open-sans');
    expect(analysis.diagnostics[0]!.message).toContain('italic');
    // A different object in the same sketch is unaffected: one bad text
    // object does not abort the whole analysis.
    const mixed = computeSketchProfileAnalysis(
      [
        textObject('text_1', { fontStyle: 'italic' }),
        {
          id: 'circle_1',
          data: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
        }
      ],
      resolve
    );
    expect(mixed.profiles).toHaveLength(1);
    expect(mixed.profiles[0]!.sourceEntityIds).toEqual(['circle_1']);
  });

  it('lets a caller-supplied source override the built-in expansion', () => {
    installProvider();
    const stub: SketchProfile[] = [];
    const analysis = computeSketchProfileAnalysis(
      [textObject('text_1')],
      resolve,
      undefined,
      { profileSource: (object) => (object.id === 'text_1' ? stub : null) }
    );
    expect(analysis.profiles).toEqual([]);
  });

  it('contains a throwing caller-supplied source the same way', () => {
    // The seam is public API, and its contract is the same as the built-in
    // expansion's: one unresolvable object becomes one diagnostic, and the
    // rest of the sketch still yields its regions. Before, the source was
    // called outside the try and took the whole analysis with it.
    installProvider();
    const analysis = computeSketchProfileAnalysis(
      [
        textObject('text_1'),
        {
          id: 'circle_1',
          data: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
        }
      ],
      resolve,
      undefined,
      {
        profileSource: (object) => {
          if (object.id === 'text_1') {
            throw new Error('the injected source refused');
          }
          return null;
        }
      }
    );
    expect(analysis.profiles).toHaveLength(1);
    expect(analysis.profiles[0]!.sourceEntityIds).toEqual(['circle_1']);
    expect(analysis.diagnostics).toHaveLength(1);
    expect(analysis.diagnostics[0]!.code).toBe('unresolved-outline');
    expect(analysis.diagnostics[0]!.message).toContain(
      'the injected source refused'
    );
  });

  it('refuses a family that is not bundled, rather than reading as unloaded', () => {
    installProvider();
    const analysis = computeSketchProfileAnalysis(
      [textObject('text_1', { fontFamily: 'Helvetica' })],
      resolve
    );
    expect(analysis.profiles).toEqual([]);
    expect(analysis.diagnostics[0]!.message).toContain(
      'no bundled font family'
    );
  });
});

describe('styles a family does not ship', () => {
  it('falls back to a real file instead of failing forever', async () => {
    // Oswald ships no designed italic, and the plan's rule is that a missing
    // style degrades to a real face rather than a synthetic shear.
    // `resolveFontStyle` has always encoded that chain; nothing called it at
    // runtime, so `{ oswald, italic }` failed permanently with a message that
    // read like a transient loading problem.
    await library.load('oswald', 'regular');
    installProvider();
    const italic = computeSketchRegions(
      [textObject('text_1', { fontFamily: 'oswald', fontStyle: 'italic' })],
      resolve
    );
    const regular = computeSketchRegions(
      [textObject('text_1', { fontFamily: 'oswald', fontStyle: 'regular' })],
      resolve
    );
    expect(italic).toHaveLength(4);
    // The fallback is the regular face itself, not an approximation of an
    // italic: identical geometry, region for region.
    expect(italic.map((profile) => profile.area)).toEqual(
      regular.map((profile) => profile.area)
    );
  });
});

describe('flattened outlines are flagged, not hidden', () => {
  it('marks a union-resolved glyph as flattened and an exact one as exact', async () => {
    // Inter draws 36 of its 95 ASCII glyphs as overlapping strokes inside one
    // self-intersecting contour; those have to go through the polygon union,
    // which works on polylines and hands back polylines. Open Sans has none.
    // Same letter, same size, opposite fidelity.
    await library.load('inter', 'regular');
    installProvider();
    const flattened = computeSketchRegions(
      [textObject('text_1', { fontFamily: 'inter', text: 'e' })],
      resolve
    );
    const exact = computeSketchRegions(
      [textObject('text_1', { fontFamily: 'open-sans', text: 'e' })],
      resolve
    );
    expect(flattened).toHaveLength(1);
    expect(exact).toHaveLength(1);
    expect(flattened[0]!.outline?.fidelity).toBe('flattened');
    expect(exact[0]!.outline?.fidelity).toBe('exact');
    // The flag is not decoration — it describes what the curves actually are.
    expect(
      flattened[0]!.outer.curves.every((curve) => curve.kind === 'line')
    ).toBe(true);
    expect(
      exact[0]!.outer.curves.some((curve) => curve.kind === 'bezier')
    ).toBe(true);
  });
});

describe('regenerating after an edit', () => {
  it('changes every region when the string changes', () => {
    installProvider();
    const before = computeSketchRegions(
      [textObject('text_1', { text: 'HI' })],
      resolve
    );
    const after = computeSketchRegions(
      [textObject('text_1', { text: 'HELLO' })],
      resolve
    );
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(5);
    // Entity identity is the only thing that survives — which is exactly why
    // the extrude reference mode added in Phase 2 exists.
    expect(
      after.every((profile) => profile.sourceEntityIds[0] === 'text_1')
    ).toBe(true);
  });

  it('is deterministic: the same request gives the same ids', () => {
    installProvider();
    const first = computeSketchRegions([textObject('text_1')], resolve);
    const second = computeSketchRegions([textObject('text_1')], resolve);
    expect(second.map((profile) => profile.profileId)).toEqual(
      first.map((profile) => profile.profileId)
    );
    // …and different ids once a parameter moves a point.
    const bigger = computeSketchRegions(
      [textObject('text_1', { size: 12 })],
      resolve
    );
    expect(bigger.map((profile) => profile.profileId)).not.toEqual(
      first.map((profile) => profile.profileId)
    );
  });

  it('gives every region of one text object a distinct id', () => {
    installProvider();
    // 'TEXT' repeats the same glyph at two positions; a signature that
    // ignored absolute coordinates would collide, and `resolveRegionProfiles`
    // would then reject the extrude for resolving two references to one
    // profile.
    const profiles = computeSketchRegions([textObject('text_1')], resolve);
    expect(new Set(profiles.map((profile) => profile.profileId)).size).toBe(4);
    expect(profiles[0]!.regionFingerprint).not.toBe(
      profiles[3]!.regionFingerprint
    );
  });

  it('drives size from a parameter expression', () => {
    installProvider();
    const scoped = (value: ParamValue): number =>
      typeof value === 'number' ? value : value === 'labelSize * 2' ? 10 : NaN;
    const expression = computeSketchRegions(
      [textObject('text_1', { size: 'labelSize * 2' })],
      scoped
    );
    const literal = computeSketchRegions([textObject('text_1')], resolve);
    expect(expression.map((profile) => profile.area)).toEqual(
      literal.map((profile) => profile.area)
    );
  });
});
