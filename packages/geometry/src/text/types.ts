/**
 * Types for the text → sketch-profile pipeline.
 *
 * Shapes here mirror `regions.ts` deliberately: a `TextRegion` carries an
 * `outer` loop plus `holes`, exactly like `SketchProfile`, so the Phase 3
 * adapter can hand text straight to the region-extrude path. The one
 * difference is the curve vocabulary — `RegionCurve` knows lines and arcs,
 * while glyphs need quadratic and cubic beziers, which are kept exact rather
 * than flattened (see `docs/plans/text-feature-plan.md`, design decision 4).
 */

/** A point in sketch-plane 2D coordinates. */
export interface TextPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One boundary piece of a glyph loop.
 *
 * `a` and `b` are the segment endpoints; adjacent segments in a loop share the
 * **same point object**, which is what guarantees the bit-identical doubles
 * `makeWire` needs (it welds at 1e-7, and a wire that does not close is the
 * dominant downstream failure mode).
 */
export type TextSegment =
  | { readonly kind: 'line'; readonly a: TextPoint; readonly b: TextPoint }
  | {
      readonly kind: 'quadratic';
      readonly a: TextPoint;
      readonly control: TextPoint;
      readonly b: TextPoint;
    }
  | {
      readonly kind: 'cubic';
      readonly a: TextPoint;
      readonly control1: TextPoint;
      readonly control2: TextPoint;
      readonly b: TextPoint;
    };

export type TextWinding = 'ccw' | 'cw';

export interface TextBoundingBox {
  readonly min: TextPoint;
  readonly max: TextPoint;
}

/** A closed boundary. The first segment's `a` is the last segment's `b`. */
export interface TextLoop {
  readonly segments: readonly TextSegment[];
  /** Outer loops are normalized to `'ccw'`, holes to `'cw'`. */
  readonly winding: TextWinding;
  /** Exact signed area under Green's theorem; sign matches `winding`. */
  readonly signedArea: number;
  readonly boundingBox: TextBoundingBox;
}

/** One connected filled area: an outer boundary and the counters inside it. */
export interface TextRegion {
  readonly outer: TextLoop;
  readonly holes: readonly TextLoop[];
  /** Positive area of the region with holes subtracted. */
  readonly area: number;
  readonly boundingBox: TextBoundingBox;
  /** A point inside the region and outside its holes, as `SketchProfile` has. */
  readonly samplePoint: TextPoint;
  /**
   * Layout indices of the glyphs that contributed boundary geometry. More
   * than one entry means the region came out of the overlap union.
   */
  readonly glyphIndices: readonly number[];
  /**
   * `'exact'` regions keep the font's beziers. `'unioned'` regions were
   * merged with overlapping neighbours, which flattens them to polylines —
   * every segment of a unioned region has `kind: 'line'`.
   */
  readonly source: 'exact' | 'unioned';
}

/** One glyph as laid out, before hole assignment and overlap merging. */
export interface PlacedGlyph {
  /** Index into the laid-out glyph run (not the source string index). */
  readonly index: number;
  /** Source string character (a single code point). */
  readonly char: string;
  /** Font glyph index; 0 means `.notdef`. */
  readonly glyphIndex: number;
  /** Pen position in font units before this glyph, including kerning. */
  readonly penUnits: number;
  /** Baseline index; 0 is the first line. */
  readonly line: number;
  /** Advance in font units, after letter spacing. */
  readonly advanceUnits: number;
}

export type FontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';

export type TextAlign = 'left' | 'center' | 'right';

/** Parameters a text sketch object stores; everything else is derived. */
export interface TextRequest {
  readonly text: string;
  /** Em size in model units. */
  readonly size: number;
  /** Sketch-plane origin of the first baseline. Defaults to (0, 0). */
  readonly x?: number;
  readonly y?: number;
  /** Rotation about (`x`, `y`) in radians. Defaults to 0. */
  readonly rotation?: number;
  /** Horizontal alignment of each line about `x`. Defaults to `'left'`. */
  readonly align?: TextAlign;
  /** Extra advance between glyphs, in em fractions. Defaults to 0. */
  readonly letterSpacing?: number;
  /** Baseline-to-baseline distance in em fractions. Defaults to 1.2. */
  readonly lineHeight?: number;
}

export interface TextProfileOptions {
  /** Apply the font's kerning pairs. Defaults to `true`. */
  readonly kerning?: boolean;
  /**
   * Merge glyphs whose outlines actually overlap. Defaults to `true`.
   * Merging flattens the affected regions to polylines.
   */
  readonly mergeOverlaps?: boolean;
  /**
   * Chord tolerance used when beziers must be flattened (containment tests
   * and the overlap union), as a fraction of `size`. Defaults to 1/500.
   */
  readonly flattenToleranceRatio?: number;
  /** Overlap union implementation. Defaults to the local fallback. */
  readonly polygonUnion2d?: PolygonUnion2d;
}

/**
 * Signature of the planned brepkit `polygonUnion2d` binding
 * (`docs/plans/text-feature-plan.md`, Phase 0.1).
 *
 * Input and output are flat `[x0, y0, x1, y1, ...]` coordinate arrays, one per
 * closed loop, first point not repeated. The result is a flat list of loops:
 * CCW loops are outer boundaries, CW loops are holes; nesting is recovered by
 * containment. Inputs follow the same convention (outer CCW, hole CW) and are
 * unioned under the nonzero fill rule.
 */
export type PolygonUnion2d = (loops: readonly Float64Array[]) => Float64Array[];

export interface TextProfileSet {
  readonly family: string;
  readonly style: FontStyle;
  readonly text: string;
  readonly size: number;
  readonly regions: readonly TextRegion[];
  readonly glyphs: readonly PlacedGlyph[];
  /** Total advance of the widest line, in model units. */
  readonly advanceWidth: number;
  /** Number of baselines produced (1 unless the string contains newlines). */
  readonly lineCount: number;
  readonly boundingBox: TextBoundingBox;
  /** Characters with no glyph in the font, in order of first appearance. */
  readonly missingChars: readonly string[];
  /** True when at least one region came out of the overlap union. */
  readonly merged: boolean;
  /**
   * Layout indices of the glyphs whose exact beziers were given up to
   * resolve an overlap. Phase 3 should surface this — those regions are
   * polylines, not curves.
   */
  readonly unionedGlyphs: readonly number[];
}

export class TextGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextGeometryError';
  }
}
