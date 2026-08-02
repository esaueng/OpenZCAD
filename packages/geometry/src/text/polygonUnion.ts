/**
 * 2D polygon union under the nonzero fill rule.
 *
 * `PolygonUnion2d` is the seam for brepkit's planned `polygonUnion2d` binding
 * (`docs/plans/text-feature-plan.md`, Phase 0.1). That binding is not in the
 * pinned `brepkit-wasm` package yet, so this module ships a local
 * implementation behind the same signature; swap it by passing
 * `polygonUnion2d` in `TextProfileOptions` once the kernel exposes one.
 *
 * The algorithm is boundary classification, not a full arrangement:
 *
 * 1. Split every edge at its intersections with edges of other loops. The
 *    intersection point is computed once and interned, so both edges end on
 *    the same object and the stitched result has bit-identical joints.
 * 2. Keep a sub-edge when material lies on its left and void on its right —
 *    that is exactly the union boundary. Winding is sampled a hair off the
 *    midpoint on each side.
 * 3. Stitch the survivors into closed loops, taking the tightest clockwise
 *    turn at a branch so each traced face keeps its material on the left.
 *
 * Collinear overlap gets its own handling in step 1 — repeated letters ('ll')
 * are the same outline translated, so their vertical and horizontal edges lie
 * on top of each other exactly. Those pieces are split against each other's
 * endpoints so coincident sub-edges end up sharing endpoint objects, and the
 * duplicates are then collapsed. A boundary that still fails to close throws
 * rather than returning a broken loop.
 */
import { TextGeometryError } from './types';
import type { PolygonUnion2d } from './types';

/** Relative slack for calling a cross product zero. */
const PARALLEL_EPSILON = 1e-12;
/** Perpendicular distance, relative to the input span, that still counts as
 * on the line. */
const COLLINEAR_EPSILON = 1e-9;

interface UnionPoint {
  readonly x: number;
  readonly y: number;
}

interface SourceEdge {
  loop: number;
  a: UnionPoint;
  b: UnionPoint;
  splits: number[];
}

interface SubEdge {
  a: UnionPoint;
  b: UnionPoint;
  used: boolean;
}

/**
 * Interns points onto a fine grid so coincident endpoints from different
 * loops become the same object. The 3×3 neighbourhood lookup stops two points
 * that straddle a cell boundary from being treated as distinct.
 */
class PointRegistry {
  private readonly cells = new Map<string, UnionPoint[]>();

  constructor(private readonly quantum: number) {}

  intern(x: number, y: number): UnionPoint {
    const ix = Math.round(x / this.quantum);
    const iy = Math.round(y / this.quantum);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = this.cells.get(`${ix + dx},${iy + dy}`);
        if (!bucket) {
          continue;
        }
        for (const candidate of bucket) {
          if (
            Math.abs(candidate.x - x) <= this.quantum &&
            Math.abs(candidate.y - y) <= this.quantum
          ) {
            return candidate;
          }
        }
      }
    }
    const created: UnionPoint = { x, y };
    const key = `${ix},${iy}`;
    const bucket = this.cells.get(key);
    if (bucket) {
      bucket.push(created);
    } else {
      this.cells.set(key, [created]);
    }
    return created;
  }
}

function loopWindingAt(loop: Float64Array, px: number, py: number): number {
  let winding = 0;
  const count = loop.length / 2;
  for (let i = 0; i < count; i += 1) {
    const ax = loop[i * 2]!;
    const ay = loop[i * 2 + 1]!;
    const j = (i + 1) % count;
    const bx = loop[j * 2]!;
    const by = loop[j * 2 + 1]!;
    const side = (bx - ax) * (py - ay) - (px - ax) * (by - ay);
    if (ay <= py) {
      if (by > py && side > 0) {
        winding += 1;
      }
    } else if (by <= py && side < 0) {
      winding -= 1;
    }
  }
  return winding;
}

function totalWinding(
  loops: readonly Float64Array[],
  px: number,
  py: number
): number {
  let winding = 0;
  for (const loop of loops) {
    winding += loopWindingAt(loop, px, py);
  }
  return winding;
}

function edgeBounds(edge: SourceEdge): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: Math.min(edge.a.x, edge.b.x),
    maxX: Math.max(edge.a.x, edge.b.x),
    minY: Math.min(edge.a.y, edge.b.y),
    maxY: Math.max(edge.a.y, edge.b.y)
  };
}

