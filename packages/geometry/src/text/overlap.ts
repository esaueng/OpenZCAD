/**
 * Overlap resolution: within a glyph, and between touching glyphs.
 *
 * Two different overlaps have to be dealt with, and both end at the same
 * union:
 *
 * **Self-overlap.** Real fonts do not draw glyphs as clean outer-plus-counter
 * outlines. They draw overlapping strokes and let the nonzero fill rule sort
 * it out — in the bundled set, 36 of 95 ASCII glyphs in Inter and 20 in
 * JetBrains Mono have contours that cross themselves or each other (Open Sans
 * and Pacifico have none, Lora and Oswald one each). A renderer does not care;
 * a B-Rep face does, because a self-intersecting wire is not a valid boundary.
 * Those glyphs must be resolved before they reach the kernel.
 *
 * **Inter-glyph overlap.** Script faces and tight kerning let neighbours share
 * ink. Handing the kernel two overlapping profiles produces near-tangent
 * solids, and their 3D fuse is exactly the sliver case booleans handle worst.
 *
 * Resolution costs the exact beziers — the union works on polylines — so it
 * runs only where it must. A glyph whose contours are clean and which touches
 * nothing keeps its curves, and `TextRegion.source` says which happened.
 */
import { boundsOverlap, flattenLoop, mergeBounds, orientLoop, point } from './loops';
import { assembleRegions, windingNumber } from './nesting';
import { localPolygonUnion2d } from './polygonUnion';
import type { LoopEntry } from './nesting';
import type {
  PolygonUnion2d,
  TextBoundingBox,
  TextLoop,
  TextRegion,
  TextSegment
} from './types';

interface FlatPoint {
  x: number;
  y: number;
}

