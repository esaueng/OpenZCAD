/**
 * Containment-based hole assignment under the nonzero fill rule.
 *
 * A font does not label which contour is an outer boundary and which is a
 * counter — it relies on winding plus containment. Nesting depth recovers that
 * directly: a loop contained in an even number of other loops bounds material,
 * a loop contained in an odd number bounds a void. Depth also handles the
 * nested case (the 'R' inside '®' sits inside the circle's counter and is
 * material again) which a two-level outer/hole split would get wrong.
 */
import { boundsOverlap, flattenLoop, orientLoop, point } from './loops';
import type { TextLoop, TextRegion } from './types';

interface FlatPoint {
  x: number;
  y: number;
}

export interface LoopEntry {
  readonly loop: TextLoop;
  /** Layout indices of the glyphs that contributed this loop. */
  readonly glyphIndices: readonly number[];
}

interface AnalyzedLoop {
  entry: LoopEntry;
  polygon: FlatPoint[];
  /** A point strictly inside the area the loop encloses. */
  probe: FlatPoint;
  depth: number;
  parent: number;
}

function isLeft(a: FlatPoint, b: FlatPoint, px: number, py: number): number {
  return (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
}

/** Standard winding number; nonzero means the point is inside the polygon. */
export function windingNumber(
  polygon: readonly FlatPoint[],
  px: number,
  py: number
): number {
  let winding = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (a.y <= py) {
      if (b.y > py && isLeft(a, b, px, py) > 0) {
        winding += 1;
      }
    } else if (b.y <= py && isLeft(a, b, px, py) < 0) {
      winding -= 1;
    }
  }
  return winding;
}

export function polygonContains(
  polygon: readonly FlatPoint[],
  px: number,
  py: number
): boolean {
  return windingNumber(polygon, px, py) !== 0;
}

/**
 * A point inside the enclosed area, taken just off the midpoint of the longest
 * edge. Loop vertices themselves are unusable as probes: after the overlap
 * union, loops share vertices, and a probe sitting exactly on another loop's
 * boundary has no well-defined containment.
 */
function interiorProbe(
  polygon: readonly FlatPoint[],
  ccw: boolean,
  offset: number
): FlatPoint {
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      best = i;
    }
  }
  const a = polygon[best]!;
  const b = polygon[(best + 1) % polygon.length]!;
  const length = bestLength > 0 ? bestLength : 1;
  const nx = -(b.y - a.y) / length;
  const ny = (b.x - a.x) / length;
  const step = Math.min(offset, length / 4);
  const sign = ccw ? 1 : -1;
  return {
    x: (a.x + b.x) / 2 + sign * nx * step,
    y: (a.y + b.y) / 2 + sign * ny * step
  };
}

/**
 * Groups loops into regions: every even-depth loop becomes a region outer, and
 * the odd-depth loops directly inside it become its holes. Outers come back
 * CCW and holes CW, as the kernel adapter expects.
 */
export function assembleRegions(
  entries: readonly LoopEntry[],
  flattenTolerance: number,
  source: TextRegion['source']
): TextRegion[] {
  const analyzed: AnalyzedLoop[] = entries
    .map((entry) => {
      const polygon = flattenLoop(entry.loop.segments, flattenTolerance);
      return { entry, polygon };
    })
    .filter((item) => item.polygon.length >= 3)
    .map(({ entry, polygon }) => ({
      entry,
      polygon,
      probe: interiorProbe(polygon, entry.loop.winding === 'ccw', flattenTolerance),
      depth: 0,
      parent: -1
    }));

  for (let i = 0; i < analyzed.length; i += 1) {
    const item = analyzed[i]!;
    let depth = 0;
    let parent = -1;
    let parentDepth = -1;
    for (let j = 0; j < analyzed.length; j += 1) {
      if (i === j) {
        continue;
      }
      const other = analyzed[j]!;
      if (!boundsOverlap(item.entry.loop.boundingBox, other.entry.loop.boundingBox)) {
        continue;
      }
      if (!polygonContains(other.polygon, item.probe.x, item.probe.y)) {
        continue;
      }
      depth += 1;
      // The immediate parent is the deepest container; depths are resolved in
      // a second pass because they are not known yet on this one.
      if (parent === -1) {
        parent = j;
      }
    }
    item.depth = depth;
    item.parent = parent;
  }

  // Re-resolve parents now that depths are known: the immediate parent of a
  // loop at depth d is the container whose depth is d − 1.
  for (let i = 0; i < analyzed.length; i += 1) {
    const item = analyzed[i]!;
    if (item.depth === 0) {
      item.parent = -1;
      continue;
    }
    let parent = -1;
    for (let j = 0; j < analyzed.length; j += 1) {
      if (i === j) {
        continue;
      }
      const other = analyzed[j]!;
      if (other.depth !== item.depth - 1) {
        continue;
      }
      if (!boundsOverlap(item.entry.loop.boundingBox, other.entry.loop.boundingBox)) {
        continue;
      }
      if (polygonContains(other.polygon, item.probe.x, item.probe.y)) {
        parent = j;
        break;
      }
    }
    item.parent = parent;
  }

  const regions: TextRegion[] = [];
  for (let i = 0; i < analyzed.length; i += 1) {
    const item = analyzed[i]!;
    if (item.depth % 2 !== 0) {
      continue;
    }
    const outer = orientLoop(item.entry.loop, 'ccw');
    // `item.probe` sits a hair inside the outer boundary, so it is inside the
    // region and outside every hole (holes are strictly interior).
    const samplePoint = point(item.probe.x, item.probe.y);
    const holes: TextLoop[] = [];
    const glyphIndices = new Set(item.entry.glyphIndices);
    let area = Math.abs(outer.signedArea);
    for (let j = 0; j < analyzed.length; j += 1) {
      const other = analyzed[j]!;
      if (other.depth !== item.depth + 1 || other.parent !== i) {
        continue;
      }
      const hole = orientLoop(other.entry.loop, 'cw');
      holes.push(hole);
      area -= Math.abs(hole.signedArea);
      for (const index of other.entry.glyphIndices) {
        glyphIndices.add(index);
      }
    }
    regions.push(
      Object.freeze({
        outer,
        holes: Object.freeze(holes),
        area,
        boundingBox: outer.boundingBox,
        samplePoint,
        glyphIndices: Object.freeze([...glyphIndices].sort((a, b) => a - b)),
        source
      })
    );
  }
  return regions;
}