/** Counter-clockwise angle from `from` to `to`, in `[0, 2π)`. */
function normalizeAngle(value: number): number {
  const wrapped = value % (Math.PI * 2);
  return wrapped < 0 ? wrapped + Math.PI * 2 : wrapped;
}

/**
 * The local `PolygonUnion2d`. Loops arrive as flat `[x0, y0, x1, y1, ...]`
 * arrays with the first point unrepeated, outer loops CCW and holes CW; the
 * result uses the same convention.
 */
export const localPolygonUnion2d: PolygonUnion2d = (loops) => {
  const usable = loops.filter((loop) => loop.length >= 6);
  if (usable.length === 0) {
    return [];
  }
  if (usable.length === 1) {
    return [Float64Array.from(usable[0]!)];
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const loop of usable) {
    for (let i = 0; i < loop.length; i += 2) {
      minX = Math.min(minX, loop[i]!);
      maxX = Math.max(maxX, loop[i]!);
      minY = Math.min(minY, loop[i + 1]!);
      maxY = Math.max(maxY, loop[i + 1]!);
    }
  }
  const span = Math.max(maxX - minX, maxY - minY, Number.MIN_VALUE);
  /** Probe offset for the left/right material test. */
  const probe = span * 1e-9;
  const registry = new PointRegistry(span * 1e-11);

  const edges: SourceEdge[] = [];
  for (let loopIndex = 0; loopIndex < usable.length; loopIndex += 1) {
    const loop = usable[loopIndex]!;
    const count = loop.length / 2;
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      const a = registry.intern(loop[i * 2]!, loop[i * 2 + 1]!);
      const b = registry.intern(loop[j * 2]!, loop[j * 2 + 1]!);
      if (a === b) {
        continue;
      }
      edges.push({ loop: loopIndex, a, b, splits: [] });
    }
  }

  // Split at crossings with edges of other loops. Each crossing point is
  // computed once and interned, so both edges break on the same object.
  const bounds = edges.map(edgeBounds);
  for (let i = 0; i < edges.length; i += 1) {
    const left = edges[i]!;
    const lb = bounds[i]!;
    for (let j = i + 1; j < edges.length; j += 1) {
      const right = edges[j]!;
      // Same-loop pairs are included: real fonts draw many glyphs as
      // overlapping strokes inside a single self-intersecting contour and let
      // the nonzero rule sort it out. Only edges that already share a vertex
      // are skipped — their "intersection" is that vertex.
      if (
        left.a === right.a ||
        left.a === right.b ||
        left.b === right.a ||
        left.b === right.b
      ) {
        continue;
      }
      const rb = bounds[j]!;
      if (
        lb.maxX < rb.minX ||
        rb.maxX < lb.minX ||
        lb.maxY < rb.minY ||
        rb.maxY < lb.minY
      ) {
        continue;
      }
      const r1x = left.b.x - left.a.x;
      const r1y = left.b.y - left.a.y;
      const r2x = right.b.x - right.a.x;
      const r2y = right.b.y - right.a.y;
      const denominator = r1x * r2y - r1y * r2x;
      const len1 = Math.hypot(r1x, r1y);
      const len2 = Math.hypot(r2x, r2y);
      const dx = right.a.x - left.a.x;
      const dy = right.a.y - left.a.y;
      if (Math.abs(denominator) <= len1 * len2 * PARALLEL_EPSILON) {
        // Parallel. Only collinear pairs matter: split each against the
        // other's endpoints so a shared stretch becomes identical sub-edges.
        if (Math.abs(dx * r1y - dy * r1x) > len1 * span * COLLINEAR_EPSILON) {
          continue;
        }
        const project = (
          px: number,
          py: number,
          ox: number,
          oy: number,
          rx: number,
          ry: number,
          lengthSquared: number
        ): number => ((px - ox) * rx + (py - oy) * ry) / lengthSquared;
        const left2 = len1 * len1;
        const right2 = len2 * len2;
        if (left2 > 0) {
          for (const end of [right.a, right.b]) {
            const t = project(end.x, end.y, left.a.x, left.a.y, r1x, r1y, left2);
            if (t > 0 && t < 1) {
              left.splits.push(t);
            }
          }
        }
        if (right2 > 0) {
          for (const end of [left.a, left.b]) {
            const u = project(
              end.x,
              end.y,
              right.a.x,
              right.a.y,
              r2x,
              r2y,
              right2
            );
            if (u > 0 && u < 1) {
              right.splits.push(u);
            }
          }
        }
        continue;
      }
      const t = (dx * r2y - dy * r2x) / denominator;
      const u = (dx * r1y - dy * r1x) / denominator;
      if (t < 0 || t > 1 || u < 0 || u > 1) {
        continue;
      }
      left.splits.push(t);
      right.splits.push(u);
    }
  }

  const subEdges: SubEdge[] = [];
  for (const edge of edges) {
    const params = [0, ...edge.splits, 1].sort((a, b) => a - b);
    let previous = edge.a;
    let previousParam = 0;
    for (let k = 1; k < params.length; k += 1) {
      const param = params[k]!;
      if (param <= previousParam) {
        continue;
      }
      const next =
        param >= 1
          ? edge.b
          : registry.intern(
              edge.a.x + (edge.b.x - edge.a.x) * param,
              edge.a.y + (edge.b.y - edge.a.y) * param
            );
      previousParam = param;
      if (next === previous) {
        continue;
      }
      subEdges.push({ a: previous, b: next, used: false });
      previous = next;
    }
  }

  const kept: SubEdge[] = [];
  // Coincident sub-edges (two loops sharing a stretch of boundary) classify
  // identically, so the same directed piece can survive more than once. One
  // copy is the boundary; the rest would strand the trace at a branch.
  const seen = new Map<UnionPoint, Set<UnionPoint>>();
  for (const sub of subEdges) {
    const dx = sub.b.x - sub.a.x;
    const dy = sub.b.y - sub.a.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      continue;
    }
    const mx = (sub.a.x + sub.b.x) / 2;
    const my = (sub.a.y + sub.b.y) / 2;
    const nx = (-dy / length) * probe;
    const ny = (dx / length) * probe;
    const leftWinding = totalWinding(usable, mx + nx, my + ny);
    const rightWinding = totalWinding(usable, mx - nx, my - ny);
    if (leftWinding === 0 || rightWinding !== 0) {
      continue;
    }
    const targets = seen.get(sub.a);
    if (targets) {
      if (targets.has(sub.b)) {
        continue;
      }
      targets.add(sub.b);
    } else {
      seen.set(sub.a, new Set([sub.b]));
    }
    kept.push(sub);
  }
  if (kept.length === 0) {
    return [];
  }

  const outgoing = new Map<UnionPoint, SubEdge[]>();
  for (const sub of kept) {
    const bucket = outgoing.get(sub.a);
    if (bucket) {
      bucket.push(sub);
    } else {
      outgoing.set(sub.a, [sub]);
    }
  }

  const result: Float64Array[] = [];
  for (const seed of kept) {
    if (seed.used) {
      continue;
    }
    const start = seed.a;
    const points: UnionPoint[] = [start];
    let current = seed;
    current.used = true;
    let guard = kept.length + 1;
    while (guard-- > 0) {
      points.push(current.b);
      if (current.b === start) {
        break;
      }
      const candidates = (outgoing.get(current.b) ?? []).filter(
        (edge) => !edge.used
      );
      if (candidates.length === 0) {
        throw new TextGeometryError(
          'Overlap union produced an open boundary; the glyph outlines could ' +
            'not be merged. This usually means two outlines overlap exactly ' +
            'along a shared edge.'
        );
      }
      let next = candidates[0]!;
      if (candidates.length > 1) {
        const incoming = Math.atan2(
          current.a.y - current.b.y,
          current.a.x - current.b.x
        );
        let bestAngle = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
          const heading = Math.atan2(
            candidate.b.y - candidate.a.y,
            candidate.b.x - candidate.a.x
          );
          const clockwise = normalizeAngle(incoming - heading);
          const ranked = clockwise === 0 ? Math.PI * 2 : clockwise;
          if (ranked < bestAngle) {
            bestAngle = ranked;
            next = candidate;
          }
        }
      }
      next.used = true;
      current = next;
    }
    if (points[points.length - 1] !== start) {
      throw new TextGeometryError(
        'Overlap union did not close a boundary loop within the available edges.'
      );
    }
    points.pop();
    if (points.length < 3) {
      continue;
    }
    const flat = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i += 1) {
      flat[i * 2] = points[i]!.x;
      flat[i * 2 + 1] = points[i]!.y;
    }
    result.push(flat);
  }
  return result;
};
