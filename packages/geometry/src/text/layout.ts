/**
 * Text layout: advances, kerning, line breaks and alignment.
 *
 * Everything stays in font units until the very last step, so the pen position
 * is exact integer arithmetic for as long as possible and the sketch-plane
 * transform happens in exactly one place (`glyphTransform`).
 */
import type { LoadedFont } from './loader';
import type { PlacedGlyph, TextRequest } from './types';

export const DEFAULT_LINE_HEIGHT = 1.2;

export interface TextLayout {
  readonly glyphs: readonly PlacedGlyph[];
  /** Per-line advance width in font units, after letter spacing. */
  readonly lineWidths: readonly number[];
  /** Alignment shift applied to each line, in font units. */
  readonly lineOffsets: readonly number[];
  readonly lineCount: number;
  readonly missingChars: readonly string[];
}

export interface LayoutOptions {
  readonly kerning?: boolean;
}

/**
 * Splits into code points, not UTF-16 units, so astral characters survive.
 * Carriage returns are normalized away before splitting.
 */
function lineCodePoints(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => Array.from(line));
}

export function layoutText(
  loaded: LoadedFont,
  request: TextRequest,
  options: LayoutOptions = {}
): TextLayout {
  const { font, unitsPerEm } = loaded;
  const useKerning = options.kerning !== false;
  const letterSpacingUnits = (request.letterSpacing ?? 0) * unitsPerEm;
  const lines = lineCodePoints(request.text);

  const glyphs: PlacedGlyph[] = [];
  const lineWidths: number[] = [];
  const missing: string[] = [];
  const missingSeen = new Set<string>();
  let index = 0;

  for (let line = 0; line < lines.length; line += 1) {
    const chars = lines[line]!;
    let pen = 0;
    let previousGlyphIndex: number | null = null;
    for (const char of chars) {
      const glyphIndex = font.charToGlyphIndex(char);
      const glyph = font.charToGlyph(char);
      if (glyphIndex === 0 && !missingSeen.has(char)) {
        missingSeen.add(char);
        missing.push(char);
      }
      if (useKerning && previousGlyphIndex !== null) {
        pen += font.getKerningValue(previousGlyphIndex, glyphIndex);
      }
      const advanceUnits = (glyph.advanceWidth ?? 0) + letterSpacingUnits;
      glyphs.push({
        index,
        char,
        glyphIndex,
        penUnits: pen,
        line,
        advanceUnits
      });
      index += 1;
      pen += advanceUnits;
      previousGlyphIndex = glyphIndex;
    }
    lineWidths.push(pen);
  }

  const align = request.align ?? 'left';
  const lineOffsets = lineWidths.map((width) => {
    if (align === 'center') {
      return -width / 2;
    }
    if (align === 'right') {
      return -width;
    }
    return 0;
  });

  return {
    glyphs,
    lineWidths,
    lineOffsets,
    lineCount: lines.length,
    missingChars: missing
  };
}

/**
 * Maps font-unit glyph coordinates into the sketch plane.
 *
 * One closure per glyph, and every point of that glyph goes through it. That
 * is what keeps a shared endpoint bit-identical: the same inputs run the same
 * expression, never two arrangements of the same algebra.
 */
export type GlyphTransform = (gx: number, gy: number) => { x: number; y: number };

export function glyphTransform(
  loaded: LoadedFont,
  request: TextRequest,
  layout: TextLayout,
  placed: PlacedGlyph
): GlyphTransform {
  const scale = request.size / loaded.unitsPerEm;
  const originX = request.x ?? 0;
  const originY = request.y ?? 0;
  const rotation = request.rotation ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const shiftUnits = placed.penUnits + (layout.lineOffsets[placed.line] ?? 0);
  const lineHeight = request.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const baseline = -placed.line * lineHeight * request.size;
  return (gx, gy) => {
    const localX = (shiftUnits + gx) * scale;
    const localY = gy * scale + baseline;
    return {
      x: originX + cos * localX - sin * localY,
      y: originY + sin * localX + cos * localY
    };
  };
}
