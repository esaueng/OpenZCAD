/**
 * Minimal, hand-verified typings for `opentype.js` 2.x.
 *
 * The package ships no declarations and the DefinitelyTyped package targets
 * the 1.x shape (a flat `names` record, among other differences). Rather than
 * type against an API that does not match the runtime, this declares exactly
 * the surface `@openzcad/geometry`'s text module uses, checked against
 * `opentype.js/dist/opentype.mjs`.
 *
 * Two things worth remembering, because they are easy to get wrong:
 * - `glyph.path.commands` are in **font units with y pointing up**. It is
 *   `Glyph.getPath()` that negates y for screen space; the raw command list
 *   does not. The text module consumes the raw commands and applies its own
 *   sketch-plane transform.
 * - `font.names` is grouped by platform (`windows` / `macintosh` / `unicode`)
 *   and each record is a language map, not a plain string.
 */
declare module 'opentype.js' {
  export interface PathCommandMove {
    type: 'M';
    x: number;
    y: number;
  }
  export interface PathCommandLine {
    type: 'L';
    x: number;
    y: number;
  }
  export interface PathCommandQuadratic {
    type: 'Q';
    x1: number;
    y1: number;
    x: number;
    y: number;
  }
  export interface PathCommandCubic {
    type: 'C';
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    x: number;
    y: number;
  }
  export interface PathCommandClose {
    type: 'Z';
  }

  export type PathCommand =
    | PathCommandMove
    | PathCommandLine
    | PathCommandQuadratic
    | PathCommandCubic
    | PathCommandClose;

  export class Path {
    commands: PathCommand[];
    unitsPerEm?: number;
  }

  export class Glyph {
    index: number;
    name: string | null;
    unicode?: number;
    advanceWidth?: number;
    leftSideBearing?: number;
    readonly path: Path;
  }

  /** Language-tagged name records, e.g. `{ en: 'Copyright ...' }`. */
  export type NameRecord = Record<string, string | undefined>;

  export interface FontNames {
    windows?: Record<string, NameRecord | undefined>;
    macintosh?: Record<string, NameRecord | undefined>;
    unicode?: Record<string, NameRecord | undefined>;
  }

  export class Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    numGlyphs: number;
    names: FontNames;
    charToGlyph(char: string): Glyph;
    charToGlyphIndex(char: string): number;
    /** Resolves `kern` and GPOS pair adjustments; 0 when the pair is unkerned. */
    getKerningValue(left: Glyph | number, right: Glyph | number): number;
  }

  export interface ParseOptions {
    lowMemory?: boolean;
  }

  export function parse(buffer: ArrayBuffer, options?: ParseOptions): Font;
}
