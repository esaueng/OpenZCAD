import type { EdgeTopology } from '@openzcad/shared';
import type { SnapCandidate, Vec3 } from './SnapEngine';

/**
 * Snap candidates read off the exact topology the kernel already publishes.
 *
 * Everything here comes from an edge's display polyline, because that is what
 * the viewport is given: endpoints and midpoints of the edges, and the centre
 * of any edge that closes on itself, which is what puts a snap at the middle
 * of every hole and boss.
 *
 * The honest limit is the polyline. A straight edge is two points and its
 * midpoint is exact. A curved edge is sampled, so a midpoint on one is the
 * polyline's rather than the true curve's — but the sampling is finer than
 * this once claimed. At the app's display deflection a quarter fillet arc
 * arrives with 28 points, not as the single chord an earlier version of this
 * note described, so the error is a chord of about three degrees of arc rather
 * than a quarter turn. Endpoints are exact.
 *
 * There is a sharper limit worth naming, because it is invisible from the
 * data: a CLOSED edge's polyline does not begin at its vertex. The sampler
 * starts a quarter turn away, so a bore rim's first point is an arbitrary
 * point on the circle rather than the model vertex it looks like. That is why
 * `snapsFromEdges` offers a closed edge only its centre and no endpoints —
 * the skip below is load-bearing, not a simplification.
 */

function pointAt(points: number[], index: number): Vec3 {
  return {
    x: points[index * 3] ?? 0,
    y: points[index * 3 + 1] ?? 0,
    z: points[index * 3 + 2] ?? 0
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Tolerance for deciding an edge returns to where it started. */
const CLOSED_TOLERANCE = 1e-6;

/**
 * The point half the polyline's length along it.
 *
 * By length rather than by index, so an unevenly sampled curve does not put
 * its "midpoint" wherever the sampler happened to crowd its points.
 */
function midpointOf(points: number[], count: number): Vec3 | null {
  let total = 0;
  for (let index = 1; index < count; index += 1) {
    total += distance(pointAt(points, index - 1), pointAt(points, index));
  }
  if (total <= 0) {
    return null;
  }
  let travelled = 0;
  for (let index = 1; index < count; index += 1) {
    const from = pointAt(points, index - 1);
    const to = pointAt(points, index);
    const step = distance(from, to);
    if (travelled + step >= total / 2) {
      const along = step > 0 ? (total / 2 - travelled) / step : 0;
      return {
        x: from.x + (to.x - from.x) * along,
        y: from.y + (to.y - from.y) * along,
        z: from.z + (to.z - from.z) * along
      };
    }
    travelled += step;
  }
  return pointAt(points, count - 1);
}

/**
 * The centre of an edge that closes on itself.
 *
 * Averaging the samples is exact for a circle sampled at even angles and
 * close enough for anything else the kernel draws. An open edge has no centre
 * worth offering, so it gets none rather than a plausible wrong one.
 */
function closedCenterOf(points: number[], count: number): Vec3 | null {
  const first = pointAt(points, 0);
  const last = pointAt(points, count - 1);
  const closed = distance(first, last) <= CLOSED_TOLERANCE;
  // A closed edge drawn as a triangle is not a shape with a useful centre.
  if (!closed || count < 5) {
    return null;
  }
  let x = 0;
  let y = 0;
  let z = 0;
  // The repeated seam point would weight itself twice.
  const distinct = count - 1;
  for (let index = 0; index < distinct; index += 1) {
    const point = pointAt(points, index);
    x += point.x;
    y += point.y;
    z += point.z;
  }
  return { x: x / distinct, y: y / distinct, z: z / distinct };
}

export interface TopologySnapOptions {
  /** Kinds to offer; omit for all of them. */
  kinds?: readonly SnapCandidate['kind'][];
  label?: string;
}

/** Every snap candidate a body's edges provide. */
export function snapsFromEdges(
  edges: readonly EdgeTopology[],
  options: TopologySnapOptions = {}
): SnapCandidate[] {
  const wanted = options.kinds
    ? new Set<string>(options.kinds)
    : null;
  const allowed = (kind: SnapCandidate['kind']) => !wanted || wanted.has(kind);
  const candidates: SnapCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: SnapCandidate['kind'], point: Vec3) => {
    if (!allowed(kind)) {
      return;
    }
    // Edges meeting at a vertex each offer it; one glyph there, not three.
    const key = `${kind}:${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ kind, point, label: options.label });
  };

  for (const edge of edges) {
    if (edge.displayRole === 'seam') {
      continue;
    }
    const count = Math.floor(edge.points.length / 3);
    if (count < 2) {
      continue;
    }
    const center = closedCenterOf(edge.points, count);
    if (center) {
      // A closed edge has no ends to speak of, and its midpoint by length is
      // just the point opposite the seam — neither is a place anyone aims at.
      add('center', center);
      continue;
    }
    add('endpoint', pointAt(edge.points, 0));
    add('endpoint', pointAt(edge.points, count - 1));
    const middle = midpointOf(edge.points, count);
    if (middle) {
      add('midpoint', middle);
    }
  }
  return candidates;
}
