/**
 * The glyph pipeline: layout → contours → winding normalization →
 * containment-based hole assignment → bbox-gated overlap union.
 *
 * `buildTextProfileSet` is pure and deterministic: same font bytes and same
 * request, same doubles out. `textProfileSet` is the memoized front door,
 * keyed by everything that can change the geometry.
 */
import { glyphLoops } from './contours';
import { glyphTransform, layoutText } from './layout';
import { mergeBounds, point } from './loops';
import { assembleRegions } from './nesting';
import { glyphShapeOf, mergeOverlappingGlyphs } from './overlap';
import { localPolygonUnion2d } from './polygonUnion';
import { TextGeometryError } from './types';
import type { GlyphShape } from './overlap';
import type { LoadedFont } from './loader';
import type {
  PolygonUnion2d,
  TextProfileOptions,
  TextProfileSet,
  TextRegion,
  TextRequest
} from './types';

/** Chord tolerance for the flattening the containment and union steps need. */
const DEFAULT_FLATTEN_TOLERANCE_RATIO = 1 / 500;

function requireFiniteSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    throw new TextGeometryError(
      `Text size must be a positive finite number; received ${String(size)}.`
    );
  }
  return size;
}

export function buildTextProfileSet(
  loaded: LoadedFont,
  request: TextRequest,
  options: TextProfileOptions = {}
): TextProfileSet {
  const size = requireFiniteSize(request.size);
  const flattenTolerance =
    size * (options.flattenToleranceRatio ?? DEFAULT_FLATTEN_TOLERANCE_RATIO);
  const layout = layoutText(loaded, request, { kerning: options.kerning });

  const shapes: GlyphShape[] = [];
  for (const placed of layout.glyphs) {
    const glyph = loaded.font.charToGlyph(placed.char);
    const transform = glyphTransform(loaded, request, layout, placed);
    const loops = glyphLoops(glyph, transform, size);
    if (loops.length === 0) {
      continue;
    }
    shapes.push(glyphShapeOf(placed.index, loops, flattenTolerance));
  }

  let regions: readonly TextRegion[];
  let merged = false;
  let unionedGlyphs: readonly number[] = [];
  if (options.mergeOverlaps === false) {
    // Diagnostic path only: the font's raw contours reach the output
    // unresolved, so self-overlapping glyphs stay self-intersecting.
    regions = shapes.flatMap((shape) =>
      shape.exactRegions.length > 0
        ? shape.exactRegions
        : assembleRegions(
            shape.rawContours.map((loop) => ({
              loop,
              glyphIndices: [shape.glyphIndex]
            })),
            flattenTolerance,
            'exact'
          )
    );
  } else {
    const result = mergeOverlappingGlyphs(
      shapes,
      flattenTolerance,
      options.polygonUnion2d ?? localPolygonUnion2d
    );
    regions = result.regions;
    merged = result.merged;
    unionedGlyphs = result.unionedGlyphs;
  }

  const scale = size / loaded.unitsPerEm;
  const advanceWidth =
    layout.lineWidths.length > 0 ? Math.max(...layout.lineWidths) * scale : 0;
  const origin = point(request.x ?? 0, request.y ?? 0);
  const boundingBox =
    regions.length > 0
      ? mergeBounds(regions.map((region) => region.boundingBox))
      : { min: origin, max: origin };

  return Object.freeze({
    family: loaded.family,
    style: loaded.style,
    text: request.text,
    size,
    regions: Object.freeze([...regions]),
    glyphs: layout.glyphs,
    advanceWidth,
    lineCount: layout.lineCount,
    boundingBox,
    missingChars: layout.missingChars,
    merged,
    unionedGlyphs: Object.freeze([...unionedGlyphs])
  });
}

// ---------------------------------------------------------------------------
// Cache.
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 256;

function cacheKey(
  loaded: LoadedFont,
  request: TextRequest,
  options: TextProfileOptions
): string {
  return JSON.stringify([
    loaded.familyId,
    loaded.style,
    loaded.file,
    request.text,
    request.size,
    request.x ?? 0,
    request.y ?? 0,
    request.rotation ?? 0,
    request.align ?? 'left',
    request.letterSpacing ?? 0,
    request.lineHeight ?? null,
    options.kerning !== false,
    options.mergeOverlaps !== false,
    options.flattenToleranceRatio ?? null
  ]);
}

const defaultCache = new Map<string, TextProfileSet>();
const unionCaches = new WeakMap<PolygonUnion2d, Map<string, TextProfileSet>>();

function cacheFor(union: PolygonUnion2d | undefined): Map<string, TextProfileSet> {
  if (!union) {
    return defaultCache;
  }
  const existing = unionCaches.get(union);
  if (existing) {
    return existing;
  }
  const created = new Map<string, TextProfileSet>();
  unionCaches.set(union, created);
  return created;
}

/**
 * Memoized `buildTextProfileSet`, keyed by `(family, style, text, size)` plus
 * every other parameter that moves a point. Entries are dropped oldest-first
 * past `CACHE_LIMIT`; the set is frozen, so sharing one is safe.
 */
export function textProfileSet(
  loaded: LoadedFont,
  request: TextRequest,
  options: TextProfileOptions = {}
): TextProfileSet {
  const cache = cacheFor(options.polygonUnion2d);
  const key = cacheKey(loaded, request, options);
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }
  const built = buildTextProfileSet(loaded, request, options);
  cache.set(key, built);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  return built;
}

export function clearTextProfileCache(): void {
  defaultCache.clear();
}