interface FlatLoop {
  polygon: FlatPoint[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GlyphShape {
  /** Layout index of the glyph these loops came from. */
  readonly glyphIndex: number;
  /**
   * Regions with the font's exact beziers. Empty when the glyph's own
   * contours overlap and it has to go through the union.
   */
  readonly exactRegions: readonly TextRegion[];
  /** The font's contours, as extracted, before any resolution. */
  readonly rawContours: readonly TextLoop[];
  /** Flattened boundary loops, oriented so material is on the left. */
  readonly loops: readonly FlatLoop[];
  readonly bounds: TextBoundingBox;
  readonly selfOverlapping: boolean;
}

function flatLoopOf(loop: TextLoop, tolerance: number): FlatLoop {
  const polygon = flattenLoop(loop.segments, tolerance);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const vertex of polygon) {
    minX = Math.min(minX, vertex.x);
    maxX = Math.max(maxX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxY = Math.max(maxY, vertex.y);
  }
  return { polygon, minX, minY, maxX, maxY };
}

/** Proper crossing only; shared endpoints and touching do not count. */
function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): boolean {
  const r1x = bx - ax;
  const r1y = by - ay;
  const r2x = dx - cx;
  const r2y = dy - cy;
  const denominator = r1x * r2y - r1y * r2x;
  if (denominator === 0) {
    return false;
  }
  const ex = cx - ax;
  const ey = cy - ay;
  const t = (ex * r2y - ey * r2x) / denominator;
  const u = (ex * r1y - ey * r1x) / denominator;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

interface IndexedSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  loop: number;
  index: number;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function segmentsOf(loops: readonly FlatLoop[]): IndexedSegment[] {
  const segments: IndexedSegment[] = [];
  for (let loop = 0; loop < loops.length; loop += 1) {
    const polygon = loops[loop]!.polygon;
    const count = polygon.length;
    for (let index = 0; index < count; index += 1) {
      const a = polygon[index]!;
      const b = polygon[(index + 1) % count]!;
      segments.push({
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
        loop,
        index,
        count,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y)
      });
    }
  }
  return segments;
}

function disjointBounds(left: IndexedSegment, right: IndexedSegment): boolean {
  return (
    left.maxX < right.minX ||
    right.maxX < left.minX ||
    left.maxY < right.minY ||
    right.maxY < left.minY
  );
}

/**
 * True when the glyph's own outline crosses itself, or one of its contours
 * crosses another. Neighbouring segments of the same contour are skipped —
 * they share a vertex by construction.
 */
function loopsSelfOverlap(loops: readonly FlatLoop[]): boolean {
  const segments = segmentsOf(loops);
  for (let i = 0; i < segments.length; i += 1) {
    const left = segments[i]!;
    for (let j = i + 1; j < segments.length; j += 1) {
      const right = segments[j]!;
      if (left.loop === right.loop) {
        const gap = Math.abs(left.index - right.index);
        if (gap === 1 || gap === left.count - 1) {
          continue;
        }
      }
      if (disjointBounds(left, right)) {
        continue;
      }
      if (
        segmentsCross(
          left.ax,
          left.ay,
          left.bx,
          left.by,
          right.ax,
          right.ay,
          right.bx,
          right.by
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Flips every contour when the font wound them the other way, so that
 * material always ends up on the left of a directed edge. That is the
 * convention the union classifies against, and it survives self-overlap,
 * where outer-versus-hole is not yet decidable.
 */
function normalizeGlyphWinding(contours: readonly TextLoop[]): TextLoop[] {
  const total = contours.reduce((sum, loop) => sum + loop.signedArea, 0);
  if (total >= 0) {
    return [...contours];
  }
  return contours.map((loop) =>
    orientLoop(loop, loop.winding === 'ccw' ? 'cw' : 'ccw')
  );
}

export function glyphShapeOf(
  glyphIndex: number,
  contours: readonly TextLoop[],
  flattenTolerance: number
): GlyphShape {
  const rawLoops = contours.map((loop) => flatLoopOf(loop, flattenTolerance));
  const selfOverlapping = loopsSelfOverlap(rawLoops);
  if (!selfOverlapping) {
    const entries: LoopEntry[] = contours.map((loop) => ({
      loop,
      glyphIndices: [glyphIndex]
    }));
    const exactRegions = assembleRegions(entries, flattenTolerance, 'exact');
    const loops: FlatLoop[] = [];
    for (const region of exactRegions) {
      loops.push(flatLoopOf(region.outer, flattenTolerance));
      for (const hole of region.holes) {
        loops.push(flatLoopOf(hole, flattenTolerance));
      }
    }
    return {
      glyphIndex,
      exactRegions,
      rawContours: contours,
      loops,
      bounds: mergeBounds(rawLoops.map(boundsOfFlatLoop)),
      selfOverlapping: false
    };
  }
  const normalized = normalizeGlyphWinding(contours);
  const loops = normalized.map((loop) => flatLoopOf(loop, flattenTolerance));
  return {
    glyphIndex,
    exactRegions: [],
    rawContours: contours,
    loops,
    bounds: mergeBounds(loops.map(boundsOfFlatLoop)),
    selfOverlapping: true
  };
}

function boundsOfFlatLoop(loop: FlatLoop): TextBoundingBox {
  return {
    min: point(loop.minX, loop.minY),
    max: point(loop.maxX, loop.maxY)
  };
}

function loopsCross(left: FlatLoop, right: FlatLoop): boolean {
  if (
    left.maxX < right.minX ||
    right.maxX < left.minX ||
    left.maxY < right.minY ||
    right.maxY < left.minY
  ) {
    return false;
  }
  for (let i = 0; i < left.polygon.length; i += 1) {
    const a = left.polygon[i]!;
    const b = left.polygon[(i + 1) % left.polygon.length]!;
    const loMinX = Math.min(a.x, b.x);
    const loMaxX = Math.max(a.x, b.x);
    const loMinY = Math.min(a.y, b.y);
    const loMaxY = Math.max(a.y, b.y);
    if (
      loMaxX < right.minX ||
      right.maxX < loMinX ||
      loMaxY < right.minY ||
      right.maxY < loMinY
    ) {
      continue;
    }
    for (let j = 0; j < right.polygon.length; j += 1) {
      const c = right.polygon[j]!;
      const d = right.polygon[(j + 1) % right.polygon.length]!;
      if (segmentsCross(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)) {
        return true;
      }
    }
  }
  return false;
}

/** Nonzero fill test against a glyph's normalized loops. */
function shapeContainsPoint(shape: GlyphShape, px: number, py: number): boolean {
  let winding = 0;
  for (const loop of shape.loops) {
    if (px < loop.minX || px > loop.maxX || py < loop.minY || py > loop.maxY) {
      continue;
    }
    winding += windingNumber(loop.polygon, px, py);
  }
  return winding !== 0;
}

/** True when the two glyphs share ink, not merely a bounding box. */
export function glyphsOverlap(left: GlyphShape, right: GlyphShape): boolean {
  if (!boundsOverlap(left.bounds, right.bounds)) {
    return false;
  }
  for (const a of left.loops) {
    for (const b of right.loops) {
      if (loopsCross(a, b)) {
        return true;
      }
    }
  }
  const leftProbe = left.loops[0]?.polygon[0];
  if (leftProbe && shapeContainsPoint(right, leftProbe.x, leftProbe.y)) {
    return true;
  }
  const rightProbe = right.loops[0]?.polygon[0];
  if (rightProbe && shapeContainsPoint(left, rightProbe.x, rightProbe.y)) {
    return true;
  }
  return false;
}

/** Union-find over the glyph shapes, joined by real ink overlap. */
function clusterShapes(shapes: readonly GlyphShape[]): number[][] {
  const parent = shapes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      if (!boundsOverlap(shapes[i]!.bounds, shapes[j]!.bounds)) {
        continue;
      }
      if (!glyphsOverlap(shapes[i]!, shapes[j]!)) {
        continue;
      }
      const a = find(i);
      const b = find(j);
      if (a !== b) {
        parent[b] = a;
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < shapes.length; i += 1) {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) {
      bucket.push(i);
    } else {
      groups.set(root, [i]);
    }
  }
  return [...groups.values()].map((group) => group.sort((a, b) => a - b));
}

function loopToFlatArray(loop: FlatLoop): Float64Array {
  const flat = new Float64Array(loop.polygon.length * 2);
  for (let i = 0; i < loop.polygon.length; i += 1) {
    flat[i * 2] = loop.polygon[i]!.x;
    flat[i * 2 + 1] = loop.polygon[i]!.y;
  }
  return flat;
}

/**
 * Rebuilds a polyline loop as line segments. Neighbouring segments share the
 * same point object, including across the closing joint.
 */
function polylineLoop(flat: Float64Array): TextLoop {
  const count = flat.length / 2;
  const points = Array.from({ length: count }, (_, i) =>
    point(flat[i * 2]!, flat[i * 2 + 1]!)
  );
  const segments: TextSegment[] = [];
  for (let i = 0; i < count; i += 1) {
    segments.push({
      kind: 'line',
      a: points[i]!,
      b: points[(i + 1) % count]!
    });
  }
  let twiceArea = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % count]!;
    twiceArea += a.x * b.y - b.x * a.y;
    minX = Math.min(minX, a.x);
    maxX = Math.max(maxX, a.x);
    minY = Math.min(minY, a.y);
    maxY = Math.max(maxY, a.y);
  }
  const signedArea = twiceArea / 2;
  return Object.freeze({
    segments: Object.freeze(segments),
    winding: signedArea >= 0 ? ('ccw' as const) : ('cw' as const),
    signedArea,
    boundingBox: { min: point(minX, minY), max: point(maxX, maxY) }
  });
}

export interface MergeResult {
  readonly regions: TextRegion[];
  /** True when at least one region went through the union. */
  readonly merged: boolean;
  /** Layout indices of glyphs whose exact curves were given up. */
  readonly unionedGlyphs: number[];
}

/**
 * Resolves every overlap and returns the regions. Glyphs with clean contours
 * that touch nothing come back untouched, exact beziers intact.
 */
export function mergeOverlappingGlyphs(
  shapes: readonly GlyphShape[],
  flattenTolerance: number,
  polygonUnion2d: PolygonUnion2d = localPolygonUnion2d
): MergeResult {
  const clusters = clusterShapes(shapes);
  const regions: TextRegion[] = [];
  const unionedGlyphs: number[] = [];
  let merged = false;
  for (const cluster of clusters) {
    const needsUnion =
      cluster.length > 1 || shapes[cluster[0]!]!.selfOverlapping;
    if (!needsUnion) {
      regions.push(...shapes[cluster[0]!]!.exactRegions);
      continue;
    }
    merged = true;
    const glyphIndices = cluster.map((index) => shapes[index]!.glyphIndex);
    unionedGlyphs.push(...glyphIndices);
    const flat: Float64Array[] = [];
    for (const index of cluster) {
      for (const loop of shapes[index]!.loops) {
        flat.push(loopToFlatArray(loop));
      }
    }
    const unioned = polygonUnion2d(flat);
    const entries: LoopEntry[] = unioned
      .filter((loop) => loop.length >= 6)
      .map((loop) => ({ loop: polylineLoop(loop), glyphIndices }));
    regions.push(...assembleRegions(entries, flattenTolerance, 'unioned'));
  }
  return { regions, merged, unionedGlyphs };
}
